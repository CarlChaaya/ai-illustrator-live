
# NCIM AI Illustrator - Product Requirements Document (PRD)

## 1. Document control

- Product name: NCIM AI Illustrator
- Version: 0.1 (Draft)
- Date: 2025-11-25
- Owner: [Your name or team]
- Stakeholders:
  - NCIM KSA workshop sponsor
  - Strategy and vision facilitators
  - Technical team implementing the solution
  - IT and security stakeholders (for API and data usage)

## 2. Background and context

### 2.1 Workshop context

NCIM KSA (National Center for Inspection and Monitoring) is running in-person strategy workshops to define or refine:
- Vision
- Mission
- Strategic objectives
- KPIs
- Pain points and enablers

Workshops are interactive. Participants speak in a mix of Arabic and English in a single physical room. Conversations are conceptual, often abstract, and can be dense.

The facilitator wants to enhance participant engagement and alignment by visually illustrating key ideas in near real time and projecting these illustrations in the room.

### 2.2 Problem statement

- Strategy discussions are often abstract and verbal only, which makes it harder for participants to align on a shared mental picture.
- Traditional facilitation tools (sticky notes, whiteboards, standard slide decks) are time consuming to maintain during fast moving discussions.
- There is no simple way to transform the live conversation into visuals without disrupting the flow of the workshop.

### 2.3 Opportunity

Use an LLM powered assistant that:
- Listens to the live room audio.
- Transcribes the multilingual conversation (Arabic and English).
- Periodically summarises the current discussion and turns it into image prompts.
- Uses OpenAI image models to generate illustrative images.
- Displays these images in a simple, projector friendly web interface running locally on the facilitator’s laptop.

## 3. Product overview

### 3.1 Product vision

Create a simple local web application that acts as an “AI illustrator” for strategy workshops, automatically generating visual representations of the ongoing discussion to support shared understanding and engagement.

### 3.2 Objectives and success metrics

Primary objectives:
- Increase engagement during workshops by making abstract discussion visual.
- Help participants converge on a shared understanding of the vision, mission and strategic objectives.
- Minimise cognitive load on the facilitator. The tool must “just work” once started.

Indicative success metrics (qualitative for v1):
- Facilitator reports that the tool requires less than 5 minutes of setup before the workshop.
- Images are generated within 30 to 60 seconds of a trigger (auto or manual) in at least 90 percent of cases with stable internet.
- Majority of participants report that the images were “helpful” or “very helpful” in a short feedback survey.

### 3.3 Scope for v1 (MVP)

In scope for v1:
- Single user, single machine usage.
- One active workshop session at a time.
- Runs locally in a browser on the facilitator’s laptop (Mac or Windows).
- Captures audio from the laptop microphone.
- Uses OpenAI APIs for:
  - Speech to text (Arabic and English).
  - Text understanding and summarisation.
  - Image prompt generation.
  - Image generation.
- Simple UI optimised for being displayed on a projector.

Out of scope for v1:
- Multi room or remote participant integration (e.g. Zoom, Teams).
- Advanced image editing or composition tools.
- Storing data in a central cloud database.
- Full meeting transcription export with speaker diarisation.
- Fine tuned or custom models.

## 4. Users and use cases

### 4.1 Primary users

1. **Workshop facilitator**
   - Operates the tool on their laptop.
   - Connects laptop to the projector.
   - Starts and stops sessions.
   - Chooses workshop phase (Vision, Mission, Objectives, KPIs, etc.).
   - Triggers manual image generation when needed.
   - Selects and pins images to keep on screen.

2. **Workshop participants**
   - View images projected on the screen.
   - Do not directly interact with the tool.

### 4.2 Key use cases

1. **UC1 - Start a workshop session**
   - Facilitator opens the web app on their laptop.
   - Enters OpenAI API key if not already stored locally.
   - Selects or confirms basic session settings.
   - Starts the session and verifies that the microphone is active and audio levels look healthy.

2. **UC2 - Live illustration during “Vision” discussion**
   - Facilitator sets the workshop phase selector to “Vision”.
   - The system listens to the room conversation.
   - Every X minutes or on manual trigger, the system:
     - Summarises the latest discussion window.
     - Generates a creative prompt for an image.
     - Calls the image generation API.
     - Displays the new image in the UI and highlights it as the latest.

3. **UC3 - Manual “generate now” trigger**
   - Facilitator clicks “Generate image now” when a key idea emerges.
   - System uses the last N minutes of transcript and current phase to generate and display a new image.

4. **UC4 - Pin and manage images**
   - Facilitator can:
     - Pin an image to keep it always visible even as new images appear.
     - Unpin or remove images.
     - Toggle between “latest image full screen” and “gallery grid” views.

5. **UC5 - End session**
   - Facilitator clicks “End session”.
   - System optionally offers to export:
     - A simple session summary (text).
     - A list of image prompts used.
   - System stops audio capture and clears sensitive data from memory.

## 5. User experience and UI

### 5.1 UX principles

- Extremely simple and minimal interface.
- Optimised for display on a projector in a meeting room.
- Safe to operate under pressure by a facilitator who is busy speaking and moderating.
- Clear feedback for system status (listening, generating, error).

### 5.2 Key screens

1. **Landing / Setup screen**
   - Fields and controls:
     - OpenAI API key input with “Save locally” checkbox.
     - Dropdown: default language handling
       - “Auto detect” (recommended).
       - “Arabic primary”.
       - “English primary”.
     - Dropdown: workshop type
       - “NCIM Strategy Workshop” (pre-filled template).
     - Button: “Start new session”.
   - Indicators:
     - API connectivity check result (success or error message).

2. **Live session screen**
   - Layout (desktop, projector friendly):
     - Left panel (approx 30 to 40 percent width):
       - Current workshop phase selector:
         - Vision
         - Mission
         - Strategic objectives
         - KPIs
         - Other (custom text).
       - Status bar:
         - Audio level meter (simple bar showing input volume).
         - Labels: Listening, Generating image, Error.
       - Transcript preview:
         - Scrolling text area showing recent transcript snippets in original language.
         - Simple styling to support Arabic right to left display.
       - “Last summary” text:
         - Short bullet list of key points extracted from recent discussion.
     - Right panel (approx 60 to 70 percent width):
       - Main area for images.
       - Modes:
         - “Latest image view” (large, centered image with title, timestamp, phase tag).
         - “Gallery grid” view showing recent images in a 2x2 or 3x2 grid.
   - Controls:
     - Button: “Generate image now”.
     - Toggle: Auto generate every [X] minutes (configurable via simple dropdown: 3, 5, 10 minutes).
     - Button: “Switch to gallery” / “Switch to latest only”.
     - For each image:
       - Pin or unpin icon.
       - Delete icon (soft delete from UI).

3. **Settings modal (in session)**
   - Accessible via a small “Settings” icon in the top right.
   - Fields:
     - OpenAI API key (masked).
     - Image size (e.g. 1024x1024 or 1792x1024).
     - Image style presets (e.g. “simple line illustration”, “flat icons”, “semi realistic”).
     - Generation cadence default.
   - Buttons:
     - Save and close.
     - Cancel.

4. **End session confirmation dialog**
   - Text: “End current session and stop listening?”
   - Options:
     - “End session”.
     - “Cancel”.
   - Optional checkboxes:
     - “Export session summary to local file (markdown or text)”.

### 5.3 UX details and behaviours

- When a new image is generated:
  - UI transitions smoothly to show it as the primary image.
  - A small “New” badge appears for a few seconds.
- Arabic text in transcript:
  - Display right to left with appropriate font.
- If connection to OpenAI fails:
  - Clear error message is shown:
    - What went wrong (for example: invalid API key, network issue).
    - What the facilitator should do.

## 6. Functional requirements

Functional requirements use the identifier format FR-X.Y.

### 6.1 Session management

- **FR-1.1** The system shall allow the user to start a new session from the landing screen.
- **FR-1.2** The system shall maintain a single active session at a time.
- **FR-1.3** The system shall allow the user to end the session explicitly via an “End session” button.
- **FR-1.4** On ending a session, the system shall stop audio capture and all calls to OpenAI APIs.
- **FR-1.5** The system shall clear in-memory buffers of audio and transcript when a session ends.

### 6.2 Audio capture

- **FR-2.1** The system shall capture audio from the default system microphone in real time.
- **FR-2.2** The system shall request microphone permission from the browser and display a clear prompt if permission is denied.
- **FR-2.3** The system shall display a simple audio level meter indicating that audio is being received.
- **FR-2.4** The system shall handle temporary microphone disruption gracefully (for example: cable unplugged) and surface an error message.

Implementation note (for developers, not visible in UI):
- Browser client captures audio via Web Audio or MediaDevices APIs.
- Audio is streamed or chunked to the backend process for transcription.

### 6.3 Speech to text (Arabic and English)

- **FR-3.1** The system shall transcribe audio into text in near real time.
- **FR-3.2** The system shall support both Arabic and English speech.
- **FR-3.3** The system shall support automatic language detection when the “Auto detect” mode is active.
- **FR-3.4** The system shall store recent transcript text in memory for at least the last N minutes (configurable in code, default 10 minutes).
- **FR-3.5** The system shall expose the recent transcript to downstream components that summarise and prompt the image model.

Implementation options (guidance):
- Use OpenAI audio APIs or realtime APIs for speech to text and multilingual support (e.g. Whisper based endpoints).

### 6.4 Discussion summarisation and topic extraction

- **FR-4.1** The system shall periodically summarise the recent transcript into short bullet points that capture the key ideas.
- **FR-4.2** The system shall allow configuration of the summarisation window duration (for example: last 3, 5, or 10 minutes of transcript).
- **FR-4.3** The system shall incorporate the current workshop phase (Vision, Mission, Strategic objectives, KPIs, Other) as explicit context in all summaries.
- **FR-4.4** The system shall generate concise summaries suitable for use inside image prompts (no more than 100 to 200 words).

Implementation guidance:
- Use an LLM such as `gpt-4.1` or `gpt-4o` via the Chat Completions API to summarise recent transcript text with system prompts that mention:
  - Workshop context (NCIM KSA, strategic workshop).
  - Current phase.
  - Requirement to avoid sensitive personal details in prompts.

### 6.5 Image prompt creation

- **FR-5.1** The system shall transform summaries into creative but relevant image prompts in English, even if the original conversation is in Arabic.
- **FR-5.2** The system shall generate prompts that respect the selected style preset (for example: “flat, minimalist illustration suitable for a strategy workshop slide”).
- **FR-5.3** The system shall attach metadata to each generated prompt, including:
  - Timestamp.
  - Workshop phase.
  - Summarisation window (for example: last 5 minutes).

Implementation guidance:
- Use the LLM to convert bullet summaries into a single multi sentence image prompt.
- Include guardrails such as “avoid text inside the image” or “no realistic human faces” if desired.

### 6.6 Image generation

- **FR-6.1** The system shall generate images from prompts using the OpenAI image generation API.
- **FR-6.2** The system shall support at least one default image size (1024x1024). Optional: 1792x1024 widescreen for projector use.
- **FR-6.3** The system shall generate at least one image per request.
- **FR-6.4** The system shall display a loading indicator while an image is being generated.
- **FR-6.5** The system shall store a list of generated images in memory for the current session, each with associated metadata (timestamp, phase, prompt).
- **FR-6.6** The system shall handle image generation errors gracefully and show a human readable error message.

Implementation guidance:
- Use OpenAI’s `gpt-image-1` or equivalent image model via the Images API.
- Handle API keys and timeouts and implement simple retry logic where appropriate.

### 6.7 Workshop phase context

- **FR-7.1** The system shall allow the facilitator to select the current workshop phase using a dropdown or segmented control.
- **FR-7.2** The selected phase shall be applied to:
  - Summarisation.
  - Prompt creation.
  - Image metadata and display tags.
- **FR-7.3** The system shall default to “Vision” when a new session starts but allow the facilitator to change phase at any time.
- **FR-7.4** Phase changes shall take effect immediately for all new summaries and images.

### 6.8 Image gallery and interaction

- **FR-8.1** The system shall display the latest image prominently in the “latest image view” mode.
- **FR-8.2** The system shall provide a “gallery view” showing recent images in a grid layout.
- **FR-8.3** The system shall allow the facilitator to pin an image. Pinned images:
  - Remain visible in the gallery even if others are deleted.
  - Can optionally be favourited in the UI (for example: a star icon).
- **FR-8.4** The system shall allow the facilitator to delete an image from the current session view (soft delete). This does not need to call any external API.
- **FR-8.5** The system shall display image metadata (timestamp, phase, short title or caption).
- **FR-8.6** The system shall allow switching between “latest only” and “gallery” with a single click.

### 6.9 Auto and manual generation

- **FR-9.1** The system shall support automatic generation of images at an interval selected by the facilitator (for example: every 5 minutes).
- **FR-9.2** The system shall display the configured interval clearly in the UI when auto generation is enabled.
- **FR-9.3** The system shall support manual “Generate now” triggers that use the same pipeline (summarise -> prompt -> image) regardless of auto generation settings.
- **FR-9.4** If a manual trigger occurs while an automatic generation is in progress, the system shall queue or ignore extra triggers in a predictable way (developer can choose a strategy but must document it).

### 6.10 Export and session summary

- **FR-10.1** On session end, the system shall offer to export a simple text or markdown file with:
  - Session date and time.
  - Workshop type and phases used.
  - A list of generated prompts with timestamps and phase tags.
- **FR-10.2** Exported files shall be saved locally on the facilitator’s machine; no cloud storage is required.
- **FR-10.3** Export shall not include raw audio. Including full transcript is optional and can be implemented in later versions.

### 6.11 Settings and configuration

- **FR-11.1** The system shall allow the user to enter an OpenAI API key in the settings or landing screen.
- **FR-11.2** The system shall store the API key locally only if the user explicitly chooses “Save locally”. Otherwise, the key is kept in memory for the session.
- **FR-11.3** The system shall provide a way to clear a previously saved API key.
- **FR-11.4** The system shall allow configuration of:
  - Auto generation interval.
  - Image size.
  - Default style preset.
- **FR-11.5** The system shall provide a quick way to test API connectivity.

## 7. Non functional requirements

Non functional requirements use identifier format NFR-X.

### 7.1 Performance

- **NFR-1.1** For stable internet and normal API latency, time from “Generate now” click to image display should be under 60 seconds in at least 90 percent of cases.
- **NFR-1.2** Audio capture and transcription should operate with end to end latency under a few seconds for transcript display (exact value depends on chosen implementation).

### 7.2 Reliability and robustness

- **NFR-2.1** The system should continue to operate if OpenAI APIs temporarily fail, displaying errors and allowing the facilitator to retry.
- **NFR-2.2** If the browser tab is accidentally refreshed, the application should clearly indicate that the session has been lost and require an explicit restart.

### 7.3 Security and privacy

- **NFR-3.1** API keys must not be logged in console, files or analytics.
- **NFR-3.2** Audio data should not be written to disk by default. It should be streamed directly to the transcription component or kept in memory only for the minimum time required.
- **NFR-3.3** Transcripts and prompts should be held in memory for the current session only, except for explicit export requested by the facilitator.
- **NFR-3.4** The system must clearly state to the facilitator that audio and text are sent to OpenAI for processing, so they can obtain participant consent if needed.
- **NFR-3.5** If logs are stored for debugging, they must exclude raw audio and minimise sensitive content.

### 7.4 Usability

- **NFR-4.1** A new facilitator should be able to start their first session in under 5 minutes with minimal instruction.
- **NFR-4.2** All interactive elements should be clearly labeled and large enough to operate on a projector displayed interface.

### 7.5 Compatibility

- **NFR-5.1** The frontend should support the latest versions of Chrome and Edge on Windows and Chrome and Safari on macOS.
- **NFR-5.2** The application should run as a local web server on the facilitator’s machine (for example: `http://localhost:3000` or similar).

## 8. Proposed technical architecture

This section is guidance for developers; final implementation details can change if they still satisfy functional and non functional requirements.

### 8.1 High level components

1. **Frontend web app**
   - Technologies: React or similar SPA framework, HTML, CSS, JavaScript or TypeScript.
   - Responsibilities:
     - Capture microphone audio via browser APIs.
     - Display live transcript and status indicators.
     - Provide controls for workshop phase, auto/manual generation and settings.
     - Render generated images and gallery.
     - Communicate with backend via HTTP or WebSocket.

2. **Local backend service**
   - Technologies: Python (FastAPI, Flask) or Node.js (Express, NestJS).
   - Responsibilities:
     - Receive audio chunks or audio stream from the frontend.
     - Call OpenAI APIs for transcription, summarisation, prompt creation and image generation.
     - Maintain in memory state for current session (recent transcript, summaries, prompts, images).
     - Provide REST or WebSocket endpoints for frontend to trigger image generation and fetch results.

3. **OpenAI services**
   - Audio transcription endpoint.
   - Chat or completion endpoint for summarisation and prompt creation.
   - Image generation endpoint.

### 8.2 Typical data flow

1. User starts a session from the frontend.
2. Frontend requests microphone permission and begins capturing audio.
3. Audio is streamed or sent in small chunks to the backend.
4. Backend forwards audio to an OpenAI transcription endpoint.
5. Backend collects transcripts and maintains a rolling window of recent text.
6. On auto or manual trigger:
   - Backend summarises recent transcript with current phase context.
   - Backend turns the summary into an image prompt.
   - Backend calls the image generation API.
7. When the image is ready:
   - Backend stores image metadata in memory.
   - Backend notifies the frontend (for example via WebSocket or polling).
   - Frontend fetches and displays the image.

### 8.3 Error handling patterns

- If transcription fails for a short period, the backend logs the error and continues attempting.
- If image generation fails, the backend sends a structured error to the frontend, which shows a readable message and allows retry.
- If the OpenAI API key is invalid, the backend returns a specific error so the frontend can prompt the user to fix it.

## 9. OpenAI integration details (guidance)

This section is meant to orient the developer. Exact models or endpoints can be updated over time.

### 9.1 Speech to text

- Use OpenAI audio APIs that support multilingual transcription (including Arabic and English).
- Consider realtime transcription for lower latency if complexity is acceptable.
- Recommended behaviours:
  - Transcribe into the original language.
  - Optionally also translate to English for internal summarisation and prompting.

### 9.2 Summarisation and prompt creation

- Use a general purpose GPT model via the Chat Completions API.
- Example responsibilities:
  - Clean up transcription artifacts.
  - Extract key ideas relevant to the current workshop phase.
  - Create concise bullet summaries.
  - Generate well structured image prompts with consistent style.

### 9.3 Image generation

- Use OpenAI’s image generation API with a model such as `gpt-image-1`.
- Recommended:
  - Fix a small set of supported image sizes.
  - Specify styles consistent with professional strategy workshop visuals (simple, clear, high contrast).

### 9.4 API key handling

- API key stored on the client only if the user requests “Save locally”.
- Backend uses the provided API key for all OpenAI calls and does not persist it to disk by default.

## 10. Data handling and privacy

- Audio:
  - Captured from microphone.
  - Streamed or sent to backend for processing.
  - Not stored on disk by default.
- Transcripts and prompts:
  - Stored in memory for the duration of a session.
  - Optionally included in a user initiated export file.
- Images:
  - Stored in memory and in browser cache for current session.
  - Optionally saved manually by the user via standard browser “save image as” actions.

The facilitator is responsible for ensuring that participants are aware that audio is being processed by an external AI service.

## 11. Assumptions, dependencies and constraints

- Stable internet connection is available during the workshop.
- The facilitator’s laptop has a working microphone that can capture room audio.
- Browser can access microphone (no corporate restrictions blocking it).
- OpenAI API is accessible from the network environment where the workshop is held.
- The organisation agrees to send conversation content to OpenAI for processing.

## 12. Risks and mitigations

- **Risk: Poor room audio quality.**
  - Mitigation: Encourage use of an external microphone placed centrally in the room.
- **Risk: Network instability.**
  - Mitigation: The application should degrade gracefully, showing errors rather than hanging, and allow retries.
- **Risk: Generated images misrepresent or oversimplify strategic ideas.**
  - Mitigation: Make it clear that images are illustrative only and subject to facilitator interpretation.

## 13. Future enhancements (beyond v1)

- Multi room or hybrid meeting support with integration to video conferencing tools.
- More advanced control over image layout and templates for inserting directly into slide decks.
- Direct export of selected images and prompts into PowerPoint or Keynote templates.
- Support for multiple concurrent sessions and centralised logging.
- Advanced controls over prompt style and visual branding (e.g. NCIM brand colors, logo overlays).

## 14. Acceptance criteria summary

The product will be considered ready for v1 if:

1. A facilitator can install and run the local web app, start a session and generate at least 5 images in a 60 minute mock workshop without developer support.
2. Images appears within 60 seconds in at least 90 percent of manual “Generate now” triggers in a stable network test.
3. The app runs successfully on at least one Windows laptop and one MacBook with Chrome.
4. No API key is logged or stored in clear text in application logs.
5. A non technical test user can follow a one page quick start guide and successfully run a session.
