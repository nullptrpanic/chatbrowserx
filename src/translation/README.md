# Region translation

Build with `npm run build`, reload the unpacked extension, and refresh existing pages once after
updating. Click **区域翻译** beside Screenshot. It uses the configured model, reasoning effort,
token and resolved UI language, without an Agent loop, tools, chat tasks or history records.

## Interaction and guarantees

- The lens is only an observation window. Translations stay anchored to source content; movement
  changes clipping, not the meaning or coordinates of a pending response.
- Nearby HTML paragraphs are coalesced for 150 ms; visual crops use an 800 ms delay. Moving the
  lens does not restart a queued timer. Work reads the current region when the timer fires.
  Both include an 80 CSS-pixel buffer. Complete validated previews can appear before the response
  finishes; **翻译中…** remains until the visible work finishes.
- Ctrl+wheel / compatible trackpad pinch resizes the lens up to the whole viewport. Browser
  toolbar zoom and Cmd/Ctrl-plus retain their normal behavior.
- Escape (with page focus), the toolbar toggle, navigation and tab deactivation close the lens.
  Closing cancels work, but retains bounded completed text/static-image
  translations for this document and the same language/model/effort. Refresh starts fresh.
- There is no screen-sharing action, stream or screenshot fallback. Only readable DOM text and
  verified static images are translated. Unsupported regions remain native and show the neutral
  **部分内容暂不支持翻译，已保留原样** notice after supported work finishes. An empty region is ready,
  not waiting for authorization. Unsupported neighbors never veto independently readable images.
- Failed content waits for the explicit **重试** action. Movement never retries model failures.
  Unrelated successful text/images remain visible. Errors are safe stage/code identifiers, not
  raw model responses, credentials or page content.

## Architecture

| Owner                                        | Responsibility                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `TranslationLensView`                        | Frame, clipping, status, trusted action button and pointer/zoom/Escape input. No capture or model work.    |
| `TranslationDom` + `TranslationTextLayout`   | Complete logical source paragraphs, style identities, bounded source caches and native inline layout.      |
| `TranslationImages`                          | Verified single-frame source bytes, intrinsic-coordinate image patches and reopen cache validation.        |
| Region/paint helpers                         | Bounded static-image crop coverage and patch placement.                                                    |
| `mount-translation-lens`                     | Session scheduling, independent text/pixel work, late-response correlation and cancellation.               |
| `TranslationController` + provider functions | Page-session authorization, bounded original-image reads, configured model requests and streamed previews. |

Data paths:

1. Complete DOM paragraph → text request → validated source IDs/style markers → native inline
   overlay at source coordinates.
2. Verified static image → intrinsic-coordinate cache / missing crop → vision request → image patch.
3. Unsupported painted content → leave unchanged. No frame sampling or model request.

The old `translation.inspect` IPC, translation screenshot backend, shared-tab capture, changed-cell
sampling, CSS snapshot/static-surface guessing and manual source-line text redistribution have been removed. There is one production
path per source type, not a compatibility switch between old and new renderers. Ordinary screenshots
remain independent: they wait for overlay removal to paint, and reject a region if the viewport
dimensions change between selection and capture. Agent browser tools retain their existing path.

## Text layout and source identity

Read complete logical paragraphs, including anonymous inline runs before/after block children.
Do not concatenate unrelated paragraphs across headings or controls. Standalone navigation labels
keep separate native bounds; mixed prose remains one paragraph.
Flex/grid labels use the measured text slot, not the whole container: adjacent icons and their
spacing remain native and are never used as translation space.

Source visibility includes ancestor clipping, not only display/visibility/opacity. Clipped CSS
subtrees, content-visibility:hidden and closed disclosure bodies stay native; a disclosure's
visible summary can still translate. Overflow-clipped text is retained when its full glyph bounds
do not fit the ancestor's painted area. Opening a menu exposes its normal source blocks; closing it
removes all of their layers together (iterate a snapshot, not a live HTMLCollection).

Inline formatting uses locally assigned paired `<mN>` markers. Literal source angle brackets and
ampersands are escaped. Validate balanced, non-duplicated marker identities in preview and final
output. Render only text nodes and locally created spans/anchors; never parse model HTML or use
model-provided URLs. Fonts, colors, link targets and decorations come from original elements.
Normal link clicks dispatch the source link's handler; modified clicks retain native href behavior.
Browser-protected private `:visited` colors cannot be read exactly.

Mask original glyph rectangles, then let the browser lay out the translated paragraph at the source
font, line height and content width. Snap mask edges outwards to device pixels and include one
extra device pixel above/below for font rasterization beyond line boxes (e.g. a descending `p`).
Do not expand horizontal masks into container/icon space. Do not distribute translated characters over source lines or
force line breaks around inline links. Keep the source font when it fits. Actual overflow triggers
whole-paragraph proportional fitting; an unfit result fails explicitly instead of covering the next
paragraph or dropping text. Very long translations may still need smaller type: fixed geometry,
arbitrary translation expansion and identical font size cannot all be guaranteed.

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
other complex background effects remain unsupported.
Own overlay mutations are ignored. Source caches keep at most 128 blocks; requests keep at most
32 blocks / 16,000 source characters, with two text slots. Missing, unknown or duplicate output IDs
fail validation. Previews do not enter completed caches. Invalid results cannot poison reopen caches.

## Page context

Immediately before an uncached text or image request, collect context around the actual requested
DOM nodes, not the current pointer or the start of `body.innerText`. Text uses its source paragraph;
images use the captured source `<img>`. Walk the nearest text on each side up to a character budget,
including nearby headings and image captions. There is no two-block or 1,200-character passage cap.
Sibling traversal crosses ordinary wrappers and adjacent sections but stays inside the nearest
article/main (or body when neither exists).
Hidden content, navigation/menus, forms/editable content and the extension overlay are excluded.

Multiple source neighborhoods share the same 6,000-character `context` budget, with duplicate
passages removed. For a single target, split the available space approximately 3,000 before / 3,000
after; unused space on either side is lent to the other. Page title, a compact current-text/image-alt
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
context. Context does not repair OCR omissions or unsupported image-label layout. More input tokens
can add latency; no live quality/speed gain is assumed without evaluation.

## Bounded image requests

Only verified original-image PNG crops cross to the worker. A model crop remains within 1200×800 CSS pixels; a large
lens fills multiple crops. There is one pixel request alongside up to two text requests. Requests
from an obsolete session cannot cancel a current session's work. Partial valid vision blocks may
display. Explicit model `incomplete: true` and rejected malformed blocks leave an incomplete state,
not false completion; they do not cause automatic retry loops. Only recognized label regions are
handled in such a response, including notation deliberately left native. Omitted text that the
model does not report cannot be detected reliably by this single-call pipeline. No second OCR or
verification-model request is added.

The same image request distinguishes ordinary text from notation with an optional
`kind: "text" | "notation"` field. Notation (including uncertain chart abbreviations) stays native,
even if a model supplies a translation. Numeric-only text, underscore-separated metric keys and
unchanged text are also protected locally. The classification is model-provided; this is not a
guarantee of perfect OCR or semantic classification, and legacy responses without kind remain valid.
The prompt explicitly includes horizontal axis captions and every legend entry. A natural-language
label containing abbreviations is `text`: translate its words while keeping unresolved symbols inline.
Only standalone notation is wholly retained. Ask for concise, faithful labels to reduce layout pressure.

Only horizontal, readable image labels are painted. Tall/rotated boxes remain native, and the
background margin is at most one displayed CSS pixel per edge, not proportional to the box height.
Fitting may reduce the estimated source size by at most 35%, with a ten-CSS-pixel floor; otherwise
the original pixels remain untouched. This admits readable expansions such as a 60×20 box containing
four CJK characters at about 15 px, which the previous 80% minimum incorrectly rejected. Width fitting
uses fractional `Range.getBoundingClientRect()` glyph bounds converted from viewport coordinates back
to intrinsic image pixels, not integer `scrollWidth/clientWidth` or half-pixel compensation. Keep the
line vertically centered in the original box;
neither the mask nor its coverage expands. These intentionally retained labels count as handled regions,
so they cannot trigger a translation retry loop. Image geometry and intrinsic caches are unchanged.

## Static image reuse

Use source bytes for untransformed, unfiltered images with `object-fit: fill`, `cover` or `contain`.
For cover/contain, support computed two-axis percentage or pixel `object-position` values. Separate
the raster's scaled/offset rectangle from its clipping content box; only visible intrinsic pixels
enter requests and coverage. Letterboxing is not image content. Padding and borders are excluded,
and patches retain the inner rounded-corner clipping even when the raster extends outside the box.
Geometry changes reuse intrinsic patches; newly revealed source pixels still need translation.
Native `ImageDecoder` metadata must prove a single frame. Same-origin and data/blob sources follow
normal page access rules. For cross-origin HTTP(S) images, the enabled top-frame session requests
already-loaded root-frame Image resources through the existing debugger registry. The reader uses
`Page.getResourceTree` and `Page.getResourceContent`; it never fetches arbitrary URLs or captures the
lens. This uses the extension's existing debugger permission, without a screen-sharing picker.
Bound loading to eight sources, 4 MiB each, 16 million natural pixels and a ten-second operation
signal. Closed sessions cancel image reads; each read releases only its own debugger owner.
Unsupported sources remain unchanged; there is no hidden screenshot or sharing fallback.

Completed patches are stored in intrinsic image coordinates. Scrolling/resizing only reprojects
them. Newly exposed source regions still require translation. Closing drops source blobs and pixel
buffers; reopening checks metadata, composited background and SHA-256 before
reusing bounded completed patches. Changed or unreadable sources never restore stale patches.
For same-origin fetches, fingerprint actual displayed pixels; a refetch need not match a previously
loaded image. For CDN resources, fingerprint the browser's loaded bytes without reading a tainted
DOM canvas.

If scrolling invalidates an in-flight original-image inspection, schedule a fresh inspection after
that read settles. The source cache reuses valid loaded bytes; an unavailable unchanged source does
not cause an automatic retry loop. Image load events are observed on Document, not Window, so
late completion/replacement invalidates the affected image even without pointer movement.

## Verification and remaining limits

Deterministic unit/browser tests use isolated profiles and fixed provider responses, with no
capture picker-selection flags. They exercise actual layout, compositor,
extension messaging and cleanup. They are not live provider speed or translation-quality benchmarks.

Regression coverage includes whole-paragraph fonts/wrapping at multiple widths, source links,
literal/invalid style markers, delayed responses, streaming/error isolation, Esc reopen, static
image movement, cover/contain crop pixels and clipping, gradient mask pixel comparisons, viewport
changes, mixed supported/unsupported content, source replacement and resource release.
Unsupported Canvas/video/CSS/iframe/fixed-gradient/scale-down-image cases must leave
independent DOM and static-image work usable, never open a sharing dialog, and retain valid results
on Escape/reopen. Reusable E2E tests and their helpers live under `e2e/`.

Complex image backgrounds still use approximate local background sampling and model-supplied OCR
boxes; exact image reconstruction is not promised. Static decoding requires the browser's native
ImageDecoder. First-time model latency remains; engineering improvements reduce repeat
work and visible instability, not the provider's time to first output.

### Explicit bad cases

The following are bounded product limits, not successful full translations. Do not remove their
safety checks or add a lens-hiding fallback to make an acceptance test pass.

| Scenario                                                                                                                     | Current behavior and cause                                                                                                                | Verification / why retained                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Textured/radial/specially sized or fixed backgrounds; transforms/filters; other image fit modes or complex `object-position` | Conservative classification leaves affected subtrees native. Ordinary static linear-gradient text and cover/contain images are supported. | Unit/browser cases distinguish supported geometry from fixed-gradient and scale-down limits. No general CSS compositor or screenshot fallback is added.                          |
| Image inside a gradient-backed ancestor                                                                                      | Keep the image native while translating readable sibling text. Original-image compositing currently knows solid backgrounds only.         | A regression verifies independent text still works. Detecting opaque images or reconstructing transparent raster backgrounds is deferred, rather than inventing a flat backdrop. |
| Video, Canvas, CSS animation or iframe                                                                                       | These pixel-only sources remain native, even after becoming still. Independent DOM text and verified images continue normally.            | Shared capture was explicitly removed; no sampling/settling loop, automatic screenshot fallback or per-frame model requests remain. Browser tests cover all four source types.   |
| Complex texture behind text inside an image                                                                                  | Background masks approximate a local color; texture and OCR boxes can remain imperfect.                                                   | This is a rendering limitation, not an asserted image-quality pass. Exact inpainting would require another reconstruction pipeline; no such pipeline is included.                |
| Rotated chart axes, tiny image labels, or image translations that cannot fit readably                                        | Keep original labels, ticks and symbols; do not expand masks or shrink text indefinitely.                                                 | Unit and browser pixel comparisons cover retained labels and bounded normal fitting. General rotated OCR/reconstruction is not added.                                            |
| Very long translation in a short fixed source block                                                                          | Fit the whole paragraph if necessary; reject if it still cannot fit. Original geometry is not expanded to cover neighboring content.      | Fixed geometry, arbitrary language expansion and identical font size cannot all be guaranteed. Normal paragraphs/inline links have native-browser layout regression tests.       |
| Protected media, inaccessible images, unsupported ImageDecoder                                                               | Leave the affected content unchanged. Other readable sources continue; no covert screenshot fallback.                                     | Mixed-source tests verify unavailable images cannot block readable ones. DRM-specific media has not been live-verified and is not counted as a tested success.                   |

Before shared capture was removed, an exploratory root-capture/top-layer-lens alternative could preserve some gradients, but failed to
produce a fresh frame for several solid/mixed-background or transformed-root fixtures. It is not a
production fallback. Historical failed probes and follow-up measurements remain preserved under
`e2e/.runtime/translation-native/`.

The 2026-09-12 live Minify diagnostic also reproduced the image-background limit: the embedded
Code Golf screenshot's green **Ask Question** button lost its green fill under the translated patch.
The model's box includes neighboring white pixels, biasing the sampled mask color. This is an
explicit visual bad case, not a translation-success claim. See the original and translated images
in `e2e/.runtime/translation-minify-2026-09-12T08-51-49-321Z/`.
