# Privacy

## Data stored locally

ChatBrowserX stores conversations, messages, task recovery state, events, and attachment references in IndexedDB. User-added images and user-triggered screenshots are stored as IndexedDB Blob records. Interface settings and the Codex Access Token are stored in `chrome.storage.local`, restricted to trusted extension contexts.

Data is not stored with `chrome.storage.sync`. Clearing a completed conversation removes its conversation and task records; unreferenced attachments are collected after the cleanup grace period.

## Data sent to Codex

For an ordinary chat task, Codex receives only:

- the user message that created that task;
- images explicitly attached to that message;
- the system prompt exactly as saved in Settings.

The production runtime currently registers no concrete tools. Requests with an empty tool list omit the complete tool contract. ChatBrowserX does not automatically send page text, DOM, iframe data, page snapshots, old conversation messages, budgets, checkpoints, risk policies, or screenshots.

The Codex Access Token is sent only to the fixed Codex endpoint. Explicit attachments may contain sensitive data; attach only data you are allowed to send.

## Page access and captures

All-site access supports user-triggered region screenshots and page-selection features. It does not cause background page reading.

- Viewport or region screenshots enter a model request only after the user captures and keeps them in the draft, then sends that draft.
- Translation sends the selected text plus bounded page URL and title.
- Ask AI turns the selected text and question into an explicit chat message.
- Password and editable surfaces do not trigger the selection feature.

## Data not collected

This version contains no browser observation/action tools, web-search provider, voice input, speech recognition, recording, subtitles, microphone/tab audio capture, printing, PDF generation/reading, full-page stitching, generic network recording, desktop capture, cloud task sync, telemetry pipeline, or advertising tracker.
