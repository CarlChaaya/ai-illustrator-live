import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

type TranscriptEntry = {
  text: string;
  timestamp: number;
};

type ImageItem = {
  id: string;
  prompt: string;
  summary: string;
  phase: string;
  createdAt: string;
  size: string;
  pinned: boolean;
  deleted: boolean;
  url: string;
};

type Summary = {
  text: string;
  timestamp: number;
  phase: string;
};

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';
const PHASES = ['Vision', 'Mission', 'Strategic objectives', 'KPIs', 'Other'];
const INTERVAL_OPTIONS = [3, 5, 10];
const SIZE_OPTIONS = ['1024x1024', '1792x1024'];
const STYLE_PRESETS = [
  'Flat, high-contrast illustration with bold shapes and minimal detail.',
  'Minimal line art with soft gradients and clean iconography.',
  'Semi-realistic workshop sketch with warm lighting and simplified faces.',
];
const CHUNK_DURATION_MS = 2000; // slightly longer slices for stable container boundaries
const MIN_SPEECH_FRAMES = 6; // require multiple frames above threshold before dropping a chunk
const SILENCE_RMS_THRESHOLD = 0.0015; // more sensitive than the previous 0.003 default
const WS_BASE = (API_BASE || '').replace(/^http/, 'ws');

const formatClock = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const formatTranscriptTime = (ts: number) => {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const bulletsFromSummary = (text?: string) => {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean);
};

const classNames = (...items: (string | undefined | false)[]) => items.filter(Boolean).join(' ');

function App() {
  const [apiKey, setApiKey] = useState('');
  const [saveKey, setSaveKey] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const [languageMode, setLanguageMode] = useState<'auto' | 'arabic' | 'english'>('auto');
  const [workshopType, setWorkshopType] = useState('NCIM Strategy Workshop');
  const [phase, setPhase] = useState(PHASES[0]);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoInterval, setAutoInterval] = useState<number>(5);
  const [imageSize, setImageSize] = useState<string>(SIZE_OPTIONS[0]);
  const [stylePreset, setStylePreset] = useState<string>(STYLE_PRESETS[0]);
  const [images, setImages] = useState<ImageItem[]>([]);
  const [viewMode, setViewMode] = useState<'latest' | 'gallery'>('latest');
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);
  const [lastSummary, setLastSummary] = useState<Summary | null>(null);
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [error, setError] = useState<string | null>(null);
  const [generationInProgress, setGenerationInProgress] = useState(false);
  const [pendingQueued, setPendingQueued] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectivityOk, setConnectivityOk] = useState<boolean | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [transcriptionPaused, setTranscriptionPaused] = useState(false);
  const [skipSilence, setSkipSilence] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [connectionNote, setConnectionNote] = useState('');
  const [realtimeStatus, setRealtimeStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [partialTranscript, setPartialTranscript] = useState('');

  const audioStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const chunkHasSpeechRef = useRef(false);
  const speechFrameCountRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const partialMapRef = useRef<Map<string, string>>(new Map());

  const closeRealtimeSocket = () => {
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch (e) {
        // ignore
      }
    }
    wsRef.current = null;
    partialMapRef.current.clear();
    setPartialTranscript('');
    setRealtimeStatus('idle');
  };

  const handleRealtimeMessage = async (event: MessageEvent) => {
    try {
      const raw =
        typeof event.data === 'string'
          ? event.data
          : event.data instanceof Blob
          ? await event.data.text()
          : new TextDecoder().decode(event.data as ArrayBuffer);
      const msg = JSON.parse(raw);
      if (msg.type === 'ready' || msg.type === 'ack') {
        setRealtimeStatus('connected');
        setStatusMessage('Realtime ready');
      } else if (msg.type === 'transcript_delta') {
        const prev = partialMapRef.current.get(msg.itemId) || '';
        const next = (prev + (msg.delta || '')).slice(-400);
        partialMapRef.current.set(msg.itemId, next);
        setPartialTranscript(next);
      } else if (msg.type === 'transcript_final') {
        partialMapRef.current.delete(msg.itemId);
        setPartialTranscript('');
        if (msg.text) {
          addTranscript(msg.text, msg.timestamp || Date.now());
        }
      } else if (msg.type === 'transcript_error' || msg.type === 'error') {
        setError(msg.message || 'Realtime error');
        setRealtimeStatus('error');
      }
    } catch (e) {
      // ignore malformed messages
    }
  };

  const openRealtimeSocket = (preferredMime: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return wsRef.current;
    }
    const ws = new WebSocket(`${WS_BASE}/ws/audio`);
    wsRef.current = ws;
    setRealtimeStatus('connecting');
    ws.addEventListener('message', (event) => {
      handleRealtimeMessage(event);
    });
    ws.addEventListener('open', () => {
      setRealtimeStatus('connected');
      ws.send(JSON.stringify({ type: 'start', mime: preferredMime, chunkMs: CHUNK_DURATION_MS }));
    });
    ws.addEventListener('error', () => {
      setRealtimeStatus('error');
      setStatusMessage('Realtime error');
    });
    ws.addEventListener('close', () => {
      setRealtimeStatus('idle');
      partialMapRef.current.clear();
      setPartialTranscript('');
    });
    return ws;
  };

  const pickMimeType = () => {
    const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  };

  useEffect(() => {
    const stored = localStorage.getItem('aii_api_key');
    if (stored) {
      setApiKey(stored);
      setSaveKey(true);
    }
  }, []);

  useEffect(() => {
    if (!sessionActive || !autoEnabled) return;
    const id = setInterval(() => {
      triggerGenerate(true);
    }, autoInterval * 60 * 1000);
    return () => clearInterval(id);
  }, [sessionActive, autoEnabled, autoInterval, phase]);

  useEffect(() => {
    if (!sessionActive) return;
    const fetchStatus = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/status`);
        if (!res.ok) return;
        const data = await res.json();
        setImages(data.images || []);
        setTranscripts(data.transcripts || []);
        if (data.lastSummary) {
          setLastSummary(data.lastSummary);
        }
        setGenerationInProgress(data.generationInProgress);
        setPendingQueued(data.pendingTrigger);
        if (data.config) {
          setPhase(data.config.phase);
          setAutoInterval(data.config.autoIntervalMinutes);
          setImageSize(data.config.imageSize);
          setStylePreset(data.config.stylePreset);
        }
        if (data.realtime?.status) {
          const mapped =
            data.realtime.status === 'connected' || data.realtime.status === 'client_connected'
              ? 'connected'
              : data.realtime.status === 'connecting'
              ? 'connecting'
              : data.realtime.status === 'error'
              ? 'error'
              : 'idle';
          setRealtimeStatus(mapped);
        }
      } catch (e) {
        // ignore periodic errors
      }
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 12000);
    return () => clearInterval(id);
  }, [sessionActive]);

  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, []);

  useEffect(() => {
    if (!sessionActive) return;
    const id = setTimeout(() => {
      fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase,
          autoIntervalMinutes: autoInterval,
          imageSize,
          stylePreset,
        }),
      }).catch(() => {
        /* ignore background errors */
      });
    }, 200);
    return () => clearTimeout(id);
  }, [sessionActive, phase, autoInterval, imageSize, stylePreset]);

  const addTranscript = (text: string, timestamp = Date.now()) => {
    setTranscripts((prev) => [...prev, { text, timestamp }].slice(-400));
  };

  const startAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;
      const preferredMime = pickMimeType();
      const audioCtx = new AudioContext({ sampleRate: 24000 });
      await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(dataArray);
        const normalized = dataArray.map((v) => (v - 128) / 128);
        const rms = Math.sqrt(normalized.reduce((acc, val) => acc + val * val, 0) / normalized.length);
        if (rms >= SILENCE_RMS_THRESHOLD) {
          chunkHasSpeechRef.current = true;
          speechFrameCountRef.current += 1;
        }
        setAudioLevel(Math.min(1, rms * 4));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      openRealtimeSocket(preferredMime);
      const resetChunkMeters = () => {
        chunkHasSpeechRef.current = false;
        speechFrameCountRef.current = 0;
      };

      const sendPcm = (pcm: ArrayBuffer) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(pcm);
        setStatusMessage('Streaming audio');
      };

      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;
      source.connect(processor);
      processor.connect(audioCtx.destination);
      processor.onaudioprocess = (event) => {
        if (transcriptionPaused) return;
        const input = event.inputBuffer.getChannelData(0);
        const rms =
          Math.sqrt(input.reduce((acc, sample) => acc + sample * sample, 0) / input.length) || 0;
        if (rms >= SILENCE_RMS_THRESHOLD) {
          chunkHasSpeechRef.current = true;
          speechFrameCountRef.current += 1;
        }
        if (
          skipSilence &&
          (!chunkHasSpeechRef.current || speechFrameCountRef.current < MIN_SPEECH_FRAMES)
        ) {
          return;
        }
        const int16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i += 1) {
          const s = Math.max(-1, Math.min(1, input[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        sendPcm(int16.buffer);
        resetChunkMeters();
      };

      setStatusMessage(`Listening (realtime PCM)${preferredMime ? ` (${preferredMime})` : ''}`);
    } catch (err: any) {
      setError('Microphone permission denied or unavailable');
      setStatusMessage('Microphone unavailable');
    }
  };

  const stopAudio = () => {
    analyserRef.current?.disconnect();
    processorRef.current?.disconnect();
    processorRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioStreamRef.current = null;
    setAudioLevel(0);
    closeRealtimeSocket();
  };

  const toggleTranscription = async () => {
    if (transcriptionPaused) {
      setTranscriptionPaused(false);
      await startAudio();
    } else {
      setTranscriptionPaused(true);
      stopAudio();
      setStatusMessage('Transcription paused');
    }
  };

  const validateKey = async (): Promise<boolean> => {
    if (!apiKey && !import.meta.env.VITE_OPENAI_API_KEY) {
      setError('Enter an OpenAI API key to test connectivity.');
      setConnectivityOk(false);
      setConnectionNote('');
      return false;
    }
    setTestingKey(true);
    setConnectionNote('');
    setStatusMessage('Validating API key...');
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConnectivityOk(false);
        const msg = data.error || 'Key validation failed';
        setConnectionNote(msg);
        throw new Error(msg);
      }
      setConnectivityOk(true);
      const note = `Connected (${data.model || 'model ok'})`;
      setConnectionNote(note);
      setStatusMessage(note);
      return true;
    } catch (err: any) {
      const msg = err?.message || 'Unable to validate API key';
      setError(msg);
      setStatusMessage('API error');
      setConnectionNote(msg);
      return false;
    } finally {
      setTestingKey(false);
    }
  };

  const startSession = async () => {
    setError(null);
    const ok = await validateKey();
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey,
          languageMode,
          workshopType,
          summarizationWindowMinutes: 5,
          imageSize,
          stylePreset,
          phase,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Unable to start session');
        return;
      }
      setSessionActive(true);
      setStatusMessage('Session started');
      if (saveKey) {
        localStorage.setItem('aii_api_key', apiKey);
      } else {
        localStorage.removeItem('aii_api_key');
      }
      await startAudio();
    } catch (err: any) {
      setError(err?.message || 'Unable to start session');
    }
  };

  const endSession = async () => {
    try {
      await fetch(`${API_BASE}/api/session/end`, { method: 'POST' });
    } catch (e) {
      // ignore
    }
    stopAudio();
    setSessionActive(false);
    setImages([]);
    setTranscripts([]);
    setLastSummary(null);
    setAutoEnabled(false);
    setStatusMessage('Session ended');
    setPartialTranscript('');
    setRealtimeStatus('idle');
  };

  const triggerGenerate = async (isAuto = false) => {
    if (!sessionActive) return;
    setError(null);
    setStatusMessage(isAuto ? 'Auto generating...' : 'Generating image...');
    setGenerationInProgress(true);
    try {
      const res = await fetch(`${API_BASE}/api/generate`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Generation failed');
      }
      if (data.queued) {
        setPendingQueued(true);
        setStatusMessage(data.message);
        return;
      }
      const newImage: ImageItem = data.image;
      setImages((prev) => [newImage, ...prev.filter((img) => img.id !== newImage.id)]);
      if (newImage.summary) {
        setLastSummary({
          text: newImage.summary,
          timestamp: Date.now(),
          phase: newImage.phase,
        });
      }
      setStatusMessage('Image ready');
      setPendingQueued(false);
    } catch (err: any) {
      setError(err?.message || 'Generation failed');
      setStatusMessage('Generation error');
    } finally {
      setGenerationInProgress(false);
    }
  };

  const handlePin = async (id: string, pinned: boolean) => {
    try {
      const res = await fetch(`${API_BASE}/api/images/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const updated: ImageItem = data.image;
      setImages((prev) => prev.map((img) => (img.id === id ? updated : img)));
    } catch (e) {
      // ignore
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/images/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setImages((prev) => prev.filter((img) => img.id !== id));
      }
    } catch (e) {
      // ignore
    }
  };

  const handleExport = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/export`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Export failed');
        return;
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'session-summary.md';
      a.click();
      window.URL.revokeObjectURL(url);
      setStatusMessage('Exported summary');
    } catch (err: any) {
      setError(err?.message || 'Export failed');
    }
  };

  const handleConfigSave = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phase,
          autoIntervalMinutes: autoInterval,
          imageSize,
          stylePreset,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || 'Unable to save settings');
        return;
      }
      setStatusMessage('Settings saved');
      setSettingsOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Unable to save settings');
    }
  };

  const clearSavedKey = () => {
    localStorage.removeItem('aii_api_key');
    setSaveKey(false);
  };

  const latestImage = images.find((img) => !img.deleted);
  const pinnedImages = images.filter((img) => img.pinned);
  const recentImages = images.filter((img) => !img.pinned);
  const summaryBullets = useMemo(() => bulletsFromSummary(lastSummary?.text), [lastSummary]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>NCIM AI Illustrator</h1>
          <p className="tagline">Live visuals for strategy workshops (Arabic + English)</p>
        </div>
        <div className="top-actions">
          {sessionActive ? (
            <button className="ghost danger" onClick={endSession}>
              End session
            </button>
          ) : (
            <button className="primary" onClick={startSession}>
              Start new session
            </button>
          )}
          <button className="ghost" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
        </div>
      </header>

      {!sessionActive && (
        <div className="card setup">
          <div className="setup-col">
            <label>OpenAI API key</label>
            <input
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={saveKey}
                onChange={(e) => setSaveKey(e.target.checked)}
              />
              Save locally on this device
            </label>
            <div className="inline-actions">
              <button className="ghost" onClick={validateKey} disabled={testingKey}>
                {testingKey ? 'Testing…' : 'Test API connectivity'}
              </button>
              <button className="ghost" onClick={clearSavedKey}>
                Clear saved key
              </button>
            </div>
            <div className="info-row">
              <span className={classNames('pill', connectivityOk ? 'good' : connectivityOk === false ? 'bad' : 'neutral')}>
                {connectivityOk === null ? 'Not tested' : connectivityOk ? 'Connected' : 'Connection failed'}
              </span>
              <span className="muted">
                {connectionNote || 'Audio and text are sent to OpenAI for processing.'}
              </span>
            </div>
          </div>
          <div className="setup-col narrow">
            <label>Default language handling</label>
            <select value={languageMode} onChange={(e) => setLanguageMode(e.target.value as any)}>
              <option value="auto">Auto detect (Arabic + English)</option>
              <option value="arabic">Arabic primary</option>
              <option value="english">English primary</option>
            </select>
            <label>Workshop type</label>
            <input
              value={workshopType}
              onChange={(e) => setWorkshopType(e.target.value)}
              placeholder="NCIM Strategy Workshop"
            />
            <label>Starting phase</label>
            <select value={phase} onChange={(e) => setPhase(e.target.value)}>
              {PHASES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <label>Image size</label>
            <select value={imageSize} onChange={(e) => setImageSize(e.target.value)}>
              {SIZE_OPTIONS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <label>Style preset</label>
            <select value={stylePreset} onChange={(e) => setStylePreset(e.target.value)}>
              {STYLE_PRESETS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {sessionActive && (
        <div className="session-layout">
          <section className="left-panel">
            <div className="section-header">
              <div>
                <p className="label">Workshop phase</p>
                <select value={phase} onChange={(e) => setPhase(e.target.value)}>
                  {PHASES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div className="status-group">
                <span className={classNames('pill', audioLevel > 0.05 ? 'good' : 'neutral')}>Listening</span>
                <span className={classNames('pill', generationInProgress ? 'warn' : 'neutral')}>
                  {generationInProgress ? 'Generating' : 'Idle'}
                </span>
                <span
                  className={classNames(
                    'pill',
                    realtimeStatus === 'connected'
                      ? 'good'
                      : realtimeStatus === 'connecting'
                      ? 'warn'
                      : realtimeStatus === 'error'
                      ? 'bad'
                      : 'neutral',
                  )}
                >
                  {realtimeStatus === 'connected'
                    ? 'Realtime on'
                    : realtimeStatus === 'connecting'
                    ? 'Realtime...'
                    : realtimeStatus === 'error'
                    ? 'Realtime error'
                    : 'Realtime off'}
                </span>
                {transcriptionPaused && <span className="pill warn">Paused</span>}
                {error && <span className="pill bad">Error</span>}
              </div>
            </div>

            <div className="audio-meter">
              <div className="meter-bar" style={{ width: `${Math.min(audioLevel * 100, 100)}%` }} />
              <span className="meter-label">Mic level</span>
            </div>

            <div className="controls-row">
              <button className="ghost" onClick={toggleTranscription}>
                {transcriptionPaused ? 'Resume transcription' : 'Pause transcription'}
              </button>
              <label className="checkbox" style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={skipSilence}
                  onChange={(e) => setSkipSilence(e.target.checked)}
                />
                Skip silence
              </label>
              <button className="primary" disabled={generationInProgress} onClick={() => triggerGenerate(false)}>
                {generationInProgress ? 'Generating…' : 'Generate image now'}
              </button>
              <div className="auto-toggle">
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={autoEnabled}
                    onChange={(e) => setAutoEnabled(e.target.checked)}
                  />
                  Auto every
                </label>
                <select
                  value={autoInterval}
                  onChange={(e) => setAutoInterval(Number(e.target.value))}
                  disabled={!autoEnabled}
                >
                  {INTERVAL_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt} min
                    </option>
                  ))}
                </select>
              </div>
              <button className="ghost" onClick={() => setViewMode(viewMode === 'latest' ? 'gallery' : 'latest')}>
                {viewMode === 'latest' ? 'Switch to gallery' : 'Latest only'}
              </button>
            </div>

            <div className="panel-block">
              <div className="block-header">
                <p className="label">Transcript preview</p>
                <span className="muted">Last few entries, not stored after session</span>
              </div>
              <div className="transcript" dir="auto">
                {transcripts.length === 0 && <p className="muted">Waiting for speech…</p>}
                {transcripts.slice(-12).map((t, idx) => (
                  <p key={`${t.timestamp}-${idx}`}>
                    <span className="muted">{formatTranscriptTime(t.timestamp)} — </span>
                    {t.text}
                  </p>
                ))}
                {partialTranscript && (
                  <p className="muted">
                    <span className="muted">Live — </span>
                    {partialTranscript}
                  </p>
                )}
              </div>
            </div>

            <div className="panel-block">
              <div className="block-header">
                <p className="label">Last summary</p>
                <span className="muted">
                  {lastSummary ? `${phase} • ${formatTranscriptTime(lastSummary.timestamp)}` : 'Pending'}
                </span>
              </div>
              {summaryBullets.length === 0 && <p className="muted">No summary yet. Trigger generation to create one.</p>}
              <ul className="summary-list">
                {summaryBullets.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          </section>

          <section className="right-panel">
            <div className="panel-header">
              <div>
                <p className="label">Images</p>
                <p className="muted">
                  {viewMode === 'latest' ? 'Latest image view' : 'Gallery grid'} • {images.length} generated
                </p>
              </div>
              <div className="status-group">
                {pendingQueued && <span className="pill warn">Next run queued</span>}
                <span className="pill neutral">{statusMessage}</span>
              </div>
            </div>

            {viewMode === 'latest' && latestImage && (
              <div className="latest-card">
                <div className="image-wrapper">
                  <img src={latestImage.url} alt={latestImage.prompt.slice(0, 60)} />
                  <div className="image-meta">
                    <div>
                      <p className="label">{latestImage.phase}</p>
                      <p className="muted">
                        {formatClock(latestImage.createdAt)} • {latestImage.size}
                      </p>
                    </div>
                    <div className="image-actions">
                      <button
                        className="ghost small"
                        onClick={() => handlePin(latestImage.id, !latestImage.pinned)}
                      >
                        {latestImage.pinned ? 'Unpin' : 'Pin'}
                      </button>
                      <button className="ghost small" onClick={() => handleDelete(latestImage.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
                <div className="prompt">
                  <p className="label">Prompt</p>
                  <p>{latestImage.prompt}</p>
                </div>
              </div>
            )}

            {viewMode === 'gallery' && (
              <div className="gallery-grid">
                {[...pinnedImages, ...recentImages].map((img) => (
                  <div className="gallery-card" key={img.id}>
                    <div className="gallery-img">
                      <img src={img.url} alt={img.prompt.slice(0, 40)} />
                      <div className="badge-row">
                        {img.pinned && <span className="pill good">Pinned</span>}
                        <span className="pill neutral">{img.phase}</span>
                      </div>
                    </div>
                    <div className="gallery-meta">
                      <p className="muted">
                        {formatClock(img.createdAt)} • {img.size}
                      </p>
                      <p className="prompt-snippet">{img.prompt}</p>
                      <div className="image-actions">
                        <button className="ghost small" onClick={() => handlePin(img.id, !img.pinned)}>
                          {img.pinned ? 'Unpin' : 'Pin'}
                        </button>
                        <button className="ghost small" onClick={() => handleDelete(img.id)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {images.length === 0 && <p className="muted">No images yet. Generate to get started.</p>}
              </div>
            )}

            <div className="panel-footer">
              <div className="info-row">
                <span className="muted">
                  Auto cadence: {autoEnabled ? `${autoInterval} minutes` : 'Off'} • Style: {stylePreset}
                </span>
              </div>
              <div className="footer-actions">
                <button className="ghost" onClick={handleExport}>
                  Export prompts
                </button>
                <button className="ghost" onClick={() => setViewMode(viewMode === 'latest' ? 'gallery' : 'latest')}>
                  {viewMode === 'latest' ? 'Gallery view' : 'Latest view'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {error && (
        <div className="toast error">
          <div>
            <strong>Error:</strong> {error}
          </div>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {settingsOpen && (
        <div className="modal">
          <div className="modal-content">
            <div className="modal-header">
              <h3>Session settings</h3>
              <button className="ghost" onClick={() => setSettingsOpen(false)}>
                Close
              </button>
            </div>
            <label>Image size</label>
            <select value={imageSize} onChange={(e) => setImageSize(e.target.value)}>
              {SIZE_OPTIONS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <label>Image style</label>
            <select value={stylePreset} onChange={(e) => setStylePreset(e.target.value)}>
              {STYLE_PRESETS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <label>Auto generation default</label>
            <select value={autoInterval} onChange={(e) => setAutoInterval(Number(e.target.value))}>
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt} minutes
                </option>
              ))}
            </select>
            <div className="modal-footer">
              <button className="primary" onClick={handleConfigSave}>
                Save
              </button>
              <button className="ghost" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
