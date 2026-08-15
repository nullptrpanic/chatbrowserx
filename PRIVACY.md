# Privacy

## Data stored locally

ChatBrowserX stores the following in the Chrome profile:

- conversations, messages, task state, checkpoints, events, and attachment references in IndexedDB;
- user-added images and manual screenshots as IndexedDB Blob records;
- interface settings, fixed-model preferences, Codex Access Token, and optional Tavily Key in `chrome.storage.local`;
- adaptive DOM/CDP routing outcomes without page payloads.

Data is not stored with `chrome.storage.sync`. Clearing a terminal conversation deletes its conversation/task records; attachments that are no longer referenced are collected after a 24-hour grace period during cleanup.

## Data sent to services

Codex receives the user goal, bounded recent complete conversation, bounded semantic page observation, completed tool results, user-referenced images, and—only when semantic signal is very low—a transient current-viewport image. The Codex Access Token is sent only to the fixed Codex endpoint.

Tavily receives only explicit bounded search, extract, or crawl arguments and its API key. Tavily results are truncated before entering model context.

Website content may be sensitive. Only use ChatBrowserX on pages whose content you are permitted to send to the configured services.

## Page access and captures

Web access is requested per HTTP(S) origin. Manual viewport/region screenshots are stored until their references are cleared and garbage-collected. Automatic low-signal visual fallback is not added to attachment storage or task history.

The page selection feature sends only the selected text plus bounded page URL/title for translation or Ask AI. It excludes password and editable surfaces.

## Data not collected by this version

This version contains no voice input, speech recognition, speech synthesis, recording, subtitles, microphone/tab audio capture, Volcengine integration, printing, PDF generation/reading, full-page scroll stitching, generic network recording, desktop capture, cloud task sync, telemetry pipeline, or advertising tracker.
