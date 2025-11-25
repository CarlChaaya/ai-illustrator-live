require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { OpenAI, toFile } = require('openai');
const { v4: uuid } = require('uuid');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const MOCK_OPENAI = process.env.AII_MOCK_OPENAI === 'true';
const AUDIO_DEBUG = process.env.AII_AUDIO_DEBUG === 'true';
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
};

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
  const words = cleaned.split(/\s+/).filter(Boolean);
  const alphaCount = cleaned.replace(/[^A-Za-z\u0600-\u06FF]/g, '').length;
  const punctOnly = /^[\p{P}\p{S}]+$/u.test(cleaned);
  if (punctOnly) return '';
  if (words.length < 2 && cleaned.length < 12) return '';
  if (alphaCount < 2) return '';
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

const resetSession = () => {
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
        '16000',
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

  const callWhisper = async (file) => {
    const response = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: LANGUAGE_MAP[session.config.languageMode],
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
      const raw = await callWhisper(file);
      return sanitizeTranscript(raw);
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
    logEvent('info', 'Audio converted to wav for whisper', {
      inputMime: normalizedMime,
      inputExt: resolvedExt,
      wavBytes: wavBuffer.length,
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
    const raw = await callWhisper(file);
    return sanitizeTranscript(raw);
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

app.post('/api/session/start', (req, res) => {
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
  });
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

process.on('unhandledRejection', (reason) => {
  logEvent('error', 'Unhandled promise rejection', { reason });
});

process.on('uncaughtException', (error) => {
  logEvent('error', 'Uncaught exception', { message: error.message });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI Illustrator backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
