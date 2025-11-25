require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { OpenAI, toFile } = require('openai');
const { OpenAIRealtimeWS } = require('openai/realtime/ws');
const { v4: uuid } = require('uuid');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const MOCK_OPENAI = process.env.AII_MOCK_OPENAI === 'true';
const AUDIO_DEBUG = process.env.AII_AUDIO_DEBUG === 'true';
const DEFAULT_TRANSCRIPTION_MODEL =
  process.env.AII_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const ENABLE_TRANSCRIPT_POLISH = process.env.AII_ENABLE_TRANSCRIPT_POLISH !== 'false';
const TRANSCRIPTION_SAMPLE_RATE = Number(process.env.AII_TRANSCRIPTION_RATE || 24000);
const TRANSCRIPTION_CONTEXT_MS = Number(process.env.AII_TRANSCRIPTION_CONTEXT_MS || 3 * 60 * 1000);
const REALTIME_ENABLED = process.env.AII_REALTIME_ENABLED !== 'false';
const REALTIME_MODEL = process.env.AII_REALTIME_MODEL || 'gpt-4o-mini-realtime-preview';
const REALTIME_TRANSCRIBE_MODEL =
  process.env.AII_REALTIME_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIPTION_MODEL;
const REALTIME_VAD_THRESHOLD = Number(process.env.AII_REALTIME_VAD_THRESHOLD || 0.5);
const REALTIME_VAD_SILENCE_MS = Number(process.env.AII_REALTIME_VAD_SILENCE_MS || 1200);
const REALTIME_PREFIX_MS = Number(process.env.AII_REALTIME_PREFIX_MS || 300);
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});
const PORT = process.env.PORT || 4000;
const logEvent = (level, message, meta) => {
  const ts = new Date().toISOString();
  const payload = meta ? ` | ${JSON.stringify(meta)}` : '';
  const stream = level === 'error' ? console.error : console.log;
  stream(`[${ts}] [${level.toUpperCase()}] ${message}${payload}`);
};

const defaultConfig = {
  summarizationWindowMinutes: 5,
  transcriptWindowMinutes: 10,
  phase: 'Vision',
  languageMode: 'auto', // auto | arabic | english
  workshopType: 'NCIM Strategy Workshop',
  autoIntervalMinutes: 5,
  imageSize: '1024x1024',
  stylePreset: 'Flat, high-contrast illustration with simple shapes suitable for a strategy workshop slide.',
};

const makeRealtimeState = () => ({
  upstream: null,
  clients: new Set(),
  status: 'disconnected',
  lastMime: 'audio/webm',
});

let session = {
  active: false,
  apiKey: null,
  config: { ...defaultConfig },
  transcripts: [],
  images: [],
  lastSummary: null,
  lastPrompt: null,
  generationInProgress: false,
  pendingTrigger: false,
  lastError: null,
  realtime: makeRealtimeState(),
};

let realtimeWSS = null;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const LANGUAGE_MAP = {
  arabic: 'ar',
  english: 'en',
  auto: undefined,
};

const PHASES = ['Vision', 'Mission', 'Strategic objectives', 'KPIs', 'Other'];
const DIRECT_UPLOAD_EXTS = new Set(['webm', 'ogg', 'mp3', 'wav', 'm4a']);

const normalizeMime = (mimeType) =>
  (mimeType || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';

const mockImageB64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y3nKwAAAABJRU5ErkJggg==';

const sanitizeTranscript = (text) => {
  const cleaned = (text || '').trim();
  if (!cleaned) return '';
  const alphaCount = cleaned.replace(/[^A-Za-z\u0600-\u06FF]/g, '').length;
  const punctOnly = /^[\p{P}\p{S}]+$/u.test(cleaned);
  if (punctOnly) return '';
  if (cleaned.length < 3 && alphaCount < 2) return '';
  return cleaned;
};

const createMockClient = () => ({
  models: {
    list: async () => ({ data: [{ id: 'mock-model' }] }),
  },
  audio: {
    transcriptions: {
      create: async () => ({ text: 'mock transcript' }),
    },
  },
  chat: {
    completions: {
      create: async () => ({
        choices: [{ message: { content: 'mock summary or prompt' } }],
      }),
    },
  },
  images: {
    generate: async () => ({
      data: [{ b64_json: mockImageB64 }],
    }),
  },
});

const trimTranscripts = () => {
  const cutoff =
    Date.now() - session.config.transcriptWindowMinutes * 60 * 1000;
  session.transcripts = session.transcripts.filter(
    (entry) => entry.timestamp >= cutoff,
  );
};

const getRecentTranscriptText = () => {
  const cutoff =
    Date.now() - session.config.summarizationWindowMinutes * 60 * 1000;
  return session.transcripts
    .filter((entry) => entry.timestamp >= cutoff)
    .map((entry) => entry.text)
    .join(' ')
    .trim();
};

const getTranscriptionContextText = () => {
  const cutoff = Date.now() - TRANSCRIPTION_CONTEXT_MS;
  const text = session.transcripts
    .filter((entry) => entry.timestamp >= cutoff)
    .map((entry) => entry.text)
    .join(' ')
    .trim();
  // Keep context short to avoid bloating prompts
  return text.slice(-800);
};

const buildTranscriptionPrompt = () => {
  const vocab = [
    'NCIM',
    'National Center for Inspection and Monitoring',
    'KSA',
    'Vision 2030',
    'KPIs',
    'inspection',
    'monitoring',
    'governorates',
    'digital platform',
    'field inspectors',
    'compliance',
  ].join(', ');
  const context = getTranscriptionContextText();
  return [
    'Bilingual (Arabic + English) transcription for a live NCIM KSA strategy workshop.',
    `Workshop type: ${session.config.workshopType}. Phase: ${session.config.phase}.`,
    'Keep short acknowledgements like "yes", "ok", "تمام", "أيوه". Use clear sentence boundaries.',
    `Prefer these spellings/terms: ${vocab}.`,
    context ? `Recent context (for continuity): ${context}` : 'No recent context available.',
  ].join('\n');
};

const setSessionConfig = (updates = {}) => {
  session.config = { ...session.config, ...updates };
  if (!PHASES.includes(session.config.phase)) {
    session.config.phase = 'Vision';
  }
  if (!session.config.summarizationWindowMinutes) {
    session.config.summarizationWindowMinutes =
      defaultConfig.summarizationWindowMinutes;
  }
  if (!session.config.transcriptWindowMinutes) {
    session.config.transcriptWindowMinutes = defaultConfig.transcriptWindowMinutes;
  }
};

const broadcastRealtime = (payload) => {
  if (!session.realtime?.clients) return;
  for (const ws of session.realtime.clients) {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        logEvent('error', 'Realtime client send failed', { message: err.message });
      }
    }
  }
};

const teardownRealtime = (reason = 'session reset') => {
  if (session.realtime?.upstream) {
    try {
      session.realtime.upstream.close({ code: 1000, reason });
    } catch (err) {
      logEvent('error', 'Failed to close realtime upstream', { message: err.message });
    }
  }
  if (session.realtime?.clients) {
    for (const ws of session.realtime.clients) {
      try {
        ws.close(1000, reason);
      } catch (err) {
        // ignore
      }
    }
  }
  session.realtime = makeRealtimeState();
};

const resetSession = () => {
  teardownRealtime('session reset');
  session = {
    active: false,
    apiKey: null,
    config: { ...defaultConfig },
    transcripts: [],
    images: [],
    lastSummary: null,
    lastPrompt: null,
    generationInProgress: false,
    pendingTrigger: false,
    lastError: null,
    realtime: makeRealtimeState(),
  };
};

const getClient = () => {
  if (MOCK_OPENAI) {
    if (!getClient.mockInstance) {
      getClient.mockInstance = createMockClient();
    }
    return getClient.mockInstance;
  }
  const apiKey = session.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OpenAI API key');
  }
  return new OpenAI({ apiKey });
};

const maybePolishTranscript = async (text) => {
  const sanitized = sanitizeTranscript(text);
  if (!sanitized) return '';
  if (MOCK_OPENAI) return sanitized;
  if (!ENABLE_TRANSCRIPT_POLISH) return sanitized;
  try {
    const client = getClient();
    const context = getTranscriptionContextText();
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content:
            'Clean up a short live transcript segment. Add punctuation and casing, fix obvious tokenisation issues, keep the original language (Arabic or English), and do not invent content.',
        },
        {
          role: 'user',
          content: `Recent context: ${context || 'n/a'}\nRaw segment:\n${sanitized}\n\nReturn only the cleaned segment.`,
        },
      ],
    });
    const polished = response.choices?.[0]?.message?.content?.trim();
    return sanitizeTranscript(polished || sanitized);
  } catch (error) {
    logEvent('error', 'Transcript polish failed', { message: error.message });
    return sanitized;
  }
};

const buildRealtimeSessionConfig = () => ({
  type: 'realtime',
  modalities: ['text'],
  input_audio_format: 'pcm16',
  input_audio_noise_reduction: { type: 'far_field' },
  input_audio_transcription: {
    model: REALTIME_TRANSCRIBE_MODEL,
    language: LANGUAGE_MAP[session.config.languageMode],
    prompt: buildTranscriptionPrompt(),
  },
  turn_detection: {
    type: 'server_vad',
    threshold: REALTIME_VAD_THRESHOLD,
    silence_duration_ms: REALTIME_VAD_SILENCE_MS,
    prefix_padding_ms: REALTIME_PREFIX_MS,
    create_response: false,
  },
});

const handleRealtimeTranscript = async (rawText, itemId) => {
  const text = await maybePolishTranscript(rawText);
  if (!text) return;
  const entry = { text, timestamp: Date.now(), itemId };
  session.transcripts.push(entry);
  trimTranscripts();
  broadcastRealtime({ type: 'transcript_final', text, itemId, timestamp: entry.timestamp });
  logEvent('info', 'Realtime transcript received', { length: text.length, itemId });
};

const handleRealtimeEvent = async (event) => {
  switch (event.type) {
    case 'session.created':
      logEvent('info', 'Realtime session created', { expiresAt: event.session?.expires_at });
      break;
    case 'session.updated':
      logEvent('info', 'Realtime session updated', { inputFormat: event.session?.audio?.input?.format });
      break;
    case 'conversation.item.input_audio_transcription.delta':
      if (event.delta) {
        broadcastRealtime({
          type: 'transcript_delta',
          itemId: event.item_id,
          delta: event.delta,
          contentIndex: event.content_index,
        });
      }
      break;
    case 'conversation.item.input_audio_transcription.segment':
      if (event.text) {
        broadcastRealtime({
          type: 'transcript_segment',
          itemId: event.item_id,
          text: event.text,
          start: event.start,
          end: event.end,
        });
      }
      break;
    case 'conversation.item.input_audio_transcription.completed':
      await handleRealtimeTranscript(event.transcript, event.item_id);
      break;
    case 'conversation.item.input_audio_transcription.failed':
      broadcastRealtime({ type: 'transcript_error', message: event.error?.message || 'Transcription failed' });
      logEvent('error', 'Realtime transcription failed', {
        message: event.error?.message,
        code: event.error?.code,
      });
      break;
    default:
      break;
  }
};

const ensureRealtimeUpstream = async () => {
  if (!REALTIME_ENABLED || MOCK_OPENAI) return null;
  if (session.realtime.upstream) return session.realtime.upstream;
  const client = getClient();
  session.realtime.status = 'connecting';
  const rt = await OpenAIRealtimeWS.create(client, { model: REALTIME_MODEL });
  const awaitOpen = () =>
    new Promise((resolve) => {
      if (rt.socket.readyState === rt.socket.OPEN) return resolve();
      rt.socket.once('open', () => resolve());
    });
  await awaitOpen();
  rt.on('error', (err) => {
    logEvent('error', 'Realtime upstream error', { message: err.message });
  });
  rt.on('event', (evt) => {
    Promise.resolve(handleRealtimeEvent(evt)).catch((err) => {
      logEvent('error', 'Realtime event handler failed', { message: err.message });
    });
  });
  session.realtime.upstream = rt;
  session.realtime.status = 'connected';
  rt.send({ type: 'session.update', session: buildRealtimeSessionConfig() });
  logEvent('info', 'Realtime upstream connected', {
    model: REALTIME_MODEL,
    transcribeModel: REALTIME_TRANSCRIBE_MODEL,
  });
  return rt;
};

const refreshRealtimeSessionConfig = async () => {
  if (!session.realtime.upstream) return;
  try {
    session.realtime.upstream.send({ type: 'session.update', session: buildRealtimeSessionConfig() });
  } catch (err) {
    logEvent('error', 'Failed to refresh realtime session config', { message: err.message });
  }
};

const transcodeToPCM = (buffer, mimeType) =>
  new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg not available'));
    const normalizedMime = normalizeMime(mimeType);
    const inputFormatFlags = [];
    if (normalizedMime.includes('webm')) {
      inputFormatFlags.push('-f', 'webm');
    } else if (normalizedMime.includes('ogg')) {
      inputFormatFlags.push('-f', 'ogg');
    } else if (normalizedMime.includes('mp3')) {
      inputFormatFlags.push('-f', 'mp3');
    }
    const proc = spawn(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+discardcorrupt',
      '-err_detect',
      'ignore_err',
      ...inputFormatFlags,
      '-i',
      'pipe:0',
      '-ac',
      '1',
      '-ar',
      String(TRANSCRIPTION_SAMPLE_RATE),
      '-f',
      's16le',
      'pipe:1',
    ]);
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exit ${code}: ${stderr}`));
      }
    });
    proc.stdin.write(buffer);
    proc.stdin.end();
  });

const pipeAudioToRealtime = async (buffer, mimeType = 'audio/webm') => {
  if (!REALTIME_ENABLED || MOCK_OPENAI) return;
  try {
    const pcm = await transcodeToPCM(buffer, mimeType);
    const rt = await ensureRealtimeUpstream();
    if (!rt) return;
    rt.send({
      type: 'input_audio_buffer.append',
      audio: pcm.toString('base64'),
    });
  } catch (err) {
    session.realtime.status = 'error';
    logEvent('error', 'Realtime audio append failed', {
      message: err.message,
      mime: mimeType,
      bytes: buffer?.length,
      head: buffer?.subarray?.(0, 16)?.toString('hex'),
    });
  }
};

const mimeToExt = (mime) => {
  const normalized = (mime || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'audio/webm') return 'webm';
  if (normalized === 'audio/ogg' || normalized === 'audio/oga') return 'ogg';
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3' || normalized === 'audio/mpga') return 'mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav';
  if (normalized === 'audio/mp4' || normalized === 'audio/m4a') return 'm4a';
  return 'tmp';
};

const transcribeAudio = async (buffer, mimeType) => {
  const client = getClient();
  const ext = mimeToExt(mimeType);
  const normalizedMime = normalizeMime(mimeType);
  const resolvedExt = ext === 'tmp' ? 'webm' : ext;
  const effectiveMime =
    normalizedMime && normalizedMime.startsWith('audio/')
      ? normalizedMime
      : `audio/${resolvedExt || 'webm'}`;

  const convertToWav = () =>
    new Promise((resolve, reject) => {
      if (!ffmpegPath) return reject(new Error('ffmpeg not available'));
      const proc = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-map_metadata',
        '-1',
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(TRANSCRIPTION_SAMPLE_RATE),
        '-f',
        'wav',
        'pipe:1',
      ]);
      const chunks = [];
      let stderr = '';
      proc.stdout.on('data', (d) => chunks.push(d));
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`ffmpeg exit ${code}: ${stderr}`));
        }
      });
      proc.stdin.write(buffer);
      proc.stdin.end();
    });

  const callTranscriptionModel = async (file) => {
    const response = await client.audio.transcriptions.create({
      file,
      model: DEFAULT_TRANSCRIPTION_MODEL,
      language: LANGUAGE_MAP[session.config.languageMode],
      temperature: 0,
      prompt: buildTranscriptionPrompt(),
    });
    return response.text?.trim() || '';
  };

  const logSignature = () => {
    if (!AUDIO_DEBUG) return;
    const head = buffer.subarray(0, 16).toString('hex');
    logEvent('info', 'Audio buffer signature', { head, size: buffer.length, mime: normalizedMime });
  };

  logSignature();
  let lastError;

  // 1) Direct upload for supported containers
  if (DIRECT_UPLOAD_EXTS.has(resolvedExt)) {
    try {
      const file = await toFile(buffer, `audio.${resolvedExt}`, {
        contentType: effectiveMime,
      });
      const raw = await callTranscriptionModel(file);
      return maybePolishTranscript(raw);
    } catch (err) {
      lastError = err;
      logEvent('error', 'Direct transcription failed, retrying with WAV', {
        message: err.message,
        inputMime: normalizedMime,
        inputExt: resolvedExt,
      });
    }
  }

  // 2) Force WAV transcode and retry
  let wavBuffer = buffer;
  let targetExt = 'wav';
  let targetMime = 'audio/wav';
  try {
    wavBuffer = await convertToWav();
    logEvent('info', 'Audio converted to wav for transcription', {
      inputMime: normalizedMime,
      inputExt: resolvedExt,
      wavBytes: wavBuffer.length,
      sampleRate: TRANSCRIPTION_SAMPLE_RATE,
    });
  } catch (err) {
    lastError = err;
    targetExt = resolvedExt || 'bin';
    targetMime = effectiveMime;
    logEvent('error', 'Audio conversion failed, falling back to original buffer', {
      message: err.message,
      inputMime: normalizedMime,
      inputExt: resolvedExt,
    });
  }

  try {
    const file = await toFile(wavBuffer, `audio.${targetExt}`, {
      contentType: targetMime,
    });
    const raw = await callTranscriptionModel(file);
    return maybePolishTranscript(raw);
  } catch (err) {
    lastError = err;
    logEvent('error', 'WAV transcription retry failed', {
      message: err.message,
      inputMime: normalizedMime,
      inputExt: resolvedExt,
    });
  }

  throw lastError || new Error('Transcription failed');
};

const summariseTranscript = async (transcriptText) => {
  const client = getClient();
  const phase = session.config.phase;
  const prompt = [
    {
      role: 'system',
      content:
        'You are assisting a live NCIM KSA strategy workshop. Summarise recent conversation into concise English bullet points suitable for an image prompt. Avoid names or sensitive data.',
    },
    {
      role: 'user',
      content: `Workshop phase: ${phase}.\nWorkshop type: ${session.config.workshopType}.\nTranscript (last ${session.config.summarizationWindowMinutes} minutes):\n${transcriptText}\n\nReturn 3-6 crisp bullet points (max 180 words total).`,
    },
  ];
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: prompt,
    temperature: 0.4,
  });
  return response.choices[0].message.content.trim();
};

const createImagePrompt = async (summaryText) => {
  const client = getClient();
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
          'Turn the provided workshop summary into a vivid, projector-friendly illustration prompt. Use English even if the summary is Arabic. Keep it concise (max 90 words). Avoid text inside the image and avoid realistic faces.',
      },
      {
        role: 'user',
        content: `Workshop phase: ${session.config.phase}.\nStyle preset: ${session.config.stylePreset}.\nSummary bullets:\n${summaryText}\nCreate one illustration prompt.`,
      },
    ],
  });
  return response.choices[0].message.content.trim();
};

const generateImage = async (prompt) => {
  const client = getClient();
  const response = await client.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: session.config.imageSize || '1024x1024',
  });
  const base64 = response.data?.[0]?.b64_json;
  if (!base64) {
    throw new Error('No image data returned from OpenAI');
  }
  return `data:image/png;base64,${base64}`;
};

app.post('/api/ping', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) {
    return res.status(400).json({ error: 'API key is required' });
  }
  try {
    const client = new OpenAI({ apiKey });
    const models = await client.models.list();
    const firstModel = models.data?.[0]?.id || 'ok';
    logEvent('info', 'Ping success', { model: firstModel });
    res.json({ ok: true, model: firstModel });
  } catch (error) {
    logEvent('error', 'Ping failed', { message: error.message });
    res.status(400).json({ error: 'Unable to validate API key', details: error.message });
  }
});

app.post('/api/session/start', async (req, res) => {
  const { apiKey, languageMode, workshopType, summarizationWindowMinutes, imageSize, stylePreset, phase } = req.body || {};
  if (!apiKey && !process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'API key is required to start a session' });
  }

  resetSession();
  session.active = true;
  session.apiKey = apiKey || process.env.OPENAI_API_KEY;
  setSessionConfig({
    languageMode: languageMode || defaultConfig.languageMode,
    workshopType: workshopType || defaultConfig.workshopType,
    summarizationWindowMinutes:
      summarizationWindowMinutes || defaultConfig.summarizationWindowMinutes,
    transcriptWindowMinutes: defaultConfig.transcriptWindowMinutes,
    imageSize: imageSize || defaultConfig.imageSize,
    stylePreset: stylePreset || defaultConfig.stylePreset,
    phase: phase || defaultConfig.phase,
  });

  logEvent('info', 'Session started', {
    languageMode: session.config.languageMode,
    workshopType: session.config.workshopType,
    imageSize: session.config.imageSize,
    stylePreset: session.config.stylePreset,
    phase: session.config.phase,
    transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    transcriptionRate: TRANSCRIPTION_SAMPLE_RATE,
  });
  if (REALTIME_ENABLED && !MOCK_OPENAI) {
    ensureRealtimeUpstream()
      .then(() => refreshRealtimeSessionConfig())
      .catch((err) => {
        session.realtime.status = 'error';
        logEvent('error', 'Realtime upstream init failed', { message: err.message });
      });
  }
  res.json({ ok: true, config: session.config });
});

app.post('/api/session/end', (req, res) => {
  resetSession();
  logEvent('info', 'Session ended');
  res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
  if (!session.active) {
    return res.status(400).json({ error: 'No active session' });
  }
  const { phase, autoIntervalMinutes, imageSize, stylePreset, summarizationWindowMinutes } = req.body || {};
  setSessionConfig({
    phase: phase || session.config.phase,
    autoIntervalMinutes: autoIntervalMinutes || session.config.autoIntervalMinutes,
    imageSize: imageSize || session.config.imageSize,
    stylePreset: stylePreset || session.config.stylePreset,
    summarizationWindowMinutes:
      summarizationWindowMinutes || session.config.summarizationWindowMinutes,
    transcriptWindowMinutes: session.config.transcriptWindowMinutes,
  });
  logEvent('info', 'Config updated', {
    phase: session.config.phase,
    autoIntervalMinutes: session.config.autoIntervalMinutes,
    imageSize: session.config.imageSize,
    stylePreset: session.config.stylePreset,
  });
  refreshRealtimeSessionConfig().catch((err) => {
    logEvent('error', 'Realtime config refresh failed', { message: err.message });
  });
  res.json({ ok: true, config: session.config });
});

app.post('/api/audio', upload.single('audio'), async (req, res) => {
  if (!session.active) {
    return res.status(400).json({ error: 'No active session' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file received' });
  }
  if (!req.file.buffer || req.file.size < 1024) {
    logEvent('error', 'Transcription skipped - tiny/empty chunk', {
      size: req.file.size,
      mime: req.file.mimetype,
    });
    return res.status(400).json({ error: 'Audio chunk too small', details: 'No usable audio captured' });
  }
  try {
    const text = await transcribeAudio(req.file.buffer, req.file.mimetype);
    if (text) {
      session.transcripts.push({ text, timestamp: Date.now() });
      trimTranscripts();
      logEvent('info', 'Transcript received', {
        length: text.length,
        mime: req.file.mimetype,
        size: req.file.size,
      });
    }
    res.json({ text });
  } catch (error) {
    session.lastError = error.message;
    logEvent('error', 'Transcription failed', {
      message: error.message,
      mime: req.file.mimetype,
      size: req.file.size,
      note: 'If repeated, inspect browser mime and consider trying OGG fallback',
    });
    res.status(500).json({
      error: 'Transcription failed',
      details: error.message,
      code: 'TRANSCRIPTION_ERROR',
    });
  }
});

const runGeneration = async () => {
  if (!session.active) {
    throw new Error('No active session');
  }
  const transcript = getRecentTranscriptText();
  if (!transcript) {
    throw new Error('Not enough transcript to generate');
  }
  const summary = await summariseTranscript(transcript);
  session.lastSummary = { text: summary, timestamp: Date.now(), phase: session.config.phase };
  const prompt = await createImagePrompt(summary);
  session.lastPrompt = prompt;
  const image = await generateImage(prompt);
  const item = {
    id: uuid(),
    prompt,
    summary,
    phase: session.config.phase,
    createdAt: new Date().toISOString(),
    size: session.config.imageSize,
    pinned: false,
    deleted: false,
    url: image,
  };
  session.images.unshift(item);
  if (session.images.length > 20) {
    session.images = session.images.slice(0, 20);
  }
  logEvent('info', 'Image generated', {
    id: item.id,
    phase: item.phase,
    size: item.size,
    summaryLength: summary.length,
    promptLength: prompt.length,
  });
  return item;
};

app.post('/api/generate', async (req, res) => {
  if (!session.active) {
    return res.status(400).json({ error: 'No active session' });
  }
  if (session.generationInProgress) {
    session.pendingTrigger = true;
    logEvent('info', 'Generation queued while in progress');
    return res.json({ queued: true, message: 'Generation already in progress; queued next run.' });
  }
  session.generationInProgress = true;
  session.lastError = null;
  try {
    const item = await runGeneration();
    res.json({ ok: true, image: item });
  } catch (error) {
    session.lastError = error.message;
    logEvent('error', 'Generation failed', { message: error.message });
    res.status(400).json({ error: error.message });
  } finally {
    session.generationInProgress = false;
    if (session.pendingTrigger) {
      session.pendingTrigger = false;
      runGeneration().catch((err) => {
        session.lastError = err.message;
        logEvent('error', 'Queued generation failed', { message: err.message });
      });
    }
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    sessionActive: session.active,
    config: session.config,
    lastSummary: session.lastSummary,
    generationInProgress: session.generationInProgress,
    pendingTrigger: session.pendingTrigger,
    lastError: session.lastError,
    transcripts: session.transcripts.slice(-50),
    images: session.images.filter((img) => !img.deleted),
    realtime: {
      enabled: REALTIME_ENABLED && !MOCK_OPENAI,
      status: session.realtime.status,
      model: REALTIME_MODEL,
      transcribeModel: REALTIME_TRANSCRIBE_MODEL,
    },
  });
});

app.patch('/api/images/:id', (req, res) => {
  const { id } = req.params;
  const { pinned } = req.body || {};
  const image = session.images.find((img) => img.id === id);
  if (!image) {
    return res.status(404).json({ error: 'Image not found' });
  }
  if (typeof pinned === 'boolean') {
    image.pinned = pinned;
  }
  res.json({ ok: true, image });
});

app.delete('/api/images/:id', (req, res) => {
  const { id } = req.params;
  const image = session.images.find((img) => img.id === id);
  if (!image) {
    return res.status(404).json({ error: 'Image not found' });
  }
  image.deleted = true;
  res.json({ ok: true });
});

app.post('/api/export', (req, res) => {
  if (!session.active && session.images.length === 0) {
    return res.status(400).json({ error: 'Nothing to export' });
  }
  const now = new Date();
  const lines = [];
  lines.push(`# NCIM AI Illustrator session`);
  lines.push(`Date: ${now.toISOString()}`);
  lines.push(`Workshop type: ${session.config.workshopType}`);
  lines.push(`Phases used: ${Array.from(new Set(session.images.map((img) => img.phase))).join(', ')}`);
  lines.push('');
  lines.push('## Prompts');
  session.images.forEach((img, idx) => {
    lines.push(`${idx + 1}. [${img.createdAt}] (${img.phase})`);
    lines.push(`Prompt: ${img.prompt}`);
    lines.push('');
  });
  if (session.lastSummary) {
    lines.push('## Last summary');
    lines.push(session.lastSummary.text);
  }
  const content = lines.join('\n');
  res.setHeader('Content-Disposition', 'attachment; filename="session-summary.md"');
  res.setHeader('Content-Type', 'text/markdown');
  res.send(content);
});

const setupRealtimeGateway = (server) => {
  realtimeWSS = new WebSocketServer({ server, path: '/ws/audio' });
  realtimeWSS.on('connection', (ws) => {
    let transcoder = null;
    let passthroughPcm = false;
    const startTranscoder = (mime = 'audio/webm') => {
      if (transcoder) return transcoder;
      if (!ffmpegPath) {
        ws.send(JSON.stringify({ type: 'error', message: 'ffmpeg not available' }));
        return null;
      }
      const normalizedMime = normalizeMime(mime);
      const inputFormatFlags = [];
      if (normalizedMime.includes('webm')) inputFormatFlags.push('-f', 'webm');
      else if (normalizedMime.includes('ogg')) inputFormatFlags.push('-f', 'ogg');
      else if (normalizedMime.includes('mp3')) inputFormatFlags.push('-f', 'mp3');

      const proc = spawn(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-fflags',
        '+discardcorrupt',
        '-err_detect',
        'ignore_err',
        ...inputFormatFlags,
        '-i',
        'pipe:0',
        '-ac',
        '1',
        '-ar',
        String(TRANSCRIPTION_SAMPLE_RATE),
        '-f',
        's16le',
        'pipe:1',
      ]);

      proc.stdout.on('data', async (chunk) => {
        const rt = await ensureRealtimeUpstream();
        if (!rt) return;
        rt.send({
          type: 'input_audio_buffer.append',
          audio: Buffer.from(chunk).toString('base64'),
        });
      });

      proc.stderr.on('data', (d) => {
        logEvent('error', 'Realtime ffmpeg stderr', { message: d.toString() });
      });

      proc.on('close', (code) => {
        logEvent('info', 'Realtime ffmpeg closed', { code });
        transcoder = null;
      });

      transcoder = proc;
      return transcoder;
    };

    if (!session.active) {
      ws.close(1013, 'No active session');
      return;
    }
    if (!REALTIME_ENABLED || MOCK_OPENAI) {
      ws.close(1013, 'Realtime disabled');
      return;
    }
    session.realtime.clients.add(ws);
    session.realtime.status = 'client_connected';
    ws.send(
      JSON.stringify({
        type: 'ready',
        model: REALTIME_MODEL,
        transcribeModel: REALTIME_TRANSCRIBE_MODEL,
        sampleRate: TRANSCRIPTION_SAMPLE_RATE,
      }),
    );

    ws.on('message', async (data, isBinary) => {
      if (!session.active) {
        ws.send(JSON.stringify({ type: 'error', message: 'No active session' }));
        return;
      }
      if (!REALTIME_ENABLED) {
        ws.send(JSON.stringify({ type: 'error', message: 'Realtime disabled' }));
        return;
      }
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'start') {
            session.realtime.lastMime = msg.mime || session.realtime.lastMime;
            passthroughPcm = msg.format === 'pcm16';
            ws.send(JSON.stringify({ type: 'ack', message: 'start' }));
            ensureRealtimeUpstream().catch((err) =>
              logEvent('error', 'Realtime upstream init failed (ws)', { message: err.message }),
            );
          } else if (msg.type === 'commit') {
            const rt = await ensureRealtimeUpstream();
            rt?.send({ type: 'input_audio_buffer.commit' });
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid control message' }));
        }
        return;
      }

      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!chunk || chunk.length === 0) return;
      if (passthroughPcm) {
        const rt = await ensureRealtimeUpstream();
        if (!rt) return;
        rt.send({
          type: 'input_audio_buffer.append',
          audio: chunk.toString('base64'),
        });
        return;
      }
      const proc = startTranscoder(session.realtime.lastMime);
      if (!proc) return;
      proc.stdin.write(chunk);
    });

    const cleanup = () => {
      session.realtime.clients.delete(ws);
      if (transcoder) {
        try {
          transcoder.stdin.end();
          transcoder.kill('SIGTERM');
        } catch (e) {
          // ignore
        }
        transcoder = null;
      }
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
  logEvent('info', 'Realtime websocket gateway ready', { path: '/ws/audio' });
  return realtimeWSS;
};

process.on('unhandledRejection', (reason) => {
  logEvent('error', 'Unhandled promise rejection', { reason });
});

process.on('uncaughtException', (error) => {
  logEvent('error', 'Uncaught exception', { message: error.message });
});

if (require.main === module) {
  const server = http.createServer(app);
  setupRealtimeGateway(server);
  server.listen(PORT, () => {
    console.log(`AI Illustrator backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
