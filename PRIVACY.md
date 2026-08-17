# Privacy

## Data stored locally

ChatBrowserX stores conversations, WorkSession and TaskRun recovery state, ordinary messages,
runtime supplements, events, pending/completed Tavily tool calls, and attachment references in
IndexedDB. User-added images and user-triggered screenshots are stored as IndexedDB Blob records.
Interface settings, the Codex Access Token, and the Tavily API Key are stored in
`chrome.storage.local`, restricted to trusted extension contexts.

Data is not stored with `chrome.storage.sync`. Clearing or deleting a conversation first stops unfinished work, then removes its messages, tasks, events, checkpoints, and attachment references. Unreferenced attachments are collected after the cleanup grace period.

## Data sent to Codex

For an ordinary chat task, Codex receives only:

- up to the configured number of newest completed user and assistant messages from successfully completed prior WorkSessions (50 by default, configurable from 1 to 50);
- the current WorkSession's ordered user messages, accepted runtime supplements, and recorded function calls/outputs needed for continuation;
- images explicitly attached to those messages or supplements, with active-WorkSession images taking priority under the existing image count and byte limits;
- the system prompt exactly as saved in Settings.

The history window is limited by message count only; selected message text is not additionally
truncated by a character cap. Active WorkSession continuation items do not count toward that history
message limit. The production runtime registers only `tavily_search`, `tavily_extract`, and
`tavily_crawl`. Pending and completed Tavily calls are stored in checkpoints and sent back to Codex
as ordered function calls/outputs so paused, cancelled, or restarted work can continue without
repeating a recorded call. One result item is limited to 12,000 content characters and one call to
40,000 aggregate content characters. ChatBrowserX does not automatically send page text, DOM,
iframe data, page snapshots, budgets, risk policies, or screenshots that the user did not explicitly
attach.

The Codex Access Token is sent only to the fixed Codex endpoint. Explicit attachments may contain sensitive data; attach only data you are allowed to send.

## Data sent to Tavily

Tavily is contacted only when Codex selects one of the three registered web tools. Requests use the
fixed endpoints `https://api.tavily.com/search`, `https://api.tavily.com/extract`, and
`https://api.tavily.com/crawl`. Depending on the tool, Tavily receives a search query, public URL
list, crawl root, extraction instructions, bounded depth/result controls, and optional public-domain
filters. The Tavily API Key is sent only in the HTTPS `Authorization` header and is never placed in
the request body, task checkpoint, panel snapshot, or model context.

Browser page text is not automatically sent to Tavily. Tavily tools cannot read the current DOM,
control the browser, capture network requests, or invoke browser actions. Extract and crawl URLs
come from the model's validated tool arguments and reject syntactically local, private, reserved,
credential-bearing, and non-HTTP(S) targets.

## Page access and captures

All-site access supports user-triggered region screenshots and page-selection features. It does not cause background page reading.

- Viewport or region screenshots enter a model request only after the user captures and keeps them in the draft, then sends that draft.
- Translation sends the selected text plus bounded page URL and title.
- Ask AI turns the selected text and question into an explicit chat message.
- Password and editable surfaces do not trigger the selection feature.

## Data not collected

This version contains no browser observation/action tools, voice input, speech recognition,
recording, subtitles, microphone/tab audio capture, printing, PDF generation/reading, full-page
stitching, generic network recording, desktop capture, cloud task sync, telemetry pipeline, or
advertising tracker.
