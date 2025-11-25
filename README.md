# NCIM AI Illustrator

Local-first web app that listens to live workshop audio (Arabic + English), summarises the discussion, turns it into illustration prompts, and generates projector-friendly images with OpenAI.

## Quick start (under 5 minutes)

1) Install deps  
```bash
cd server && npm install
cd ../client && npm install
```
2) Run the backend  
```bash
cd server && npm run dev   # starts on http://localhost:4000
```
3) Run the frontend  
```bash
cd client && npm run dev   # opens on http://localhost:5173
```
4) In the UI, paste your OpenAI API key (optionally save locally), pick language handling, workshop phase, and click **Start new session**.  
5) Grant microphone permission, confirm the audio meter moves, then click **Generate image now** or enable **Auto every X min**.  
6) Pin/unpin or delete images, switch between Latest/Gallery, open **Settings** for size/style, and **Export prompts** when ending.

## How it works

- Browser captures microphone audio (no disk writes) and streams ~1.2s WebM/Opus slices over WebSocket to the backend with a softer, frame-count-based silence gate (skip is optional).
- Backend decodes each slice to mono 24 kHz PCM and forwards it to the OpenAI Realtime API (`gpt-4o-mini-realtime-preview` + `gpt-4o-mini-transcribe` for transcription with server VAD). Transcripts arrive incrementally and are lightly polished, then kept in a rolling window (defaults: 10 minutes).
- Summarisation + prompt building use GPT-4o-mini; images are generated with `gpt-image-1`.
- One active session at a time; in-memory only until you export prompts. API key lives only in memory unless you opt to store it in browser localStorage. The legacy `/api/audio` chunk endpoint remains available as a fallback.

## Key endpoints (backend)

- `POST /api/ping` – validate API key.
- `POST /api/session/start|end` – begin or end a session.
- `POST /api/audio` – upload audio chunk for transcription.
- `POST /api/generate` – run summarise → prompt → image (queues if one is running).
- `POST /api/config` – update phase/interval/size/style.
- `PATCH/DELETE /api/images/:id` – pin/unpin or soft delete.
- `POST /api/export` – download markdown with prompts and metadata.
- `WS /ws/audio` – realtime audio bridge (streams 24 kHz PCM to OpenAI Realtime); the browser sends 1.2s WebM/Opus slices.

## Configuration notes

- Default image size `1024x1024`; widescreen `1792x1024` available.
- Audio is recorded in the browser (WebM/Opus where supported) and streamed over WebSocket. Server decodes to 24 kHz PCM and pushes to the Realtime API with server-side VAD and transcription.
- Auto cadence options: 3/5/10 minutes. Manual “Generate now” always available.
- Language modes: Auto detect, Arabic primary, English primary.
- Style presets editable in Settings; prompts always emitted in English.
- If a trigger fires while generation is running, the next run is queued and executed immediately after.
- Transcription defaults: model `gpt-4o-mini-transcribe` (Realtime uses `gpt-4o-mini-realtime-preview` + the same ASR model), 24 kHz mono. Override with `AII_TRANSCRIPTION_MODEL`, disable polishing with `AII_ENABLE_TRANSCRIPT_POLISH=false`, change sample rate via `AII_TRANSCRIPTION_RATE`, or set realtime knobs (`AII_REALTIME_MODEL`, `AII_REALTIME_TRANSCRIBE_MODEL`, `AII_REALTIME_VAD_THRESHOLD`, `AII_REALTIME_VAD_SILENCE_MS`). Set `AII_AUDIO_DEBUG=true` to log chunk signatures.

## Security and privacy

- API keys are never logged; saved only to browser localStorage if you opt in.
- Audio stays in memory; no audio files are written to disk by default.
- Transcripts and prompts are kept in memory for the active session and cleared on session end (except explicit exports).

## Testing

- Backend smoke + mock end-to-end (uses mocked OpenAI, includes audio upload flow):
  ```bash
  cd server && npm test
  ```
- Frontend type-check + build:
  ```bash
  cd client && npm run build
  ```
