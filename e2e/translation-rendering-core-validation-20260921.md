# Generic text-translation rendering core — 2026-09-21

Status: common rendering fix implemented and verified on the frozen animation candidate:
219 browser tests, 1,748 unit tests and the five-site interaction matrix. Acceptance is bounded
by the approved native/dynamic mixed-widget fallback; hao123 is not claimed as zero-omission
translation of every page-header widget. Details and failed evidence are retained below.

## Scope and baseline

The approved design is `docs/superpowers/specs/2026-09-21-translation-rendering-core-design.md`.
Implementation follows `e2e/translation-rendering-core-plan-20260921.md`. Work stays in the existing
`feat/refactor_dev` checkout, without commits, pushes, additional dependencies, permissions or agents.
The inherited uncommitted fixes are preserved. HEAD is
`d503bbb9b9d8081e126e427aabf9903002558350`; HEAD alone does not identify this dirty candidate.

The pre-change source archive, hashes, status and all failed/green logs are retained locally in
`e2e/.runtime/rendering-core-20260921/`. Initial translation unit tests passed 185 cases; the initial
geometry/native/document browser baseline passed 43 cases. These baseline passes are not credited
as acceptance of the new implementation.

## Changes and deletion audit

| Responsibility          | Change                                                                                                                                                                                      | Preserved boundary                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Geometry and visibility | Batch-local `translation-geometry` copies primitive facts and returns visible, hidden or uncertain results. DOM collection, context and structural paint use the same clipping calculation. | Unknown shapes retain native protection. Proven empty clips do not become obstacles. Absolute/fixed containing blocks and fractional coordinates are handled explicitly. |
| Text layout             | `translation-text-constraints` reads source label/row budgets before writes, then applies one policy to inline, float and flex copies.                                                      | Prose reflows. Native fonts, decorations, padding, explicit widths and multi-line clamps remain protected.                                                               |
| Repeated layout patches | Removed `constrainCompactText`, `constrainLabelText`, `constrainLinkRows`, `constrainFloatColumns`, `clipToParents`, DOM `clippingParents` and the alternate post-collision compact pass.   | Structural subdivision, blank-backing cutouts, watermark copying, safe-copy sanitization and live-surface protection remain.                                             |
| Dynamic changes         | Shared appearance-property predicate and inline-style classifier; existing DOM/session owners retain identity, deferral and generation state.                                               | Static resize/typography is not motion. Actually changed/moving text still requires Alt/Option+R. No automatic retry loop.                                               |
| Attribution             | One rejection map carries opaque source IDs and geometry/native/peer/budget/copy reason codes. Existing local diagnostics inspect it.                                                       | No raw source text, private URLs, model responses, telemetry or public protocol changes. Model failures remain separate.                                                 |

The renderer has no Baidu, QQ, hao123 or Lark hostname/title conditions. The existing document
read-only/editability and watermark adapter remains: it protects document safety, not site-specific
layout. The source page is never patched. No image translation or OCR path is restored.

Not every existing rendering rule is redundant: passive image copying, original scrollports,
buttons' native minimum heights, inline navigation's natural growth and source-ordered painting
have distinct responsibilities and protection tests. They were not deleted merely to reduce lines.

## Failed candidates and corrections

- Shared geometry initially omitted the empty-overflow fact used by mutation filtering. The wider
  102-case baseline found one unnecessary rebuild. Restored the local box fact without treating it
  as inherited descendant clipping: positioned descendants can escape an intermediate scrollport.
- First common-budget candidate passed 90/102 cases. Blockifying ordinary inline text displaced
  ranks/separators, and using occupied lines instead of declared clamps truncated multi-line
  titles. Retained the failed screenshots/traces and corrected formatting and line-budget ownership.
- Later candidates exposed parent budgets erasing child maximum widths and inner labels reserving
  padding twice. Restricted budget inheritance to its actual formatting context. Parent block
  constraints no longer erase independently bounded descendants; atomic ellipsis wrappers share
  their budget rather than reapplying the original Chinese label width.
- The new zoom fixture initially positioned the pointer before opening the lens, whose constructor
  centers itself independently. That was a test setup error; moving the pointer after opening
  correctly exercises the requested narrow-lens scenario. No product workaround was added.
- A new rejection-attribution assertion failed before the map existed, then passed with an actual
  peer-conflict reason. Removing the independent native obstacle paints the cached translation
  without another model call and clears the old reason.
- The first complete 201-case browser run passed 199 and failed two retained cases. The shared
  reveal calculation had traversed into the extension's own rounded lens and rejected it as an
  unsupported source shape; it now stops at the owned copy layer and uses the caller's observation
  rectangle. The other failure required nested inline labels inside an actual flex row to receive
  an ellipsis box, while converted inline rows still retain their original inline formatting.
- The corrected full browser suite passed 201/201. The frozen Wiki live run nevertheless exposed
  native-overlap rejection of nine ordinary text IDs at 125% browser zoom after selecting text
  and shrinking/moving the lens. Initial heading/table paint was correct, and restoring zoom
  recovered some text, but this is not a live pass. A generic sliced document flow with an
  independent native toolbar reproduces the omission without a Lark hostname or document markup.
  The failed live screenshots and native-flow RED trace are retained before correction.
- A temporary, local, text-free collision probe identified an absolute selection tooltip as the
  actual foreground. Removed the probe after diagnosis. The fix extends the existing foreground
  cutout owner to original-overlapping absolute native overlays, preserving paint order and current
  source clipping. A neighboring media surface reached only by translated growth still rejects
  unsafe paint. The generic RED fixture is retained, with native-pixel equality, readonly-source,
  pointer-transparent tooltip and browser-zoom variants.
- The pointer-transparent scaled-tooltip pixel test also exposed an existing collection gap:
  unsupported composited ordinary DOM was marked unsupported but not always retained as a native
  obstacle. It now follows the same native boundary as other unsupported paint. Its actual inner
  pixel rectangle is used for equality (the first fixed crop extended outside the scaled box).
  Both native fixtures pass, including zoom/cache/source assertions. Fractional subtraction
  invariant tests already pass; no speculative rounding or epsilon change was introduced.
- The next full Wiki run still rejected the selected/refreshed body. A second generic RED
  fixture reproduced this with a bordered `overflow:hidden` foreground inside a transformed
  portal. Own overflow was incorrectly clipping the element's painted border as if it were
  descendant content, leaving a thin uncovered native obstacle. The shared geometry now clips
  descendant content at the padding edge but retains the element's border; explicit clip paths
  and ancestor clipping still apply. The unit fixture first needed explicit overflow longhands
  for JSDOM, then failed on the actual border contract before the product fix. The real browser
  fixture failed with zero translations before, then passed text, exact native pixels and source
  immutability after correction. The unchanged 49-case native/document/portal suite also passes.
- The identical full Wiki replay `lens-translation-lark-wiki-readable-1789986497505` now retains
  55 displayed spans before/after selection + refresh, nine at 125% zoom, eleven after restoring
  zoom, and twenty on each of three subsequent reopens. No stage has a layout rejection. The
  selection toolbar/tooltip remains native; its unsupported notice is not an omitted body.
  Initial, refreshed, zoomed, restored and table screenshots were visually inspected. This
  closes the previously reproduced native-overlap loss, not a claim about all websites.
- Docx diagnostic `lens-translation-lark-readable-1789986773300` did not reach translation:
  the supplied exact anchor was “功能需求”, while the observed current heading is “功能要求”.
  Readiness/authentication passed; source-after screenshot and the timeout are retained.
  Correcting that diagnostic argument does not change product logic or visual acceptance.
- Baidu ownership correction removed ordinary headline rejection, but live run `1789987810184`
  still failed visual acceptance: a 367px row's link was capped at 100px. The bounded mirror
  inspection in `1789987932431` and a generic percentage-width RED fixture identify the same
  cause: `parseFloat("100%")` was interpreted as a pixel maximum. CSS now combines the measured
  source budget with the original unit-bearing maximum; intrinsic keywords use the already
  measured source budget. Percentage, em, calc, intrinsic and unconstrained variants are covered.
- The next Baidu run `1789988337859` uses the row width correctly, but exposed an unrelated
  vertical shift of translated badges. A generic inline badge RED fixture measured an 11.328px
  upward shift. The budget code was overriding the copied `vertical-align` with `top` on every
  inline-block label path. Removed that override; original middle/baseline alignment remains
  owned by source CSS. This is a deletion of an over-broad layout patch, not a badge/site adapter.
- QQ full run `1789988892557` still omitted 11 ordinary headline/list entries, including after
  manual refresh. It also cropped the second line of some photo captions. Source inspection
  `1789989131897` and a temporary bounded collision probe `1789989370848` distinguish these
  failures from model omission or dynamic text. The top 243px section grew to 328px and reached
  the following independent row. Per-label allowances did not account for collective growth.
  Separately, wrapper line-height was 18.4px while nested headlines used larger typography.
  Calculating a caption height with the wrapper's leading chopped a text line in half.
- Four hostname-free fixtures fail before the correction: bounded headline columns, a caption
  with larger nested font/leading, fixed 40px height with 24px text leading, and maximum 40px
  height with that leading. The common constraint owner now measures actual text leading,
  limits explicit heights to complete lines, and includes independent peer flow in the source
  budget. If compact labels' combined potential growth cannot fit before a peer, they retain
  original occupied line counts with native ellipsis. Absolutely positioned captions and
  unbounded prose are not subject to that collective cap. All four fixtures pass afterwards.
  The product collision hook and its diagnostic setup/readback are removed before validation.
- Hao123 budget replay `1789990797880` loses the ordinary link grid at browser zoom and stays
  untranslated after restoring zoom; Alt+R recovers it. No layout rejection or failed request
  explains this. Inline-style observation `1789991358388` does **not** prove a responsive
  positional update: it records actual unrelated tickers. The first deferral probe
  `1789991714678` saturated on repeated early observations; the bounded/deduplicated zoom
  probe `1789991999177` identifies the actual cause: Chromium emits `transition:all` effects
  for border/outline/rule widths on zoom, which the classifier permanently treats as live text.
- The hostname-free `translation-zoom-transition` fixture fails with zero translated spans
  before correction. Keyframe evidence shows border transitions with identical start/end
  values, plus quantized default outline/rule widths whose styles are `none`. The shared
  animation reader now ignores unchanged CSS transitions and unpainted decorative widths.
  Actual visible-width, transform, opacity and content motion stay live; no viewport timeout,
  resize exemption or second dynamic state machine is added. All temporary product/diagnostic
  hooks are removed. The real visible-border control initially read its request count before
  the existing debounce sent the explicit refresh; awaiting that exact count fixes the test
  synchronization without changing product behavior or weakening its assertion.

## Deterministic verification

- Geometry/parser/region tests: 24 passed (final border candidate).
- Translation units after the new lifecycle/style cases: 207 passed, 15 files.
- Double explicit refresh plus out-of-order old results: current source/ID only; three requests.
- Narrow lens + browser zoom + viewport/typography changes: static heading remains translated
  without another model call; neighboring moving track still needs manual refresh.
- Common-budget browser suite: 103 passed, including native icons, inline/flex/float formatting,
  tables, read-only document runs, source immutability and native-media protection.
- Complete unit suite: 1,748 passed in 141 files on the current frozen animation candidate
  (`full-units9.log`).
- Full browser gates: 201 and then 203 passed on earlier candidates, before the next live
  regression was reproduced. The border-corrected candidate passed 204/204, and the subsequent
  ownership/width/alignment candidate passed 213/213, before QQ's live defects were discovered.
  The budget candidate passed 217/217 before hao123 exposed the zoom classification defect.
  The current frozen animation candidate passes **219/219 in 7.6 minutes**, including
  typecheck/build (`full-browser9.log`). Earlier passes are not substituted for this fresh gate.
- Current-candidate formatting, zero-warning lint, bundle audit, sandbox integration check,
  catalog validation and `git diff --check` passed (`*9.log`). Documentation is checked again
  at handoff. Bundle/source hashes are `frozen-animation-candidate-sha256.txt`.

Line count is not the success criterion: compared with the archived pre-turn state, the main
structural renderer falls from 2,234 to 1,760 lines, while all page-translation TypeScript grows
from 4,012 to 4,218 lines (+206). The new shared contracts replace repeated decision paths, but
also make geometry/native protection explicit. This is consolidation, not a claim of fewer
total lines.

## Final-candidate live observations

These are authenticated native-feature diagnostics, not WorkSession benchmark attempts. Each
uses the canonical Profile and standalone readiness verification, serially on the same frozen
bundle. Passes apply to the inspected content and interaction matrix, not every possible page.

Baidu `lens-translation-baidu-readable-1789987155968` failed: navigation was translated but 25
ordinary hot-search text IDs were rejected as native-overlap, including after explicit refresh.
A text-free local probe in `1789987352888` found a 15×18 CSS-rotated static icon already owned by
the same safe readonly copy. This is a collection/render ownership mismatch, not a dynamic region
or model omission. Preserve both runs. The 204-case gate above precedes this newly found defect.
Three generic rotated/filtered/blended-decoration browser cases fail before correction. The
renderer now derives external native obstacles from the actual safe copy map, not just subtree
membership. Already copied static decorations belong to that flow; live media, unknown clip
shapes, shadow roots and independent fixed surfaces cannot enter the map. The temporary probe
was removed. A callback narrowing type error was corrected by capturing the completed copy map
before filtering; no optional access or weakened guard was added.

| Page                          | Current frozen evidence directory under `e2e/.runtime/` | Observed result                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QQ                            | `lens-translation-qq-readable-1789992944801`            | Pass for ordinary DOM: initial/refreshed headline columns translate; photo captions show complete lines. 88/85 initial/refreshed spans; ten at 125% zoom, seven restored; nineteen on each reopen. Zero layout rejections in all fourteen stages. Native banner/video pixels remain original.                           |
| Baidu                         | `lens-translation-baidu-readable-1789993223211`         | Pass: navigation, single-row hot headlines, badges and their source fonts/alignment. 38 initial/refreshed spans; eleven at 125% zoom, five after restoring to the smaller lens; fifteen on each reopen. All fourteen stages have zero layout rejections. Source input/placeholder and image pixels remain native.       |
| Wiki, selected “3.1 模块划分” | `lens-translation-lark-wiki-readable-1789993347747`     | Pass: heading, body and table; 55/55 initial/refreshed spans, 64 scrolled, nine at 125% zoom, eleven restored, twenty on each reopen. All fourteen stages have zero layout rejections. Native selection toolbar/tooltip and diagram pixels remain.                                                                      |
| Docx, “功能要求”              | `lens-translation-lark-readable-1789993570459`          | Pass: four-column requirement table, cells, headings and prose. 27 initial/refreshed and 38 scrolled spans; three at zoom/restored, eight on each reopen. All fourteen stages ready with zero layout rejections. No font shrinking or source editing.                                                                   |
| hao123                        | `lens-translation-random-hao123-1789993739964`          | Main navigation grid/news and zoom pass: 138 initial/refreshed spans, 19 in the moved lens, 18 at 125% zoom, 19 restored without refresh, 48 on each reopen. All fourteen stages settled with no layout rejection in this page variant. Native/dynamic page-header limitations in other variants remain explicit below. |

### Hao123 header variants and bounded fallback

The failed budget run `1789990797880` remains a failed run; its ordinary grid disappeared at zoom.
Both final-candidate full runs `1789992689666` and `1789993739964` retain the grid at 125% zoom and
after restoring zoom, **before** manual refresh. Their screenshots were inspected. The earlier
zoom disappearance is therefore closed by the common animation classifier, not by refresh.

The first final-candidate page variant (`1789992689666`) still has two `unsafe-copy` weather IDs;
after scrolling, four additional page-header IDs have `native-overlap`. Initial, refreshed,
scroll-back and zoom screenshots are retained. The following variant (`1789993739964`) has zero
layout rejections throughout, but that does not erase the earlier variant's fallback.

A bounded repeat with `CHATBROWSERX_LENS_INITIAL_ONLY=1`, `CHATBROWSERX_LENS_INSPECT_TEXT='云'` and
`CHATBROWSERX_LENS_INSPECT_POINT='515,38'` reproduces the two weather rejections in
`1789994117797`: inspected request IDs `text-54` / `text-170` match `unsafe-copy`. Their source
anchor includes an independently clipped, relatively positioned track containing absolutely
positioned, moving temperature/air-quality text. The second row has the same track structure.
These are the approved dynamic mixed-widget boundary, not a failed model request or missing grid.

The four older `native-overlap` IDs belong to the logo/homepage and city/weather header islands,
not the ordinary news/grid body. Source inspection records a native logo iframe at
`(125,8,216,65)`, while the homepage mirror occupies `(125,28,201,34)`; the city/weather mirror
extends to y=88 beside a native search input starting at y=86. These explain why those islands
cannot be treated as unconstrained prose. The exact individual native rectangle that fired each
older rejection was not recorded, so this report does **not** claim every header label is fixed.
The approved policy retains unsafe native-mixed islands rather than covering the input/iframe.
No site-specific exception, automatic dynamic retry or new rendering path was added to force them.

Thus hao123's main text and zoom scenario pass; its native/dynamic header is a documented limit,
not a claim of complete translation of all live widgets. Alt/Option+R re-collects current text;
continuously moving tracks or islands that still intersect live controls can remain original.

QQ's scrolling probe matched 12/12 groups, measured 166 frames and 32 scroll events with zero
recorded offsets/replacements. Wiki matched three groups (one unmatched), measured 132 frames and
32 events with zero matched offsets/replacements. Docx's one group was ambiguous and none matched:
its zero counters are **not** evidence of zero-lag scrolling. Baidu fit the viewport and generated
no actual scroll events, so its zero counters are not credited as a scrolling pass. All four
stationary probes observed 241–242 frames without mirror replacement or hidden frames. Continuous
scrolling is also exercised by deterministic source/mirror and overflow/watermark browser tests.
Hao123's last full run matched 60 groups (one unmatched), observed 101 frames/33 scroll events
and no measured matched offsets or replacements. Its 234-frame stationary sample has no hidden
frames or replacements. These short observations are not a performance benchmark or a guarantee
against asynchronous browser-compositor lag.

The broad live source snapshot includes parent text of page-owned asynchronous UI, not just
document content: Wiki reports 11 text changes/8 disconnected nodes and Docx 13/0, both with zero
inline style changes. These aggregate counts are not used to claim exact source immutability.
The source-after readbacks retain the original Chinese document; exact source DOM and draft
immutability is checked independently in deterministic fixtures. The diagnostics perform no
editor text input or document save operation.

QQ's 541-node source snapshot has zero text/style changes and five page-owned disconnected nodes;
Baidu's 152-node snapshot has zero text/style changes or disconnected nodes. Actual successful
requests all include bounded page context in the input payload and no images: QQ ten requests
(652–1,369 context characters), Baidu five (425–967), Wiki nine (570–1,303), Docx seven
(727–1,390); hao123's final full run has fifteen successful requests (644–1,167), all without
images. Its broad source snapshot has zero text changes/disconnections and three page-owned
inline-style changes. HTTP completion is recorded separately from visual acceptance.
Context is reference data, never promoted to trusted instructions; the shared limit
is 6,000 characters in total, not 6,000 on each side. Model use of particular terminology cannot
be proven solely from the presence of this payload.

## Review and acceptance boundaries

The user prohibits subagents. Review is therefore an explicit author self-review, not independent
approval. Review covers source/copy separation, generation/cache ownership, node budgets, private
content filtering, preserving native surfaces, deletion parity and the complete frozen build.
No schema, provider, public configuration or compatibility migration is introduced.

Canvas/whiteboard pixels, unmounted virtual content and continuously changing text remain outside
the approved automatic translation behavior. Static ordinary DOM omissions are not reclassified
as those limits. A completed model request or ready/unsupported status alone is not a visual pass.
The previously observed small-lens + zoom loss on Wiki/hao123 was inspected on the final frozen
build before refresh and did not recur. This does not promote the documented unsafe header
widgets, native media pixels or unmounted content to supported ordinary text.

Final bundle/source hash verification passed against `frozen-animation-candidate-sha256.txt`.
No product changes or rebuilds occurred during the final live matrix. All changes remain
uncommitted and unpushed; load the rebuilt `dist` and refresh existing source tabs to use this
candidate instead of an already injected older content script.
