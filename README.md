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

- Browser captures microphone audio (no disk writes) and sends small chunks to the backend.
- Backend transcribes with Whisper, keeps a rolling transcript (defaults: 10 minutes), summarises with GPT-4o-mini, builds an English illustration prompt, and generates images with `gpt-image-1`.
- One active session at a time; in-memory only until you export prompts. API key lives only in memory unless you opt to store it in browser localStorage.

## Key endpoints (backend)

- `POST /api/ping` – validate API key.
- `POST /api/session/start|end` – begin or end a session.
- `POST /api/audio` – upload audio chunk for transcription.
- `POST /api/generate` – run summarise → prompt → image (queues if one is running).
- `POST /api/config` – update phase/interval/size/style.
- `PATCH/DELETE /api/images/:id` – pin/unpin or soft delete.
- `POST /api/export` – download markdown with prompts and metadata.

## Configuration notes

- Default image size `1024x1024`; widescreen `1792x1024` available.
- Audio is recorded in the browser (WebM/Opus where supported) and sent directly to Whisper with a WAV fallback for unknown containers—no unnecessary transcoding in the common path.
- Auto cadence options: 3/5/10 minutes. Manual “Generate now” always available.
- Language modes: Auto detect, Arabic primary, English primary.
- Style presets editable in Settings; prompts always emitted in English.
- If a trigger fires while generation is running, the next run is queued and executed immediately after.

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
