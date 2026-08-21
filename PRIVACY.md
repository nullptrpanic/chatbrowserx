# Privacy

## Data stored locally

ChatBrowserX stores conversations, WorkSession and TaskRun recovery state, ordinary messages,
runtime supplements, events, pending/completed Tavily and browser tool calls, and attachment references in
IndexedDB. User-added images and user-triggered screenshots are stored as IndexedDB Blob records.
Viewport screenshots explicitly requested by the browser agent are also stored as bounded IndexedDB
Blob records and referenced by their completed tool result; base64 image data is not written into task
checkpoints.
Interface settings, the Codex Access Token, and the Tavily API Key are stored in
`chrome.storage.local`, restricted to trusted extension contexts.

Data is not stored with `chrome.storage.sync`. Clearing or deleting a conversation first stops unfinished work, then removes its messages, tasks, events, checkpoints, and attachment references. Unreferenced attachments are collected after the cleanup grace period.

## Data sent to Codex

For an ordinary chat task, Codex receives only:

- up to the configured number of newest completed user and assistant messages from successfully completed prior WorkSessions (50 by default, configurable from 1 to 50);
- the current WorkSession's ordered user messages, accepted runtime supplements, and recorded function calls/outputs needed for continuation;
- images explicitly attached to those messages or supplements, plus bounded browser screenshots
  produced by an explicit `browser_inspect` screenshot tool call, with active-WorkSession images taking
  priority under the existing image count and byte limits;
- browser tool outputs selected during the task, which can include cleaned page text, accessibility
  labels, tab metadata, action results, screenshots, or sanitized network metadata/response text;
- the saved system prompt after the fixed browser safety instructions.

The history window is limited by message count only; selected message text is not additionally
truncated by a character cap. Active WorkSession continuation items do not count toward that history
message limit. The production runtime always registers the reviewed browser tools. It registers
`tavily_search`, `tavily_extract`, and `tavily_crawl` only while a nonblank Tavily API Key is present;
the Key itself is never exposed to the planner. Pending and completed tool calls are stored in
checkpoints and sent back to Codex as ordered function calls/outputs so paused, cancelled, or
restarted work can continue without repeating a recorded result. Ambiguous browser mutations are not
replayed after a worker interruption. Tavily result items are limited to 12,000 content characters
and one Tavily call to 40,000 aggregate content characters.

Page data is read only when Codex selects a reviewed browser tool while executing the user's task; it
is not silently appended to every request. Browser outputs are bounded before entering the model
context. Screenshots are transiently materialized from local Blob references only for the relevant
function output.

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

All-site access supports user-triggered screenshots and reviewed browser agent operations on
user-opened HTTP(S) tabs. Browser control may attach Chrome DevTools Protocol to
the selected tab, which makes Chrome show its normal debugger notice. Browser-internal pages,
extension pages, DevTools, local files, credential-bearing URLs, and unsupported schemes are rejected.

- Viewport or region screenshots enter a model request only after the user captures and keeps them in the draft, then sends that draft.
- An agent screenshot enters a model request only after Codex explicitly calls the screenshot inspect
  tool for the selected tab. Extension overlays are hidden during capture and restored afterward.

## Network analysis

Network capture starts only after Codex explicitly selects `browser_network_start`, records future
traffic only, and never refreshes a page implicitly. Initial-load analysis therefore requires an
explicit start, reload, wait, and list sequence. Capture buffers are in memory, scoped to one tab and
debugger attachment, limited to 500 entries, and discarded on stop, detach, or worker loss.

Request bodies are never returned. Response bodies are fetched from Chrome only when Codex explicitly
selects `browser_network_get` with body inclusion, are not retained in the capture buffer, and are
bounded before being returned. Cookie, Set-Cookie, Authorization and equivalent headers, sensitive
query values, and sensitive JSON fields are removed or redacted. Binary, unavailable, invalid, and
oversized bodies are marked rather than exposed.

## Data not collected

This version contains no voice input, speech recognition, recording, subtitles, microphone/tab audio
capture, printing, PDF generation/reading, full-page stitching, persistent generic network recording,
request-body export, arbitrary JavaScript or raw-CDP model tool, desktop capture, cloud task sync,
telemetry pipeline, or advertising tracker.
