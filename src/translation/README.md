# Region translation

Build with `npm run build`, reload the existing unpacked ChatBrowserX extension, and refresh the
target web page once. In the side panel, click **区域翻译** next to Screenshot. The configured
Codex token, model, and UI language are reused; `system` resolves to the browser language. Translation
uses the configured reasoning effort, just like normal chat.

- The lens is an observation window over translations anchored to their original page coordinates.
  Moving or resizing it changes only the clipping window; cached translations remain ready.
  Nearby complete HTML text blocks are sent after 150 ms at rest. Images and other painted content
  retain the 800 ms capture delay. Both use an 80 CSS-pixel buffer around the lens, clamped to the
  viewport. First-time translation still waits for the model.
- A localized **翻译中…** label appears above the frame while waiting or translating, below it only
  when there is no room above. When the frame fills the viewport, the label stays at its top edge
  inside the viewport. It disappears on completion.
- Ctrl+wheel (including compatible trackpad pinch events) changes the lens size, from 250×130 CSS
  pixels up to the whole viewport. Width and height stop at their respective viewport edges;
  reversing the gesture shrinks immediately, including after repeated zoom-in or a window resize.
  Browser toolbar zoom and Cmd/Ctrl-plus are not intercepted.
- Press Escape **while focus is on the page**, or click the same button again, to close it. Switching
  tabs also closes it. Nothing in the original document is replaced.
- The toolbar button is highlighted while the current page's lens is active. Closing with Escape,
  changing tabs, or navigating does not leave the old page's active state on the button.
- Text in images is supported through cropped pixels. Plain, verified single-frame images can use
  their source bytes directly; other painted content uses a screenshot. Pixels go to the configured
  Codex provider; neither pixels nor translations are saved as a chat task or history.

## Ownership and lifecycle

- The isolated top-frame script owns one session per document: its lens, generation, timers,
  and event listeners. Close/reload/reinjection disposes them. Each new lens gets a new session ID.
  Escape and the toggle remove the lens and stop work, but preserve a bounded document-local cache
  of completed text and verified static-image translations. Reopening rechecks source content and
  geometry before displaying cached results. Previews and screenshot/video/canvas patches are not
  restored. New documents and script disposal start fresh; nothing is persisted to disk.
  Cache identity includes the resolved target language, model and reasoning effort. The worker tags
  final results with the settings actually used; a mismatch retires that session's retained cache,
  so changing settings during a request cannot save results under the wrong identity.
- `ChromeTranslationPagePort` sends bounded, correlated commands to that top frame. State queries do
  not inject code. A failed query is retried once, with a three-second bound per attempt. An explicit
  closed session, inactive tab, or absent receiver is inactive; a lost or invalid reply reports a
  page-communication error rather than claiming the session is closed.
  A toggle is retried only after an explicit unsupported-command response, never
  after an ambiguous timeout. A lost acknowledgement is reconciled against the exact new session ID,
  not treated as a reason to toggle again. Duplicate in-flight toggles and matching page-script
  installations are coalesced. Initial layout scanning is deferred until after the opening reply.
- `TranslationController` owns only in-flight requests, not a second copy of active lens state. Before
  capture it checks the session ID against the isolated page. This still works after an MV3 worker
  restart. Text and pixels have independent request slots: at most two text batches and one image
  request per tab. Image replacement leaves text requests alone; targeted cancellation affects only
  the matching session and kind. Closing, navigation and tab removal abort all matching requests.
- While open, the lens also checks native tab state once per second, with no overlapping probes.
  This closes it even when the Agent/debugger's focus emulation keeps `document.hidden` false.
  Communication failures preserve the lens and cached content, show an error and pause new work
  until movement; they do not silently close it or trigger model retries.
  Closing removes the timer; these checks never call the model or capture another screenshot.
- `translateTexts` and `translateRegion` share the existing provider port, with no tools or Agent
  loop. Page code receives no credentials. Authorization, cancellation and settings are shared;
  only the screenshot fallback needs overlay hiding.
- The side panel reuses its existing polling and page-close notifications to read actual lens state.
  Translation status never blocks chat refresh and is not persisted in task or conversation records.

The HTML path retains at most 128 source blocks. It reads complete nearby paragraphs, including
inline links, instead of asking the model to recognize cropped lines. Browser text ranges supply
line coordinates and font styles; the model returns only source IDs and complete translations.
Standalone links and rows consisting of links plus separators retain independent source IDs,
native bounds, colors and text decoration. Labels remain batched in the same request. The overlay
passes clicks through to the original anchors; it does not invent URLs or replace page behavior.
Mixed prose still translates as a complete paragraph rather than splitting sentences at links.
General inline rich-text alignment and exact private `:visited` colors are not implemented.
Each request is bounded to 32 blocks and 16,000 source characters; missing, duplicate or unknown
response IDs fail explicitly. Source IDs already in flight are excluded from new batches. Newly
exposed text can fill the second slot while the first is pending; a third batch waits for a free
slot. Complete, ID-validated paragraph prefixes can display before the entire response finishes;
the final batch still requires every source ID exactly once. Provisional text never enters the
completed cache. A failed or cancelled batch removes only its previews, not other completed batches.
Hidden and editable subtrees are not collected. Local line fitting
distributes shorter translations across the source lines and fits longer ones without changing
the source document. A plain, single-line, left-aligned block uses its available content width before
shrinking its font; a short heading's glyph bounds are not its layout width. Controls and mixed
inline content retain bounded fitting. Movement within the collected buffer only updates clipping, without rescanning
layout. Scrolling recomputes coordinates but reuses translations when the source text is unchanged.

The visual path retains a complete visible batch plus three spare capture layers (four for a small
lens), each with bounded valid rectangles. Each model image crop stays within 1,200×800 CSS pixels;
large lenses fill missing areas sequentially without lowering image resolution. The local pixel
inspection covers the whole buffered lens independently of those model crops. Pixel history retains
up to two inspected areas, with a minimum capacity of 1,024 cells. Screenshots are not retained. Examined blank pixels suppress
unnecessary repeat requests but never mask a newer translation: overlap masks use actual painted
text rectangles. A changed pixel invalidates the whole affected text overlay, not half a line.
DOM-owned text is masked out of mixed visual inputs to avoid translating and painting it twice.

Moving/resizing preserves completed translations and pending screenshot captures that still overlap the lens.
An unrelated pending screenshot is cancelled. Text and image requests can run concurrently; neither
waits for the other to finish. While filling a new
region, valid overlapping translations remain visible and the notice stays outside the frame.
Failure does not remove other successful regions or cause an automatic retry loop.
Completed image responses are validated one block at a time. An edge overrun of at most 2/1000 is
clipped; genuinely invalid blocks are omitted without discarding valid siblings. Omitted blocks keep
an explicit error state, not a false claim that the whole region is translated. Incomplete streams,
invalid JSON and oversized envelopes still fail as a whole.

Image requests retain the original format: source text, translated lines and coordinates. Text
requests retain source IDs and translated paragraphs. Streaming
changes delivery only, not the model request, configured effort, image detail or response validation.
Complete, validated JSON-prefix blocks are sent as bounded cumulative previews to the originating
top frame, correlated by both session and request ID. The model stream never waits on page delivery.
Previews use the same text layout or image geometry/color sampling as final results; they do not mark
regions as complete or enter the completed cache. The loading notice remains until completion. The
final validated response replaces its preview; errors, cancellation and closure remove previews
without discarding unrelated completed translations. Late or out-of-order notifications are ignored.
This reduces time to the first visible translation, not the model's time to its first output.

## Static image sources

Plain images without cropping, transforms, filters, animation, rounded borders or padding can use
source pixels when all visual sources in the collected area qualify. Native `ImageDecoder` metadata
must prove a single, non-animated frame; filenames and momentarily unchanged pixels are not proof.
The page fetches at most eight sources, each bounded to 4 MiB, 16 million natural pixels and five
seconds. Same-origin, data/blob images and explicitly CORS-enabled images are eligible. Credentials
follow the page's same-origin policy. No new host access or decoder dependency is introduced.

Verified bytes and a bounded visible batch of translated patches per image stay in the open lens's eight-entry LRU
cache. Patches and coverage use intrinsic image coordinates; scrolling and resizing only reproject
their layers. Moving offscreen does not evict a source until the cache limit is reached. In-flight
results survive scrolling if their source identity is still valid. Source changes, reloads, natural
size or composited background changes invalidate only the affected image, not unrelated images.
Requests crop to missing visible source regions and mask already translated regions; they reuse
the same model, coordinate validation and painting path as screenshots. Newly revealed image areas
still need translation. There is no visible-tab capture, pixel polling or lens hiding on this path.
Closing aborts pending source loads and detaches layers, retaining only completed patches. Reopening
revalidates single-frame source metadata and checks full intrinsic-resolution pixel SHA-256.
Source loading remains parallel, but pixel buffers are fingerprinted one at a time and released
immediately. Closed caches retain translation layers and fingerprints, not source Blobs or pixel buffers.
Unchanged pixels and backgrounds reuse translations at new coordinates;
changed, unreadable or animated sources never restore old patches. Source checks may load the image
again, but do not call the model. Closing during validation preserves the previous completed cache.
At most eight sources are retained; each source uses the same visible-batch-plus-three patch limit.
If native
decoding, source access or styling cannot be verified, the screenshot path remains available.

## Dynamic regions

Ordinary HTML uses DOM, layout and font notifications to refresh source blocks and coordinates.
Late results apply only to still-connected, unchanged source text. Own overlay mutations are ignored.
Text-only regions do not capture screenshots or hide the lens for translation or inspection.

Unverified images, video, Canvas, CSS animation, transformed text and visible iframe content use pixel sampling;
there are no website-specific branches. When the lens includes visual content, or there is no readable
HTML source, the page requests one local inspection at a time,
waiting 1,000 ms after each completes. Inspections are independent of model requests, contain no
credentials, and return only full-resolution fingerprints of fixed 64 CSS-pixel grid cells. Complete
grid cells avoid mistaking cursor movement for content changes. Capture still requires the owning,
active top-frame session. Closing/navigation aborts both inspection and model work.

A changed cell immediately loses its cached and in-flight validity. One change requires two matching
subsequent samples to settle; repeated changes require three. These are sampling heuristics, not a
guarantee of continuous stability. Unsettled cells are excluded from translation scheduling and
masked in newly submitted images. No request or loading notice is produced for a fully excluded
lens. When cells settle, fresh translation fills the holes; old text never becomes valid again just
because motion stopped. Static portions of mixed results remain usable.

Only the latest inspected visual area can be displayed. A failed inspection hides visual overlays
until a successful inspection; it does not cancel an unrelated HTML request or cause a model retry.
Scroll/viewport changes reset screenshot coordinates and reject late screenshot results, while HTML geometry
is recomputed with cached translations. Pixel inspection determines changes to painted surfaces,
including their layout. Model failures show a localized error and require movement to retry.

All visible-tab screenshots share a serialized 600 ms capture slot. Translation overlays are hidden
only after obtaining the slot. Capture waits across two animation frames for the hiding to paint;
acknowledging the style mutation alone can capture the lens itself and cause false change detection.
If painting is suspended, the hide request fails after one second instead of capturing stale pixels.
Overlays are restored immediately after capture, including failures. This avoids holding them hidden
while queued, but hiding them during actual capture can still flicker.

## Boundaries

Only region translation is implemented: no full-page mode, disk cache, automatic model retry,
or translation of background tabs. No new dependencies or permissions. Settings are reused for each
request; close and reopen the lens after changing the target language, model or effort. The new
configuration cannot reuse translations from the previous configuration.

The buffer and complete paragraphs can increase the source content of a request. Mixed regions
may require both a text request and an image request. Parallelism removes their serial dependency,
not model latency or Tokens. Static-source cache hits avoid repeated model work, but this is not a
universal Token reduction.
Fallback visual inspections still add screenshots, pixel hashing and IPC; newly visited fallback
regions wait for inspection. They use no model Tokens but are not zero-cost. Image
translation includes screenshot upload and model processing; placement still comes from model boxes.
Sampled-color masks approximate image backgrounds, so gradients, patterns and
tiny/rotated text may look imperfect. Pixel sampling can miss brief changes between captures, and
changing backgrounds can conservatively exclude otherwise unchanged text. It can inspect only pixels
the browser actually captures; protected/uncapturable content is not guaranteed detectable. This is
not a real-time video translator: continuously changing regions show the original page.

Focused checks:

```sh
npx vitest run tests/translation
npm run build
npx playwright test --config e2e/playwright.config.ts region-translation.spec.ts
npx playwright test --config e2e/playwright.config.ts translation-dynamic.spec.ts --repeat-each 3
```

Browser tests use the real extension, toolbar, capture/crop/render path and a mocked provider. The
DOM/dynamic fixtures opt into headless Chrome to prevent desktop pointer events moving their lens;
the shared fixture remains headed by default. Real-profile feature diagnostics still run headed. They
check loading state, fixed text coordinates during movement, request reuse, dynamic text/painting,
Escape/toggle, tab switching and reload, but do not measure model quality or latency. Real model
experiments use the canonical authenticated E2E Profile; no
credentials are extracted from it. The separate `e2e/fixtures/translation-lens` website remains a
visual fixture, not the implementation used by the extension.
