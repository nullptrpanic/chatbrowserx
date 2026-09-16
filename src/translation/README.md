# Region translation — DOM text only

Build with `npm run build`, reload the unpacked extension, and refresh existing pages once after
updating. Click **区域翻译** beside Screenshot. It uses the configured model, reasoning effort,
token and resolved UI language, without an Agent loop, tools, chat tasks or history records.

## Interaction and guarantees

- The lens is only an observation window. Translations stay anchored to source content; movement
  changes clipping, not the meaning or coordinates of a pending response.
- Nearby HTML paragraphs are coalesced for 150 ms, with an 80 CSS-pixel buffer. Moving the
  lens does not restart a queued timer. Work reads the current region when the timer fires.
  Complete validated previews can appear before the response finishes; **翻译中…** remains
  until the visible text work finishes.
- Ctrl+wheel / compatible trackpad pinch resizes the lens up to the whole viewport. Browser
  toolbar zoom and Cmd/Ctrl-plus retain their normal behavior.
- Escape (with page focus), the toolbar toggle, navigation and tab deactivation close the lens.
  Closing cancels work, but retains bounded completed text
  translations for this document and the same language/model/effort. Refresh starts fresh.
- Only DOM text is translated. Images, chart labels, Canvas, video, SVG and embedded frames remain
  unchanged; their presence does not trigger model requests, resource inspection, a warning or a
  perpetual loading state. There is no image OCR, image-patch cache or image-translation fallback.
- There is no screen-sharing action, stream or screenshot fallback. Unsupported **DOM text** (for
  example text on an animated/complex backdrop or a translation that cannot fit readably) remains
  native, with the neutral **部分内容暂不支持翻译，已保留原样** notice after other text finishes.
  An empty or image-only region is ready. Unsupported text never blocks independent text.
- Failed content waits for the explicit **重试** action. Movement never retries model failures.
  Unrelated successful text remains visible. Errors are safe stage/code identifiers, not
  raw model responses, credentials or page content.

## Architecture

| Owner                                      | Responsibility                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `TranslationLensView`                      | Frame, clipping, status and pointer/zoom/Escape input. No model or capture work.                              |
| `TranslationDom`                           | Visible logical paragraphs, source identity, style markers, bounded completed caches and render invalidation. |
| `TranslationTextLayout`                    | Source glyph masks and native inline layout within source-owned slots. Does not reflow the page.              |
| `translation-context`                      | Bounded nearby DOM context, collected only before an uncached text request.                                   |
| `mount-translation-lens`                   | Text scheduling, session lifecycle, previews, retry and late-response correlation.                            |
| `TranslationController` + `translateTexts` | Page-session authorization, configured text-only model requests, response validation and cancellation.        |
| Background helpers                         | Restore safe CSS gradients or a verified static photo under **DOM captions**, never translate image pixels.   |

There is one model path:

Complete DOM paragraph → bounded text/context request → validate source IDs/style markers →
source-anchored DOM text overlay.

Removed: image selection/capture/crop, vision prompt/result types, image request scheduling,
coordinate/coverage tracking, image patch painting, color sampling, image fingerprints and image
translation reopen caches. The old `translation.image` and image-shaped `translation.read` messages
are rejected, not retained behind a feature flag. The previous runnable image feasibility spike
and image-only tests are retired; historical reports/screenshots are retained.

Ordinary screenshots, attachment previews and Agent browser tools are independent and unchanged.
Existing open tabs should be refreshed after reloading the extension because its internal translation
protocol now accepts only text requests.

## Text layout and source identity

Read complete logical paragraphs, including anonymous inline runs before/after block children.
Do not concatenate unrelated paragraphs across headings or controls. Standalone navigation labels
keep separate native bounds; mixed prose remains one paragraph.
Flex/grid labels use the owned text slot, not only the original Chinese glyph width. Transparent
inline labels (including blockified row-flex children) can borrow empty space to their right, bounded by the next native sibling and ancestor
clipping. Icons, badges and plain-text separators remain obstacles, including aria-hidden icons.
The glyph mask never borrows this space. Each slot inspection has a 256-node bound.

Source visibility includes ancestor clipping, not only display/visibility/opacity. Clipped CSS
subtrees, content-visibility:hidden and closed disclosure bodies stay native; a disclosure's
visible summary can still translate. Overflow-clipped text is retained when its full glyph bounds
do not fit the ancestor's painted area. An explicitly nowrap/ellipsis-clipped title is an exception:
translate its full source text, but mask only the visible horizontal slice. Other clipping remains
excluded. Opening a menu exposes its normal source blocks; closing it
removes all of their layers together (iterate a snapshot, not a live HTMLCollection).
Editable state follows the nearest valid `contenteditable` declaration: `false` islands inside an
editor are readable, while inherited editing and `plaintext-only` drafts remain excluded. This rule
is shared with context collection. On HTTPS Feishu/Lark `/docx/` pages, recognized document editor
zones inside `.page-block.root-block` are readable even though the document is contenteditable.
Unrelated editors, nested drafts and form controls remain excluded. Translation never edits the
document. Zero-width `data-enter` cursor placeholders are excluded from source text and context,
so they cannot create meaningless style markers that the model would have to preserve.
Docx editor runs with the same rendered typography as their paragraph are coalesced as plain
text before assigning markers. Editor-only span splitting is not a formatting identity; real
typography differences and links still retain markers and strict response validation.
Known static Docx watermark patterns (both SSR and hydrated suite variants) are reproduced only over original glyph masks;
the native watermarks are neither removed nor changed, and their tiled size/position is retained.
Explicitly aria-hidden decorations are not translation failures; unknown watermarks or other
unsupported painted content still retain the bounded unsupported status.

Inline formatting uses locally assigned paired `<mN>` markers. Literal source angle brackets and
ampersands are escaped. Validate balanced, non-duplicated marker identities in preview and final
output. Render only text nodes and locally created spans/anchors; never parse model HTML or use
model-provided URLs. Fonts, colors, link targets and decorations come from original elements.
Normal link clicks dispatch the source link's handler; modified clicks retain native href behavior.
Standalone translated links also retain a clickable hit area when English extends into safe spacing.
Browser-protected private `:visited` colors cannot be read exactly.

Mask original glyph rectangles, then let the browser lay out the translated paragraph at the source
font, line height and content width. Snap mask edges outwards to device pixels and include one
extra device pixel above/below for font rasterization beyond line boxes (e.g. a descending `p`).
Do not expand horizontal masks into container/icon space. Do not distribute translated characters over source lines or
force line breaks around inline links. Preserve native white-space rules when the result fits;
English words are not broken at arbitrary characters. Keep the source font when it fits. Actual
overflow may use compact leading when a native paragraph/row has enough vertical room, including
word wrapping for nowrap labels. Preformatted `pre` layout keeps its whitespace/leading contract.
Slots are bounded by native content, neighboring glyphs/icons and ancestor clipping.
No source-page reflow is performed. Remaining
overflow triggers whole-paragraph proportional fitting, with a floor of 85% of the original size
and 12 CSS px (never enlarging a source already smaller than 12 px). Explicitly ellipsized source
titles may retain that same truncation behavior, at the source font with full translated hover text.
For other content, if the complete translation
cannot fit readably, leave the original intact and report neutral unsupported, not a model failure.
Keep that validated translation in the completed cache: a larger layout can display it without a
new model call, including after Escape/reopen. Fixed geometry, arbitrary expansion and identical
font size cannot all be guaranteed; this renderer does not reflow the underlying page.

Source text and elements are not replaced. Late results apply only to still-connected, unchanged
source text nodes. A page mutation updates geometry/style without discarding unchanged translations.
Pure position changes reuse the fitted paragraph and glyph-mask nodes, translating their shared
layer from each source's own origin. Window scroll, nested scroll and sticky positioning therefore
do not trigger native text fitting again. Width/wrapping, typography, DPR or background changes
still invalidate layout. This reduces scroll-time reconstruction; it does not promise zero compositor
lag between an asynchronously scrolled page and a JavaScript-positioned overlay.

Simple box-sized static linear gradients use the original CSS gradient, size and position in each
glyph mask, with ancestor/descendant solid colors composed in native layer order. They do not use
a screenshot or a flat sampled color. Textures, special background sizing/attachment/blending and
other complex background effects remain unsupported. For DOM captions over one independently
verified static `<img>`, reuse its URL and native object-fit/object-position geometry beneath the
caption's simple gradients/colors. Verify native paint order and full glyph coverage first; ambiguous
stacking, pseudo-element effects, canvases and unverified/animated backgrounds retain original text
instead of painting a flat white mask. This is DOM text rendering, not a screenshot or an extra
vision-model request. There is no image-internal translation path.
Own overlay mutations are ignored. Source caches keep at most 128 blocks; requests keep at most
32 blocks / 16,000 source characters, with two text slots. Missing, unknown or duplicate output IDs
fail validation. Previews do not enter completed caches. Invalid results cannot poison reopen caches.

## Page context

Immediately before an uncached text request, collect context around the actual requested DOM nodes,
not the current pointer or the start of `body.innerText`. Text uses its source paragraph. Walk the
nearest text on each side up to a character budget, including nearby headings and figure captions. There is no two-block or 1,200-character passage cap.
Sibling traversal crosses ordinary wrappers and adjacent sections but stays inside the nearest
article/main (or body when neither exists).
Hidden content, navigation/menus, forms/editable content and the extension overlay are excluded.
Explicit read-only document islands are included under the same editability rule as translation.

Multiple source neighborhoods share the same 6,000-character `context` budget, with duplicate
passages removed. For a single target, split the available space approximately 3,000 before / 3,000
after; unused space on either side is lent to the other. Page title, a compact current-text
identifier and section labels use this same budget, not an extra allowance. Keep the end of preceding
text and the start of following text, and present each side in reading order. Multiple targets split
the budget equally, so 6,000 is per request, not per target or per side.
Before/after/current scans retain separate node allowances (at most 256 each, 2,048 combined across
at most 32 anchors), including empty and rejected nodes. Traversal depth is bounded too; these guards
can stop a scan before its character allowance fills. No page-wide index, lifecycle observer,
extra model call or pointer-movement context collection is added. Empty context is valid. The
worker still enforces the fixed limit. Context is sent as reference data in user input, never in
system instructions and never as additional translation targets.

Existing source/model/effort/language cache rules are unchanged. Context-only changes do not
invalidate previous translations; refresh the page to recompute them. Distant definitions/headings,
deeply nested layouts and pages whose visual order differs from DOM order can still lack relevant
context. Context does not resolve fixed-geometry layout limitations. More input tokens
can add latency; no live quality/speed gain is assumed without evaluation.

## Bounded requests and background restoration

Text has two concurrent slots, at most 32 blocks / 16,000 source characters per batch, a 6,000-character
shared context limit, and a 60-second model deadline. A timeout retains its `TimeoutError` cause
instead of being mislabeled as an intentional cancellation. Closing, tab navigation and cancellation
abort pending work; no implicit model retries are added.

DOM text positioned over a photograph (for example a news-card headline) is still text. Only when
its glyph rectangles overlap a supported photo does `TranslationBackgroundSources` verify that
background. Ordinary images are not read. The verifier keeps only a bounded source key/static-status
cache; no raster buffers, translations, fingerprints or paint layers are retained. Limits remain
eight background sources, 4 MiB each, 16 million natural pixels and a 10-second read signal.
Unavailable/animated backgrounds are remembered for the session, so they cannot cause a retry loop.

Same-origin/data/blob background validation follows normal page access rules. For cross-origin
HTTP(S) photos, the authorized top-frame `translation.background` message can read an already-loaded
root-frame Image resource via the existing debugger registry. It never fetches arbitrary URLs,
captures the screen or sends the bytes to the model. Each read releases only its own debugger owner.
This narrow helper remains solely to avoid regressing DOM captions onto white masks; the original
image and its internal labels are never changed.

## Verification and remaining limits

Deterministic unit/browser tests use isolated profiles and controlled provider responses. They exercise
the built MV3 extension, request shape, source identity, browser layout, IPC and cleanup; they are
not live provider quality or speed benchmarks.

Text-only regressions assert that a mixed text/image/Canvas page emits text input only, ordinary CDN
images are loaded once and remain pixel-identical, no extension debugger commands are issued for them,
and Escape/reopen reuses completed DOM translations. Streaming completion/failure/cancel, explicit
retry, unrelated successful batches, photo-backed DOM text, source links, context and native screenshot
tools have separate checks. All reusable E2E code remains under `e2e/`.

### Architecture review and deferred work

The request/lifecycle and source/renderer boundaries are reasonable for the current lens. Removing the
parallel image pipeline reduces state and failure paths without adding a new framework, dependencies
or a replacement architecture. The main remaining complexity is **text layout**, not translation calls.
Source discovery now counts filtered/hidden nodes in its 10,000-node visit budget; previously those
nodes escaped the outer walk counter and could cause excessive scans on large pages.

| Remaining case                                                      | Cause and current behavior                                                                                                                                                            | Next step / scope                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chinese → English expands a fixed navigation/card slot              | The overlay cannot reflow the source page. Per-block wrapping/fitting can differ between neighboring labels; unreadable overflow retains the original.                                | Address in the next Chinese-webpage layout task. Native DOM text replacement/reflow for ordinary pages is an architectural choice, not part of image removal. |
| Feishu/Lark partially clipped tables or virtualized document blocks | Conservative clipping excludes non-ellipsis partial text, and only currently mounted DOM is available. Recognized read-only document text is supported, not the whole editor surface. | Verify the real table DOM, then choose a bounded document-specific approach. Do not mutate the collaborative editor to obtain a passing layout.               |
| Complex/animated photo background or compositing                    | A source-anchored mask cannot faithfully reconstruct arbitrary layers. Affected DOM text stays native.                                                                                | Keep the explicit limit; no screenshot, sharing or pixel-translation fallback.                                                                                |
| Context-only changes after a completed translation                  | Cache identity currently uses unchanged source text plus model/effort/language, not all surrounding prose.                                                                            | Refresh recomputes context. A future context-sensitive cache would need bounded invalidation and additional request-cost evaluation.                          |
| Asynchronous scrolling and overlay positioning                      | Position-only changes reuse nodes, but browser compositor scrolling can precede JavaScript positioning.                                                                               | Remaining compositor lag is not claimed fixed by this removal.                                                                                                |

Images and image-internal text are now intentionally outside the feature scope, **not failed or
partially translated content**. They remain native in every state.

Historical image-quality failures remain in local evidence under `e2e/.runtime/`; they are not used
as current text-only success claims. This change deliberately does not claim to fix Baidu/QQ reflow
or Feishu table coverage.
