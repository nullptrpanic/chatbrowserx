# Translation lens structured-layout validation

Status: structured layout implemented on 2026-09-16, with coverage/scroll corrections on
2026-09-17. Real-provider access was restored in the later browser-only recheck. That recheck
found an additional source-overflow footprint defect on a narrow document viewport; the correction
and its validation are recorded below. Earlier HTTP 401 failures remain preserved, not passes.
Observed results apply to the tested regions, not to every element or every future state of these sites.
Follow `AGENTS.md`, `RUNBOOK.md`, `SAMPLE_SPEC.md`, and `EVALUATION_STANDARD.md` for every run.

## Baseline

Frozen product: `d503bbb9b9d8081e126e427aabf9903002558350`.
Local native-feature evidence is indexed by `.runtime/translation-format-baseline-20260916.md`.
The Baidu and Lark native lens diagnostics fail user-visible layout expectations even though their
model requests succeeded. The HF diagnostic covers one stationary prose section only.

Existing Agent samples that answer a translation question through browser tools do not test the
translation lens. Do not count their final-answer checks as lens-format acceptance. Native lens
diagnostics must use the shared authenticated Profile and readiness path; do not invent a second
authentication mechanism. Any reusable instrumentation, sample support, or browser test belongs here
under `e2e/`. Standard WorkSession evaluations still use only `samples/<id>/benchmark/` reports.

## Required target coverage

| Page                               | Areas                                                                               | Required visible behavior                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baidu                              | Top navigation, recommendation strip, hot-search columns, badges                    | Native text size; no letter-by-letter wrapping; source single-line ellipsis retained; badges/icons do not overlap labels; no unexplained Chinese fallback after successful translation |
| QQ                                 | News cards, photo-backed DOM captions, lists                                        | Text remains sharp DOM text at source font sizes; native backgrounds compose correctly; no white masking blocks; no coverage regression                                                |
| Feishu/Lark user-supplied document | Headings, prose, visible table cells, sticky headers, horizontal/vertical scrolling | Coherent table rows and complete body text; clipped cells can translate without escaping the scroller; no overlapping sticky/body text; watermark retained; no source document edits   |
| Hugging Face safety article        | Navigation, headings, linked prose, lists                                           | Inline links/styles retained, no artificial paragraph splitting or random font fitting, unchanged image-internal text                                                                  |
| JWT                                | Navigation and readable DOM text around the tools                                   | Source layout/styles retained; editors/input values are excluded; no flicker, source mutation, or unintended tool execution                                                            |
| Python interpreter article         | Navigation, linked prose, headings                                                  | Extra regression for mixed inline styles; images remain untranslated                                                                                                                   |

Literal news headlines are dynamic. Freeze each attempt's source text, element identities, geometry
and translation results for its coverage/layout comparison; do not compare unrelated live headlines
as a performance or quality improvement. Brand names, numbers, identifiers, already-target-language
text and deliberately excluded image/editor content are not missing translations.

## Deterministic browser regressions

Use the existing built-extension Playwright fixtures and controlled provider only for deterministic
layout/lifecycle checks. Add failing cases based on the preserved defects before production changes.

- Long English navigation labels and headline peers keep source font size and intended single-line
  behavior; test source ellipsis, word boundaries, badge reservation and trusted source links.
- Prose with long English output reflows in a common layout group without colliding with the next
  paragraph. Same-style peers are not fitted to different font sizes.
- Narrow multi-column tables grow coherent rows; retain column widths, colspan/rowspan, border and
  header semantics. Include a partly clipped cell, sticky header and nested horizontal scroller.
- Source hidden menus/disclosures never appear. Opening/closing a disclosure updates only its group.
- Capture source text/style attributes, source boxes and input values before/after translation;
  creating the extension host is allowed, writing source nodes is not. Include a writable-looking
  document fixture and a separate real draft that must remain excluded.
- Model strings containing markup/scripts cannot create executable DOM. Source script/event/editor
  attributes are not copied; model URLs cannot become links; internal marker validation remains.
- Translation display is clipped to the lens; pixels and source layout outside it remain unchanged
  on a frozen synthetic page. Images receive no translation request, OCR, screenshot or sharing flow.
- Move/resize the lens, scroll the window and nested containers, complete a delayed old response,
  change source text, close/reopen, and change language. Assert source correlation, bounded caches,
  no duplicate requests for completed text, and no display clearing while work is pending.
- Read screenshot evidence as well as geometry. Stable synthetic cases should include 1440 and
  1024 CSS-pixel widths, fractional dimensions and DPR 1/2. These are layout checks, not claims that
  every CJK character uses the same physical font file as Latin text.

## Live acceptance and limitations

Run the canonical doctor/setup-if-needed/standalone-verify/live sequence. Use real provider output
for each requested page and inspect the final screenshots/DOM, not only request status. Preserve
all failed evidence. Private document diagnostics retain structural counts/IDs and local screenshots,
not request credentials or private raw request/response payloads in ordinary reports.

For each tested viewport/region, distinguish collected targets, validated translations, displayed
translations, explicitly unchanged text and unsupported/failed text. A `ready` status is not enough.
Record actual font sizes, line/clamp behavior, source/translated boxes and clipping ownership.
Check visible overlap and omission, and verify the original document remains unchanged.

Test more than a stationary first frame: lens movement, resize, scrolling through the affected
table/list, Escape and cached reopen. Do not claim universal stability from a single successful run.
Any untested target/region must be reported as untested rather than included in a blanket pass.

Run the repository gates from `EVALUATION_STANDARD.md` after narrow checks. They are necessary but
not substitutes for the real-page acceptance above. Do not weaken a fixture or acceptance criterion
to accommodate the candidate renderer.

## Implementation and evidence scope — 2026-09-16

The candidate replaces glyph masks and individual font fitting with bounded, inert structural
copies. It preserves source typography, native ellipsis, inline links, table columns/rows and
source scroll clipping. There are no hostname or site-class rules in the renderer. The pre-existing
Lark discovery/editability/watermark adapter remains a safety boundary, not a layout override.

The user explicitly accepted keeping unsafe mixed live-media regions original. No video/Canvas
placeholders or source DOM modifications were introduced. The model path is text-only; the unused
background-byte/debugger request path is deleted. Context remains source-anchored untrusted user
input with a 6,000-character total budget per request.

Real diagnostics use `diagnostics/translation-lens.ts`, the shared authenticated Profile,
`withExistingLiveSession`, the catalog target and inline environment verification. Doctor and
standalone verification were completed before the live sequence (see the local baseline index).
The diagnostic restores language settings and closes the lens in `finally`. No credentials or
private raw source/model text are persisted in its JSON. Private screenshots stay local/ignored.
These are native-feature diagnostics, **not WorkSession benchmark pass rates**.

### Observed real-page results

All directories in this section are relative to `e2e/.runtime/`. Each includes original and
translated screenshots plus `evidence.json`. Human inspection supplements geometry/status checks.
The final frozen page bundle is `page-content.iife.ts-BwC7GPfe.js`. Every row except the supplemental
Lark 1440-pixel run was replayed with that build after the last product change; no builds or product
edits occurred during a live run.

| Page / viewport             | Evidence directory                              | Observed result and boundary                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baidu / 1440 × 900          | `lens-translation-baidu-readable-1789556761847` | Readable source-size navigation, hot-search single-line ellipsis, badges, recommendation strip and button. 40 displayed spans initially, 2 requests, none added by Escape/reopen. Logo/image text and input placeholder remain original by design.                                                                                                                                                                           |
| Baidu / 1024 × 900          | `lens-translation-baidu-readable-1789556502246` | Same single-line/word-boundary behavior at narrow width; no tiny fitted fonts. 37 displayed translated spans before lens movement, 3 requests total. Stationary observation: 241 frames, 0 hidden frames, 0 replaced groups.                                                                                                                                                                                                 |
| Lark / 1440 × 900           | `lens-translation-lark-readable-1789552449144`  | Visible table cells translate together, rows grow coherently, native column widths/overflow and watermarks remain. Prose moves with the table. Scroll down/back, cached reopen, resize/move checked. 40 displayed spans initially, 33 after scroll, 4 requests total.                                                                                                                                                        |
| Lark / 1024 × 900           | `lens-translation-lark-readable-1789556578274`  | Partially inset-clipped tables remain present. Horizontal panning preserves left columns, opaque backing and watermark without original-text bleed-through. 27 spans initially, 24 after vertical scroll, 23 after horizontal pan; 6 requests, none on cached reopen. 242 stationary frames, no hidden frame or group replacement.                                                                                           |
| QQ / 1440 × 900             | `lens-translation-qq-readable-1789556527978`    | Native-size news text, original photo/gradient composition, line clamping and compact navigation spacing. 31 spans initially, 19 after scroll; cached reopen adds no request. The upper news area remained Chinese. Follow-up diagnosis found this was an overly broad fallback, **not** an approved exclusion of ordinary text. During 182 stationary frames, 0 hidden frames and 2 group replacements on the dynamic page. |
| Hugging Face / 1440 × 900   | `lens-translation-hf-safety-1789556665281`      | Headings, linked prose and navigation retain native styles; 28 spans initially, 19 after scroll, 3 requests. The skewed Team badge remains original; the neutral unsupported notice is expected. 242 stationary frames, no hidden frame or group replacement.                                                                                                                                                                |
| JWT / 1440 × 900            | `lens-translation-jwt-readable-1789556697383`   | Readable UI text around the tools, 19 spans initially and 18 after scroll; source editor contents are untouched. 2 requests, none added by reopen. Control-containing islands remain native. 241 stationary frames, no hidden frame and 1 group replacement.                                                                                                                                                                 |
| Python article / 1440 × 900 | `lens-translation-minify-1789556727478`         | Native navigation/links/heading/prose; code image and code formatting retained. 9 displayed spans initially, 7 after scroll, 2 requests. The selected area is ready; untranslatable raw-body content is not promoted to a whole-page copy. 241 stationary frames, no hidden frame or group replacement.                                                                                                                      |

The displayed-span counts exclude unchanged translations, numbers/brands, images and excluded
controls. They are not a claim that every collected string needed translation or that a full
virtualized document was translated. The real JSON records per-stage counts, fonts, boxes, scroll
positions, request counts and context lengths; no request contained an image input.

For Lark/HF/Baidu, source snapshot counters include the site's own hydration, recycling and dynamic text/style
changes; they cannot establish which actor mutated a node. Deterministic source-invariance tests
assert source text/styles, geometry, input state and editing attributes remain unchanged. Code
inspection confirms that all translation text/style writes target inert copies, not document nodes.
Do not relabel nonzero live counters as zero or claim a collaborative document save was performed.

### Deterministic evidence and retained failures

`translation-structure.spec.ts` contains 23 structural cases, including long link rows (also
anchors without href), source ellipsis and multi-line clamping, inline badges, controls, hidden
editor sentinels, zero-height/display-contents ancestors, CSS zoom, sticky/scroll clipping, table
rowspan/colspan, rectangular inset clipping, transparent left overflow and approved mixed-media
fallback. Existing lifecycle/security tests retain marker validation, source invariance,
stale-result rejection and cache assertions.

Selected RED evidence, all retained locally:

| Failure evidence                                                                                | Root cause / correction                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `translation-structure-red-20260916`, `translation-fixed-columns-red-20260916`                  | Fixed per-text slots cannot accommodate native paragraph/table growth; replaced by shared structure.                                                                                                                                                                     |
| `translation-zoom-flow-red-20260916`, `translation-out-of-flow-red-20260916`                    | Effective CSS zoom was applied incorrectly; zero-height wrappers were selected as paint roots. Preserve effective zoom once and only use actual paint boxes.                                                                                                             |
| `translation-wide-table-red-20260916`                                                           | Opaque backing used narrow article width while the table visibly overflowed. Expand paint/clip area without changing column layout width.                                                                                                                                |
| `translation-native-clamp-red-20260916`, `translation-clamp-badge-red-20260916`                 | Chromium serializes legacy webkit-box as flow-root; compact fixed-width labels wrap internally. Restore native clamping and permit single-item badge growth.                                                                                                             |
| `translation-nav-scroll-red-20260916`                                                           | Global overscroll rules swallowed wheel events on non-scroll ancestors. Apply containment only to actual source scrollports.                                                                                                                                             |
| `translation-control-owner-red2-20260916`, `translation-body-boundary-red-20260916`             | A control-containing/bare-body text owner could swallow safe peer roots or cover controls. Reject unsafe roots before deduplication.                                                                                                                                     |
| `translation-nav-action-red-20260916`, `translation-nav-space-red-20260916`                     | A href-less menu item bypassed dense-row constraints; excessive margins left almost no room for labels. Classify anchors structurally and reclaim decorative spacing before ellipsis.                                                                                    |
| `lens-translation-lark-readable-1789554440614`, `translation-inset-table-red-20260916`          | A blanket clip-path exclusion hid a table whose negative rectangular inset only clipped its right edge. Use shared rectangular clip geometry in discovery, context and rendering. Fully clipped menus still stay hidden.                                                 |
| `lens-translation-lark-readable-1789555060894`, `translation-inset-overflow-red-20260916`       | Clamping the final clip inset to zero cropped visible table overflow at the article origin. Preserve signed insets.                                                                                                                                                      |
| `lens-translation-lark-readable-1789555785456`, `translation-transparent-overflow-red-20260916` | Signed clipping exposed transparent overflow without a backdrop, leaving original glyphs visible. Paint only the overflow structure's clipped rectangles with the ancestor backdrop and watermark. The frozen pixel assertion changed from 528 residual red pixels to 0. |
| `lens-translation-minify-1789553138742`                                                         | Initial body-root defect, followed by a provider marker/response-format failure. The response failure is retained, not counted as a successful translation or proof of reliability.                                                                                      |

An intermediate build failed strict TypeScript indexed-access checks in the new spacing assertion;
the assertion was rewritten with an explicit preceding-row guard. The old-build browser run in
`translation-structure-final-spacing-20260916` is a retained failure, not final evidence.
The final self-review also found source URLs containing whitespace/control characters could bypass
the initial scheme regex. Four unit cases now validate browser-normalized URL protocols; two failed
before replacing the regex with `URL` parsing. Model text still cannot create any link destination.

### Final repository gates

- `npm run format:check`, `npm run lint`: passed; no product warnings.
- `npm run test:run`: **137 files, 1,679 tests passed**.
- `npm run build`: typecheck and production build passed.
- `npx playwright test --config e2e/playwright.config.ts --output e2e/.runtime/translation-final-structure-all-20260916`:
  **80 browser tests passed**. Build and Playwright are the two `test:e2e` stages; they were run
  separately to keep the build frozen while the real diagnostics used it.
- `npm run audit:bundle`: 17 assets passed; `npm run check:sandbox`: passed.
- `npm run e2e:catalog:validate`: 25 catalog contracts validated, **not** 25 newly passed live tasks.
- `git diff --check`: passed.

Playwright emits the existing `NO_COLOR`/`FORCE_COLOR` environment warning. No test suppression,
dependency addition, source-page modification or weakening of acceptance assertions was used.
Current implementation changes are intentionally uncommitted; the text-only baseline was already
committed/pushed separately. Private `.runtime` evidence remains ignored.

### Intentional limits

- Unsafe growth beside live video/Canvas or independent flows stays original, with a neutral
  unsupported notice; safe regions on the same page continue translating.
- Very dense menus can still truncate labels at native font size. Native ellipsis is preferable
  to tiny glyphs or overflowing neighboring items; full translated text is retained in the copy.
- Inputs/placeholders, real editable drafts, image-internal text, off-DOM virtualized content,
  unsupported animated/transformed text and raw body text are not promised full translation.
- Only source-region targets translate. Structural reflow may expose unchanged neighboring text;
  the lens is not a separately scrolling translated document.
- A two-second stationary observation does not prove flicker-free behavior for every dynamic page.
  JavaScript overlays can briefly lag compositor scrolling; no zero-frame-lag claim is made.
- Real provider failures remain possible and require explicit retry. Context is sent, but does not
  guarantee terminology or every translation. No reliability/performance rate is inferred here.

## Coverage and active-scroll correction — 2026-09-17

### Reproduced defects

- `qq-lens-cause-1789616484419` and `qq-lens-cause-1789619046542`: the real provider completed
  88 blocks (three HTTP 200 requests); only 42 translated spans displayed. Expansion of an upper
  structural row caused all 36 of its blocks to fall back, including independent short product
  labels. The source row did not overlap video, but the expanded copy did. This is a renderer
  defect, not a missing response or a legitimate exclusion of all the upper news text.
- The same observations measured transient source/copy offsets and 61–75 ms main-thread/frame
  delays during scrolling. Geometry samples are not proof that every offset was painted.
- `scroll-coverage-red-built`: three deterministic browser tests failed on ordinary compact
  headline coverage, collateral sibling fallback, and immediate scroll synchronization (140 CSS
  pixels behind before the next frame).
- `scroll-overflow-red`: caching only the visible slice of an overflow backdrop left newly exposed
  rows without backing during a scroll gesture. The added backdrop/watermark assertion failed.

### Bounded correction

On a collision, first retain explicit compact/ellipsis text at its original line budget and native
font size. If the group still conflicts, split disjoint structural child boxes within the existing
node budget and leave only irreducibly conflicting text original. Overlapping photo/caption layers
and inline prose are not split. Paragraphs/tables without a compact contract still reflow normally.
There are no hostname or site-class rules in these corrections.

Scroll events now synchronize existing group origins, ancestor clips, backgrounds, copied scroll
offsets, sticky positions and fixed watermarks immediately. They do not collect source text or
measure/copy the group's descendants. Collection and reflow resume after 100 ms of scroll inactivity;
arriving model results are validated and cached meanwhile. Overflow backing retains the full
structural rectangles and uses a moving external clip, not a viewport-sized cached slice.

### Verification scope and retained failures

- The four defect regressions pass; an additional real-wheel browser test performs repeated down/up
  gestures, samples frames and scroll events, and verifies source/copy error below 1 CSS pixel,
  retained group identity, and no duplicate translation request. This is a deterministic built-
  extension check with a controlled provider, not a universal compositor-lag guarantee.
- A unit regression checks that mutations and arriving final results do not trigger collection or
  reflow during the gesture, and that the final result appears after settling.
- The first full browser run caught a real regression in the existing failed-stream case:
  its error notice appeared while a preview was still deferred for the remainder of the gesture.
  Evidence remains in `playwright/results/translation-streaming-stre-6e5b0-caching-unfinished-coverage`.
  Error handling now ends scroll deferral immediately, refreshes source geometry and lets normal
  cleanup remove the failed preview synchronously. The existing assertion was not weakened.
- The first attempted browser run (`scroll-coverage-red`) encountered a stale development-mode
  build pointing at an unavailable Vite server; it did not reach the assertions. Rebuilding yielded
  the genuine RED evidence above. An intermediate broader run (`scroll-structure-suite`) had a
  service-worker startup failure while the doctor rebuilt the same directory. That failure is
  retained; no test or assertion was disabled, and final browser checks use a frozen build.
- Doctor, catalog validation and standalone QQ environment verification passed. The subsequent
  real-provider diagnostic `lens-translation-qq-readable-1789624406576` returned HTTP 401 on every
  request and displayed `text/MODEL_AUTH`. Its zero displayed/matched groups mean its scroll metrics
  are **not acceptance evidence**. The diagnostic now stops after an initial model error instead
  of continuing through meaningless scroll/reopen stages. Canonical interactive setup is open for
  the user to refresh the dedicated Profile credential; no credential copying or alternate auth
  path was used.
- The 2026-09-16 live-site observations above remain historical evidence only. They do not establish
  that this correction has passed fresh QQ, Baidu, Lark or other real-provider page acceptance.

### Final automated gates for this correction

Final frozen content bundle: `page-content.iife.ts-D15xr-bj.js`.

- `npm run test:run`: **137 files / 1,680 tests passed**.
- `npm run test:e2e -- --output e2e/.runtime/scroll-final-e2e`: typecheck, production build and
  **85 browser tests passed**. This includes five added browser cases and the unchanged failed-
  stream assertion. The earlier full-run failure is not counted as a pass.
- `translation-streaming.spec.ts --repeat-each 3`: **9/9 passed**, including failure and cancellation.
- `npm run format:check`, `npm run lint`, `git diff --check`: passed.
- `npm run audit:bundle`: 17 assets passed. `npm run check:sandbox`: passed.
- `npm run e2e:catalog:validate`: 25 contracts validated; this is not a live acceptance count.

No new dependencies, site-specific renderer rules, source-document writes, commits or pushes.
Fresh real-provider page acceptance remains pending the credential refresh described above.

### Requested live recheck — 2026-09-17

The user requested another E2E check. The existing interactive setup completed and standalone
`verify.ts translation-qq-readable` passed its origin, configured-token, tab-access and readiness
checks. These checks establish that a token is configured, not that the provider accepts it.

The unchanged `page-content.iife.ts-D15xr-bj.js` build was then exercised through the real QQ page
with `diagnostics/translation-lens.ts translation-qq-readable en`. Evidence is retained at
`e2e/.runtime/lens-translation-qq-readable-1789626686102/`:

- Three text-only requests started. The two responses received before termination were HTTP 401;
  the third has no recorded response status. Request context sizes were 871, 951 and 1,080 chars.
- The initial lens status was `error`, with `text/MODEL_AUTH` and zero displayed translated spans.
- The diagnostic stopped at that first failure. Scroll, reopen and layout acceptance were **not**
  evaluated or counted as passed. Baidu and Lark were not retried against the same rejected
  credential.

Canonical interactive setup was reopened for a user-driven credential update in the dedicated
test Profile. No credential extraction, copying or alternate authentication path was attempted.

The same frozen build also passed a fresh targeted browser run:
`playwright test --config e2e/playwright.config.ts translation-structure.spec.ts --output e2e/.runtime/scroll-user-request-e2e-20260917`:
**28/28 passed (47.6 seconds)**. This covers compact headlines, independent sibling fallback,
continuous native-wheel alignment, overflow backing/watermarks and coherent table reflow. It uses
a controlled provider and does not resolve the real-provider acceptance blocker above.

## Browser-only live recheck and reflow footprint correction — 2026-09-17

The canonical Playwright browser path does not depend on native desktop-control permission.
Standalone QQ, Baidu and Lark verification passed. Subsequent native-lens diagnostics received
HTTP 200 responses using the existing dedicated Profile; no credentials were extracted or copied.

The first recheck kept the preceding `page-content.iife.ts-D15xr-bj.js` build frozen:

| Target       | Evidence under `e2e/.runtime/`                  | Observed result                                                                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QQ / 1440    | `lens-translation-qq-readable-1789628318828`    | Upper news and product links now translate; 86 translated spans initially. Continuous wheel probe: 32 actual scroll events, 160 frames, 10/14 groups matched, zero measured offset or replacement for matched groups. Playlist labels still remained Chinese; see the later coverage defect below. |
| Baidu / 1440 | `lens-translation-baidu-readable-1789628468622` | 39 translated spans; source-sized navigation and single-line hot-search ellipsis, without letter wrapping or overlap. Escape/reopen added no requests (2 total). The page fits this viewport, so its zero scroll events are not scrolling acceptance evidence.                                     |
| Lark / 1440  | `lens-translation-lark-readable-1789628586342`  | Functional-requirements table and following prose translate coherently. Escape/reopen added no requests (4 before/after). 32 actual scroll events, 128 frames, 2/3 groups matched; no measured offset or replacement for those matched groups.                                                     |
| Lark / 1024  | `lens-translation-lark-readable-1789628696569`  | **Failed horizontal-overflow acceptance.** Reflow shifted the translated table down, while part of the original table remained visible above it, left of the article. The `ready` status did not mean the visual result passed.                                                                    |

QQ's cached-reopen stage added three small requests (3, 1 and 1 blocks), not a full-page retranslation.
The captured counters alone do not distinguish source refresh/recycling from cache misses. This
detail remains unclassified and must not be reported as a zero-request cache pass. Dynamic-page
source counters and stationary group replacements are likewise not proof of extension source writes.

### Preserved defect and minimal correction

The overflow backdrop covered only the reflowed copy's visible footprint. When preceding translated
prose grew, a panned table moved downward inside the mirror, exposing its original footprint outside
the main flow's rectangle. Backdrop geometry must cover both footprints, each with its own inner
clipping; merely backing the new table or enlarging the whole neighboring column is insufficient.

`translation-reflow-footprint-red` preserves the failing browser regression: **532 residual red
source-glyph pixels**, where zero were expected. The regression also requires actual table movement
and unchanged source HTML. The correction uses the existing disjoint-region/clipping path for both
source and copy rectangles, keeps the 64-region bound, and caches both for the lightweight scroll
path. No site-specific rule, source-page write or new rendering layer was introduced.

The targeted `translation-structure.spec.ts` run passed **29/29** in
`translation-reflow-footprint-green`, including zero residual source pixels in the new regression.

That first correction's real 1024-pixel Lark replay (`lens-translation-lark-readable-1789629144351`,
build `page-content.iife.ts-CLQNeyAy.js`) **failed**: after horizontal scrolling the document body
fell back to original text (`unsupported`, 6 displayed spans, no table copies). The successful
controlled test did not supersede that failure. A local diagnostic using the same canonical
Profile (`lark-footprint-cause-1789629394656`) traced the fallback to the 64-region safety budget,
not an independent-content collision. Many overlapping table-editor decoration rectangles were
processed before their larger covering containers, unnecessarily fragmenting the same painted union.

`translation-overflow-fragmentation-red` preserves a second failing browser regression reproducing
that condition without site-specific classes: forty small overlapping decorations before one large
overflowing container cause `unsupported` instead of `ready`. The follow-up correction measures and
clips candidates first, then subtracts/adds them largest-first. It retains the exact rectangular
union, fractional geometry, source-footprint ownership, 64-region bound and cached scroll path;
it neither increases the limit nor fills a broad bounding box across unrelated columns.

Final real-page and repository-gate results are recorded below.

### QQ partial-translation correction after screenshot feedback

The user correctly identified remaining Chinese DOM text in the real QQ screenshot. The four
playlist titles below the player were **not** an accepted video/image exception. The earlier QQ
observations establish improvement in the upper news area, not complete ordinary-text coverage.

The preserved replay `lens-translation-qq-readable-1789630030332` displayed 86 translated spans.
Read-only discovery evidence `qq-text-cause-1789630271664` confirmed that the playlist titles were
collected. `translation-qq-readable-layout-cause-1789630368245` then confirmed that the real model
returned English for all four, but layout rejected their common container. Three tiny animated
playing-indicator bars intersected the container, so its whole playlist fell back to Chinese.

The correction treats running animations as a structural grouping/copying boundary, consistently
with discovery's existing native-surface rule. Safe labels on either side remain separate read-only
islands; the real indicator keeps animating and the player remains native. It uses no QQ classes,
hostnames, animation-size exemptions or source writes. `translation-animation-boundary-red`
preserves the failing generic browser case (`unsupported` instead of `ready`). That case also
requires all label translations, original font size, non-overlap with the live indicator, a running
source animation and unchanged source HTML.

The corrected frozen bundle is `page-content.iife.ts-CiZ_txV3.js`. The focused structural and native-
surface browser suite passed **38/38** in `translation-animation-boundary-green`.

The subsequent Lark replay `lens-translation-lark-readable-1789630787975` exposed a diagnostic
race: its moved-lens state claimed zero displayed spans while the immediately following screenshot
already contained translated prose. That stage is not counted as a pass. `diagnostics/translation-lens.ts`
now waits for complete provider streams and a terminal rendering snapshot stable for 600 ms, rather
than accepting the first stale terminal status after a lens movement. It records settlement and
stops on timeout. The same production build's replay `lens-translation-lark-readable-1789630974812`
was ready at every stage, including 21 spans after horizontal pan and 5 after moving the small lens.
No production behavior was changed in response to that inconsistent diagnostic snapshot.

### Final real-page observations for the corrected bundle

The checks below use real provider output, not fixture translations. Counts exclude unchanged
brands/identifiers and intentionally untranslated image/video pixels. An entire site is not declared
universally supported by one tested viewport. The matched-group probes do not measure unmatched
groups or establish compositor timing; stationary dynamic-page group replacements are recorded
separately from scrolling offsets.

| Target              | Evidence under `e2e/.runtime/`                  | Observed result                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QQ / 1440           | `lens-translation-qq-readable-1789630689102`    | All four previously rejected playlist labels now display English alongside the live indicator. 90 translated spans initially; all stages ready. Continuous scroll: 32 actual events, 161 frames, 14/18 groups matched, zero measured offsets/replacements for those groups. Cached reopen added no request (4 before/after); smaller/moved lens subsequently added two small requests. Images/player pixels remain original by design. |
| Lark / 1024         | `lens-translation-lark-readable-1789630974812`  | Headings, prose and table cells remain readable, including original-overflow backing after horizontal panning. 20 spans initially, 26 after vertical scroll and 21 after horizontal pan. 32 actual scroll events, 129 frames, 2/3 groups matched, zero offsets/replacements for those groups. Cached reopen added no request (4 before/after); the moved small lens added one request.                                                 |
| Baidu / 1440        | `lens-translation-baidu-readable-1789631259323` | 38 translated spans initially; native-sized navigation, recommendation strip, two-column hot-search ellipsis and separated badges. All stages settled and ready. Escape/reopen added no request (2 total). The page fits this viewport; zero actual scroll events are not scrolling acceptance evidence.                                                                                                                               |
| Lark / 1440         | `lens-translation-lark-readable-1789631322942`  | 26 translated spans initially and 36 after scrolling through the table. Coherent table rows and following prose at 14–16 px; headings remain 26/34 px and watermarks remain visible. 32 actual scroll events, 131 frames, 2/3 groups matched with zero offsets/replacements. Cached reopen added no requests.                                                                                                                          |
| Hugging Face / 1440 | `lens-translation-hf-safety-1789631390435`      | 28 translated spans initially, 19 after scrolling into linked prose. Paragraphs, inline links and styles remain coherent. 32 actual scroll events, 129 frames, all four groups matched with zero offsets/replacements. The skewed Team badge still stays native; the page-level unsupported notice is not a complete ordinary-text coverage claim.                                                                                     |
| JWT / 1440          | `lens-translation-jwt-readable-1789631899277`   | 20 translated spans initially and 19 after scroll; headers, navigation and explanatory copy are readable. 32 actual scroll events, 128 frames, all ten groups matched with zero offsets/replacements. Reopen added no requests. The `Encoded Token` label remains native because a form-control surface overlaps its box; input/editor values are deliberately untouched. This is partial support, not all-text acceptance.            |

Baidu attempt `lens-translation-baidu-readable-1789631069952` is **not** a pass: its source screenshot
was the homepage, but the first translated screenshot showed an empty search page. The original
cause of that page transition was not established. It was preserved, no production change was made
for it, and it is not comparable homepage-layout evidence. The diagnostic now records main-frame
navigations without query strings and saves the source after closing the lens. The following replay
above stayed on the homepage and was checked against that original target; it does not retroactively
explain or erase the changed-page attempt.

JWT attempt `lens-translation-jwt-readable-1789631484278` also remains **failed/inconclusive**:
the viewport changed while the newly loaded app settled, only two blocks were requested, and no
translated spans were displayed. An independent source read (`translation-jwt-readable-text-cause-1789631624534`)
found 34 blocks after loading; the real-provider diagnostic `translation-jwt-readable-layout-cause-1789631741248`
then validated 34 results and displayed 20 spans, with only the form-adjacent `Encoded Token` label
in layout's rejected-ID list (other results were unchanged source strings). No production change
was made for this startup observation. The visual diagnostic now waits for full load, fonts and a
stable source layout before its baseline; it resets only document scroll, not every nested editor
scrollport. The replay above used those preconditions. Early-loading-page behavior is not declared
universally fixed by that replay.

All final listed runs used text-only requests with page context and real HTTP 200 provider responses.
The production renderer has no new hostname or site-class rules. No dependencies, source-document
writes, commits or pushes were added. The Python article's earlier evidence is historical; this
round did not repeat that supplemental live sample.

### Final repository gates — 2026-09-17

The final production bundle remained `page-content.iife.ts-CiZ_txV3.js`. The real-page
observations above and controlled browser regressions are separate evidence: passing the latter
does not remove the real-page limitations or inconclusive attempts recorded above.

| Command                                                                                        | Result                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run test:run`                                                                             | 137 files, 1,680 tests passed (29.40 seconds).                                                                            |
| `env -u NO_COLOR npm run test:e2e -- --output e2e/.runtime/translation-final-browser-20260917` | Typecheck and production build succeeded; all 88 browser tests passed (4.4 minutes), including the three new regressions. |
| `npm run audit:bundle`                                                                         | Passed; 17 production assets audited.                                                                                     |
| `npm run check:sandbox`                                                                        | Passed.                                                                                                                   |
| `npm run e2e:catalog:validate`                                                                 | Passed; 25 sample definitions validated. This validates the catalog, not benchmark completion.                            |

The first gate attempt caught a diagnostic-only optional-property type error, a test non-null
assertion lint error, and Markdown formatting differences. These were corrected without changing
production behavior or weakening assertions before the successful reruns. Final `npm run format:check`,
`npm run lint` (zero warnings) and `git diff --check` also passed. All code remains uncommitted.

## New Wiki/table and whiteboard report — 2026-09-18

The new user-supplied Wiki is a different target from the earlier direct Docx document.
Its real address is stored only in the ignored `translation-lark-wiki-readable` catalog sample.
The shared canonical Profile, catalog validation and standalone target verification passed before
the native-feature runs. No alternate authentication or private credential copying was used.

### Wiki discovery regression and bounded fix

The existing document safety adapter accepted `/docx/` but not `/wiki/`. Consequently the published
body and table text in the Wiki entry point were treated as editable drafts and excluded. The
baseline `lens-translation-lark-wiki-readable-1789704553258` retained the module table in Chinese;
peripheral translated text was not proof of document coverage.

The adapter now accepts both routes on the already recognized HTTPS document domains. The same
document-root/zone checks, nested-draft exclusions and static watermark rules still apply. The
renderer has no new hostname or site-class branches and the source document is never rewritten.

The three Wiki URL unit cases failed before the change; unrelated/deceptive hosts remain rejected.
`translation-wiki-route-red-20260918` preserves the two failing built-browser regressions (Wiki
prose and growing merged-cell table with following prose). After the correction, the three focused
unit files passed 77 tests and both entry points passed all four browser cases in
`translation-wiki-route-green-20260918`.

### Page responsiveness and session recovery

The first real candidate `lens-translation-lark-wiki-readable-1789704776711` displayed the module
table in English, but ended in `session/TRANSLATION_PAGE_UNAVAILABLE`. All four model requests
returned HTTP 200. This attempt remains failed, not a successful translation acceptance run.

The same-build diagnostic `lens-translation-lark-wiki-readable-1789705469965` added bounded,
diagnostic-only page-query/long-task timings. All 86 page replies were correlated and valid, but
the slowest took 5,520 ms (the per-attempt deadline is 3,000 ms). The longest individual page task
was 804 ms. Continuous scrolling measured zero geometry offset in 131 frames / 32 actual events
for all six matched groups; this does not establish universal compositor timing. The module table
stayed translated, but other rejected text meant this was still partial document coverage.

Two unit regressions then failed as expected: six cumulative previews caused six synchronous
layout passes, and an active-session verification after a transient failure left discovery blocked.
The correction keeps the first preview immediate and coalesces the latest following snapshots at
100 ms intervals. Confirmed recovery of the same session clears only the session error, retaining
completed translations and model-error state. It does not increase IPC deadlines or replay model
requests/toggles. Final/cancelled/failed streams discard pending previews. The focused scheduling,
lens and page-port unit suites passed 42 tests; seven route/table/stream browser cases passed in
`translation-wiki-stream-green-20260918`.

### Remaining document coverage — not complete

Read-only tracing in `translation-lark-wiki-readable-layout-cause-1789705693449` confirmed that
another table above the reported module table was collected and translated, but 14 entries were
rejected at display time. Its translated copy grew into the following independent heading. The
ancestor grouping boundary did not permit them to reflow together; relaxing collision protection
would cover other content. This is an ordinary-table limitation, not an approved image exception
and not a model failure. A segmented shared-flow design is still needed for that case.

The document also contains Canvas-backed whiteboards. Read-only source inspection
`wiki-source-check-1789705393674` found two Canvas layers per mounted whiteboard, with no DOM text
inside their canvas container. The first board's structured API export separately contained 45
nodes, 34 with text and geometry. That proves the platform has structured data, not that the
extension can currently read or render it. No API adapter, authentication integration, canvas/OCR
translation or image-translation fallback was added. Choosing a structured platform adapter or a
generic visual path requires an explicit scope decision because the existing request was DOM-only
and generic. Whiteboards are **not yet supported**.

The final-bundle replay `lens-translation-lark-wiki-readable-1789706070708` used
`page-content.iife.ts-DXVqNwfV.js`. All eight real model requests returned HTTP 200, with text-only
inputs and source context. None of the 103 page queries exceeded three seconds; the maximum was
1,314.5 ms. This single observation is not a latency guarantee. Continuous scroll measured zero
offsets for all six matched groups in 132 frames / 32 events. The source stayed on the same page.

However, visual inspection of **every stage**, not just the initial screenshot, still failed
document coverage: initially the module table translated (44 displayed spans), but scrolling down
exposed its tail/following content and the same table fell back to Chinese (17 peripheral spans,
zero table copies). It translated again on returning. Horizontal-panning screenshots also retained
the other Chinese table. Reopen added five source blocks as the site changed/recycled nodes; this
is not a zero-request cache-reopen claim. The fixed discovery/session issues therefore do **not**
mean the user-reported table defect is fully closed. Continuous multi-block flow and whiteboard
support remain required. No safety guard was removed to hide these failed cases.

Repository-gate results below apply to the bounded changes only, not overall live acceptance.

| Command                                                                                             | Result                                                          |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm run test:run`                                                                                  | 137 files, 1,691 tests passed (29.21 seconds).                  |
| `env -u NO_COLOR npm run test:e2e -- --output e2e/.runtime/translation-wiki-final-browser-20260918` | Typecheck/build passed; 90 browser tests passed (4.0 minutes).  |
| `npm run format:check`                                                                              | Passed.                                                         |
| `npm run lint`                                                                                      | Passed with zero warnings.                                      |
| `npm run audit:bundle`                                                                              | Passed, 17 production assets.                                   |
| `npm run check:sandbox`                                                                             | Passed.                                                         |
| `npm run e2e:catalog:validate`                                                                      | Passed, 26 definitions; not a WorkSession benchmark pass claim. |
| `git diff --check`                                                                                  | Passed.                                                         |

All changes remain uncommitted. No dependencies were added and no source document, whiteboard,
permission settings or credentials were changed. The real Wiki sample/screenshots remain ignored.

## Ordinary document-flow and table correction — 2026-09-20

The user approved fixing ordinary mounted DOM prose/tables, retaining the lens and readonly
copies. OCR, image translation and Canvas whiteboards are excluded. This section supersedes the
ordinary-table failure above only for the scenarios actually rerun; it is not whole-site acceptance.

### Root causes and bounded correction

The provider was already returning the missing table translations. A growing table was copied
separately from its following heading/paragraph because a larger ancestor contained distant native
media. Expansion collided with the next independent copy, so the safety check removed the table.
Trying the same content through single-child wrappers only spent the layout budget again.

The existing structural renderer now groups consecutive safe normal-block siblings into a bounded
flow fragment. Tables, headings and prose can grow together without copying a whole editor or
crossing a live-media/control boundary. A complete table can use the existing 6,000-node aggregate
budget instead of being split by the old 1,800-node island cap. Flex/grid internals remain indivisible;
single-child collision retries are removed. No model/request protocol or site-specific selectors
were added, and the source DOM is not rewritten.

The first live candidate still failed: the source flow was 771.5 pixels wide, but a local decoration
made its scroll width 824 pixels. Expanding the entire opaque backing to that width falsely collided
with a right-gutter comment marker and rejected 62 of 75 translated entries. Backing now follows the
actual layout box plus individually clipped painted overflow, not the entire scroll width. Transparent
editor interaction gutters are not painted as opaque rectangles over adjacent navigation. Default
`outline-width: 3px` with `outline-style: none` is not treated as visible ink.

### Failure evidence and regressions

All directories below are retained beneath the ignored `e2e/.runtime/`:

- `translation-document-flow-red-20260920`: growing table disappears while following prose renders.
- `translation-flow-gutter-red-20260920`: a local overflow decoration rejects the document flow
  beside an unrelated annotation.
- `translation-empty-gutter-red-20260920` and `translation-empty-gutter-cause2-20260920`: the
  transparent editor wrapper incorrectly paints over the left gutter; the follow-up isolates the
  invisible default outline.
- `translation-lark-wiki-readable-layout-cause-1789875935350`: instrumented, same-candidate real
  Wiki replay confirms 75 collected/translated entries but only 13 displayed. Only diagnostic
  geometry/counts are persisted, not private model payloads.
- `lens-translation-lark-wiki-readable-1789875654363`: navigation/setup failure, zero model requests.
  The live document's section is now `3.1`, and virtualized content must first be mounted through
  its visible contents link. The generic diagnostic accepts explicit navigation text; the product
  has no hard-coded section title.

Four new browser regressions cover shared table/prose flow, gutter annotations, a complete table
with more than 1,800 nodes, and transparent editor gutters. Assertions include source HTML
invariance, original font size, merged cells, complete column structure, absence of copied live
controls/media and persistence after scrolling. The existing overflow test still requires the
entire translated row to be backed, but checks the union of structural backing rectangles instead
of requiring one unnecessarily wide opaque rectangle.

### Final real-page replay

Doctor, catalog and standalone target verification passed with the existing canonical Profile.
All final runs used the unchanged build `page-content.iife.ts-Bw0bECTm.js`, real provider responses
and the native lens. Screenshots were inspected; response/status success alone is not acceptance.

| Target                  | Evidence directory                                  | Observed result                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feishu Docx, 1024 × 900 | `lens-translation-lark-readable-1789879489485`      | Targeted prose and requirements table translate at source font sizes. Initial, vertical scroll/return, horizontal pan/return, cached reopen, resized and moved lens all settled as ready. Table rows grow naturally; existing horizontal clipping remains.                                                                                                                                                                                             |
| Feishu Wiki, 1440 × 900 | `lens-translation-lark-wiki-readable-1789879393265` | Targeted module table, headings and surrounding prose remain English through scroll/return and cached reopen, rather than dropping the table. The copy retains two tables, with 44 displayed spans initially and 52 after scrolling. Empty left gutters no longer erase the contents pane. The full lens still reports unsupported content; this is **not** complete sidebar/editor-UI coverage. No horizontal-pan stage was reached in this Wiki run. |
| Baidu, 1440 × 900       | `lens-translation-baidu-readable-1789879595510`     | Navigation and hot-search rows retain readable source-size text, single-line ellipsis and separate badges. All stages ready; 37 displayed spans, two requests before/after cached reopen. The page fits the viewport, so zero actual scroll events do not prove scrolling behavior. Input placeholder and raster logos remain original.                                                                                                                |
| QQ, 1440 × 900          | `lens-translation-qq-readable-1789879629339`        | News headings/lists/playlist text render in English, but the category strip is still missing and a photo card retains Chinese text plus a white strip. **Not accepted as fully fixed.** Native video/image pixels are intentionally unchanged; these remaining DOM/paint defects are separately recorded, not relabeled as approved exclusions.                                                                                                        |

Both Feishu runs sent only text with nonempty reference context: Wiki 655–1,427 characters per
request, Docx 178–1,488, all within the existing 6,000-character total budget. All nine requests
finished with HTTP 200. The 61 Wiki and 68 Docx page replies were correlated and valid; maximum
query times were 46.3 ms and 142.1 ms in these runs. This is not a latency guarantee.

Continuous scrolling measured zero geometry offsets and zero group replacements across all three
matched groups in each Feishu run: Wiki 132 frames / 32 actual events; Docx 135 frames / 32 events.
These probes do not prove universal compositor behavior. Dynamic source-page mutation counters
include the site's own rendering and are not evidence of zero page mutations; deterministic
fixtures independently assert that the extension does not rewrite source HTML.

### Final gates and retained limits

| Command                        | Result                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `npm run test:run`             | 137 files, 1,691 tests passed.                                                              |
| `npm run test:e2e`             | Typecheck/build succeeded; all 94 browser tests passed, including the four new regressions. |
| `npm run lint`                 | Passed, zero lint warnings.                                                                 |
| `npm run format:check`         | Passed after documentation updates.                                                         |
| `npm run audit:bundle`         | Passed, 17 production assets.                                                               |
| `npm run check:sandbox`        | Passed.                                                                                     |
| `npm run e2e:catalog:validate` | Passed, 29 sample definitions; not a WorkSession benchmark claim.                           |
| `git diff --check`             | Passed.                                                                                     |

The browser command emitted the existing Node `NO_COLOR`/`FORCE_COLOR` environment warning;
there were no failed tests. Layout work remains bounded to mounted safe DOM. Canvas-only boards,
image text and live/editable controls are still excluded. The Wiki unsupported notice and the QQ
failures above remain visible limitations, not evidence that the ordinary table still failed.
The change was self-reviewed under the user's no-delegation rule, without an independent reviewer.
All work is uncommitted; no push, dependency, document edit or credential change was made.

## Remaining text-layout defects — 2026-09-20 follow-up

The user requested closure of the remaining ordinary DOM defects, not acceptance of the QQ/Wiki
failures above. Work continued in the same approved text-only, readonly structural renderer.
No additional site selector, dependency, OCR, image request or document-write path was added.

### Additional causes and repairs

| Defect                                                      | Confirmed cause and correction                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| White/empty QQ navigation and photo-caption artifacts       | A blue/photo backdrop can be a sibling rather than an ancestor. Resolve static backgrounds from the source paint stack, retaining their origin while scrolling.                                                                                       |
| Missing/collapsed graphics                                  | Preserve CSS masks and prevent static SVG/background-image icons from flex-shrinking to zero beside a longer translated label.                                                                                                                        |
| Ordinary headline skipped beside a pulsing badge            | A small text-free CSS decoration was classified as a live surface. Its inert copy is now static; the source animation is untouched. Larger/interactive animations remain native.                                                                      |
| Empty virtualized document sidebar                          | Percentage/flex scrollports expanded to their full virtual content height, resetting the copied scroll position. Preserve the measured source scroll window and its scroll offset. Pure positional transforms no longer reject readable virtual rows. |
| Untranslated paragraph revealed after a shorter translation | Source-only viewport discovery missed text newly exposed in the mirror. Reconcile actually visible copied text with source IDs through the same bounded privacy/visibility checks.                                                                    |
| Article translation covering a fixed header                 | Source z-order must hold even when a header contains native controls and cannot be copied. Cache fixed/sticky surfaces and clip lower copies around their actual footprints. Partial panels do not reject a whole article.                            |
| JWT heading incorrectly rejected                            | An invisible 1 × 1 accessibility shell used both `clip:rect(0,0,0,0)` and `clip-path:inset(50%)`. The parser treated the pair as an unsupported visible obstacle. Intersect supported clips; a zero-area clip remains hidden.                         |
| Narrow utility labels rejected beside media                 | Preserve the source-size, compact single-line contract using native ellipsis and full hover text, without shrinking the font.                                                                                                                         |
| Slow text response aborted at 60 seconds                    | The text deadline is now 120 seconds as requested; cancellation still terminates promptly. No hidden provider retry loop was added.                                                                                                                   |

Fourteen browser regressions in `translation-paint.spec.ts` cover these source/paint boundaries,
including actual screenshot pixel assertions for backdrops and native pinned controls. An additional
clipping unit test covers simultaneous old/new clips and an unsupported shape combined with an
empty clip. The unchanged source markup assertions run before screenshot capture: Playwright's
caret-hiding screenshot operation itself serializes inline input styles.

Supplemental probes retain the actual shape evidence in ignored runtime files, including
`paint-inspect-translation-jwt-readable-1789887360516.json` (the hidden 1 × 1 obstacle) and
`paint-inspect-translation-mdn-readable-1789886600729.json` (the 98-pixel native sticky header).
They use synthetic translations only for cause isolation; they are not real-provider acceptance.
RED evidence is retained in the `translation-paint-red-*` runtime directories, including
`translation-paint-red-native-header` and `translation-paint-red-double-clip-render`.

The real Docx replay `lens-translation-lark-readable-1789889758624` reached `ready` at every
stage, but screenshot inspection still found original heading glyphs showing through a narrow
horizontal stripe. It was **not** accepted. The cause probe
`translation-lark-readable-layout-cause-1789889995002` found empty, transparent fixed notification
portals falsely classified as painted occluders. Only their actual painted descendants or native
controls/media now cut holes in lower translation layers. This uses the existing bounded paint
classification, not a Feishu class/hostname exception. Two new empty/populated transparent-shell
regressions failed in `translation-paint-red-empty-pinned` and passed, together with the other
twelve paint tests, in `translation-paint-green-empty-pinned`. The populated-shell case also
requires that native controls remain visible while empty wrapper space remains translated.

### Retained failed attempts and environment evidence

- `lens-translation-lark-readable-1789885070187`: a real provider response failed structured
  translation validation. HTTP 200 is not success; the failed run is retained. Later diagnostics
  additionally record bounded response ID/marker/count shapes without saving private text.
- `lens-translation-lark-readable-1789888907919` and
  `lens-translation-lark-wiki-readable-1789889054478`: real requests failed with
  `MODEL_INVALID_RESPONSE_SSE_PROTOCOL`. Earlier HTTP 200 responses do not make either complete
  run a pass. Subsequent instrumentation retains bounded SSE event types, safe error codes and
  index/ID presence, never provider text or credentials.
- `lens-translation-qq-readable-1789889391046`: ordinary news/navigation screenshots and the
  earlier movement stages rendered correctly, but a later request during repeated reopen returned
  an upstream SSE `server_is_overloaded` event. The whole attempt is not counted as a pass.
- `lens-translation-baidu-readable-1789890725533` and
  `lens-translation-baidu-readable-1789890783408`, plus the 1024-pixel attempt
  `lens-translation-baidu-readable-1789891286978`: the new frozen build encountered the same
  explicit upstream `server_is_overloaded` error before displaying any translations. These are
  retained failed attempts, not layout acceptance or evidence for relaxing validation. Live
  retries were paused while running deterministic gates; no production retry loop was introduced.
- `lens-translation-qq-readable-1789884230875` and
  `lens-translation-baidu-readable-1789885572832`: the lens disappeared or never appeared.
  The earlier evidence did not contain enough lifecycle/toggle detail to attribute the cause.
  Do not call these passes or claim a speculative product fix. Diagnostics now check `active:true`,
  retain bounded lifecycle/message timing evidence and exercise three additional close/reopen cycles.
- One overlapping full unit/browser gate run failed under severe host load (observed load average
  263.28). Vitest reported two executor timeouts and ten worker-start failures; Playwright reported
  three non-translation setup/planning timeouts, with 103 other cases passing. Artifacts remain in
  `e2e/.runtime/playwright/results/`. No test timeout/assertion or production behavior was loosened.
  The same unit suite rerun with two workers passed all 1,692 tests in 137 files; the browser suite
  is rerun separately with an independent evidence directory.

### Painted-portal frozen-build verification

The painted-portal correction is frozen as `page-content.iife.ts-9l9Ip3Fg.js` with background
bundle `background.ts-DBM7YBHa.js`. The full build in the browser gate reproduced the same hashes.
No production edits or builds run concurrently with the real-page diagnostics.

| Latest gate                                                                           | Observed result                                                        |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm run test:run -- --maxWorkers=2`                                                  | 137 files / 1,692 tests passed, 56.54 seconds.                         |
| `npm run test:e2e -- --output e2e/.runtime/playwright-final-painted-portals-20260920` | Typecheck and build passed; all 108 browser tests passed, 4.9 minutes. |
| `npm run format:check`                                                                | Passed.                                                                |
| `npm run lint`                                                                        | Passed, zero lint warnings.                                            |
| `npm run audit:bundle`                                                                | Passed, 17 production assets.                                          |
| `npm run check:sandbox`                                                               | Passed.                                                                |
| `npm run e2e:catalog:validate`                                                        | All 29 definitions valid; not a benchmark success count.               |
| `git diff --check`                                                                    | Passed.                                                                |

The browser runner emitted the pre-existing Node `NO_COLOR`/`FORCE_COLOR` warning only. These
deterministic gates are not substitutes for the frozen real-provider matrix and screenshot review.

#### Real-page replays on the painted-portal build

All evidence directories below are under ignored `e2e/.runtime/`. The canonical standalone
verification passed before each run. Screenshots, rather than `ready` alone, were reviewed.

| Target             | Evidence directory                                  | Observed result                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feishu Docx / 1024 | `lens-translation-lark-readable-1789890492679`      | Requirements table, heading and surrounding prose display English; the previously exposed original-heading stripe is gone. Horizontal/vertical scroll, return, cache reopen, lens resize/move, browser zoom and three extra reopens all settled ready. Five requests; 20/27/21 displayed spans in initial/down/pan stages. |
| Feishu Wiki / 1440 | `lens-translation-lark-wiki-readable-1789890613554` | Module table, numbered cell content, surrounding prose and both sidebar levels display translated text without overlapping rows or transparent-gutter erasure. All twelve stages ready, six requests, 61 spans initially and 70 after scroll.                                                                              |
| Baidu / 1440       | `lens-translation-baidu-readable-1789891242270`     | Navigation, recommendation strip and all hot-search rows retain readable source sizes, single-line ellipsis and separate badges. All twelve stages ready, two requests, 38 initial spans. The viewport fits the page; no actual scroll events occurred.                                                                    |
| QQ / 1440          | `lens-translation-qq-readable-1789891372116`        | Ordinary top headlines, category strip, product links and photo-backed DOM captions translated, without white masking bars. Initial/down screenshots inspected; all twelve stages ready, four requests, 89/59 spans initially/down. Video pixels, raster banners and photo-internal text stay native by design.            |

The final two Feishu runs sent nonempty source context (176–1,486 and 458–1,436 characters);
Baidu/QQ requests also carried context and no image inputs. Continuous scroll probes on Docx,
Wiki and QQ recorded 32 real scroll events each, respectively 3/4/12 matched groups, and zero
event/frame geometry offsets. Group replacements were 1/4/0; maximum measured frame gaps were
158.4/333.3/16.7 ms. These are bounded diagnostics under live-page load, not a claim of zero
frame delay. All four stationary observations recorded zero hidden frames; dynamic DOM updates
still caused three replacements each on Docx and QQ. Source snapshot counters include the site's
own hydration/virtualization and must not be called proof of zero source edits; deterministic
source-invariance assertions provide that separate check.

### Revealed-text lifecycle correction

`lens-translation-hf-safety-1789891532030/scroll-down.png` still exposed the English
`Narrow-boundary safety` heading after a translated paragraph contracted. The earlier state
snapshot contained its Chinese span; that did not establish that the subsequent painted frame
retained it. The attempt was rejected on screenshot evidence.

The source-update path recollected only the source viewport, discarded the off-screen-source
heading, and rebuilt a copy containing its raw text. Discovery added the cached entry back, but
no new model request was needed and its translation was not painted. The deterministic
`collects text revealed when a translated article contracts` regression now also changes a
harmless source attribute: it failed with only the first translated paragraph remaining in
`translation-revealed-red-hydration`. The fix keeps each source text mapped to its current
translated span and includes visible mirror text before source reconciliation. Normal source
privacy filters remain in force. That case passed in `translation-revealed-green-hydration`;
the expanded cached-reopen assertion also passed without any duplicate request.

The corrected build is `page-content.iife.ts-BnNJer20.js`; the background bundle remains
`background.ts-DBM7YBHa.js`. On the real HF repeat
`lens-translation-hf-safety-1789892401274`, initial/down screenshots now retain the translated
heading and prose. All twelve stages settled, four requests completed, and cached/three repeated
reopens added none. The skewed Team badge remains intentionally native, not a body-text failure.
The 32-event scroll probe recorded zero offsets for four matched groups and no group replacement.

#### Final-candidate cross-site screenshot checks

| Target / width        | Local evidence directory                            | Visible result                                                                                                                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HF / 1440             | `lens-translation-hf-safety-1789892401274`          | Title, inline links and prose retain their source typography; the reflow-revealed heading remains translated after updates. Four requests, twelve settled stages.                                                                                                                                               |
| Wikipedia / 1024      | `lens-translation-wikipedia-table-1789892528069`    | Multi-row and merged-cell comparison table retains borders, column alignment, colors, source font sizes and translated headings/cells. Four requests, twelve ready stages.                                                                                                                                      |
| GitHub / 1440         | `lens-translation-github-readable-1789892629552`    | File-list descriptions and sidebar labels translate without covering icons or collapsing rows. Filenames/identifiers and native relative-time Shadow DOM remain unchanged. Five requests, twelve settled stages.                                                                                                |
| Python article / 1440 | `lens-translation-minify-1789892800650`             | Long linked prose and headings reflow together at source sizes; code and embedded screenshots retain their own appearance. Two requests, twelve ready stages.                                                                                                                                                   |
| Feishu Docx / 1024    | `lens-translation-lark-readable-1789892873208`      | The reported requirements table, surrounding prose and heading translate without the old horizontal original-text stripe. Horizontal pan reveals translated remaining columns; all fourteen stages ready. Five requests, no extra request on cached/three repeated reopens.                                     |
| Feishu Wiki / 1440    | `lens-translation-lark-wiki-readable-1789892986390` | Module table, numbered lists inside cells, prose and two sidebar levels are translated, with coherent rows and retained watermarks. Twelve ready stages, five requests, 62/71 displayed spans initially/down. Source hydration replaced eight observed nodes; the run is not represented as a no-mutation page. |
| Baidu / 1440          | `lens-translation-baidu-readable-1789893094451`     | All ten hot-search rows, navigation and recommendation text retain readable source sizes, native ellipsis and separated badges. Twelve ready stages, two requests; image text and native input placeholder intentionally unchanged.                                                                             |
| Baidu / 1024          | `lens-translation-baidu-readable-1789893140233`     | Same native-size single-line layout at narrow width, no letter-by-letter wrapping or overflowing badges. Twelve ready stages, two requests. The page fits both Baidu viewports, so their probes did not produce actual scrolling.                                                                               |
| QQ / 1440             | `lens-translation-qq-readable-1789893220534`        | Ordinary headlines, product labels, photo-backed DOM captions, lists and Q&A text translate without white masks. Video/image pixels and raster banners remain original. Twelve ready stages, six requests, 89/44 spans initially/down on the changing news page.                                                |
| JWT / 1440            | `lens-translation-jwt-readable-1789893303980`       | The previously rejected Encoded Token label and surrounding UI translate with icons preserved. Native token/JSON inputs remain unchanged. Twelve settled stages, two requests; three small-lens stages deliberately report the native-control boundary.                                                         |
| MDN / 1440            | `lens-translation-mdn-readable-1789893355625`       | Translated article headings and contents remain below the native sticky navigation. The interactive code/example frame and native Shadow DOM controls remain original. Twelve ready stages, three requests.                                                                                                     |

All rows used the same `BnNJer20` build and canonical Profile/standalone verification. Screenshots
were reviewed independently of terminal status. No image input was sent. The requests carried
source-neighborhood context: HF 433–5,938 characters, Wikipedia 697–3,277, GitHub 653–1,941,
Python article 3,733–3,801, and Docx 178–1,488 (below the fixed 6,000-character total cap).
The Wikipedia scroll probe recorded zero offsets at scroll events but up to 4.40625 CSS pixels
in 14 sampled animation frames. This approximate source-box pairing is retained as observed,
not relabeled as zero-lag. Its settled table screenshots do not show persistent displaced text.
The other four probes recorded zero event/frame offsets. These first five stationary observations had
zero hidden frames; Wikipedia had one replaced group, the others none.

The final Wiki and QQ probes also recorded 32 real scroll events with zero event/frame offsets,
four and twelve matched groups respectively, and no group replacements during those gestures.
Wiki sent 456–1,432 characters of source context per request. Dynamic source-node replacement
can correctly invalidate cached translations; Wiki's cached reopen made one such request, while
the three subsequent reopens did not. No universal zero-lag or never-fail-provider claim is made.
QQ's stationary observation had zero hidden frames but eight group replacements as the live news
DOM updated; this is not evidence for a no-redraw or fixed-frame-rate claim. MDN's navigation-only
request had no eligible source-context anchor and sent zero context characters; its article
requests sent 1,120 and 2,266 characters. Context is bounded reference input, not a guarantee that
every request has surrounding prose or that a model always resolves every term correctly.

Self-review covered source immutability/draft exclusion, link/marker safety, bounded discovery and
layout, preview/cancellation/cache lifecycle, clipping/stacking and the generic layout ownership.
Per the user's instruction, no reviewer subagent was used. No remaining defect was found in the
tested ordinary DOM regions; intentionally excluded image/Canvas/frame/editor/Shadow DOM content
was not relabeled as fully translated. Dense menus retain native-size clipping/ellipsis rather
than guaranteeing all long labels fit at once. No dependency or additional permission was added.

#### Final frozen-build completion gates

The final browser build reproduced `page-content.iife.ts-BnNJer20.js` and
`background.ts-DBM7YBHa.js`, matching all eleven final live replays above. The reveal/hydration
regression also closes and reopens the default-sized lens without resizing it: that avoids a
resize refresh masking a cache-only repaint defect.

| Gate                                                                                     | Fresh observed result                                                               |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run test:run -- --maxWorkers=2`                                                     | 137 files, all 1,692 tests passed in 52.92 seconds.                                 |
| `npm run test:e2e -- --output e2e/.runtime/playwright-final-revealed-lifecycle-20260920` | Typecheck and production build passed; all 108 browser tests passed in 4.8 minutes. |
| `npm run format:check`                                                                   | Passed after the final test and evidence edits.                                     |
| `npm run lint`                                                                           | Passed with zero lint warnings after the final test edits.                          |
| `npm run audit:bundle`                                                                   | Passed; 17 production assets.                                                       |
| `npm run check:sandbox`                                                                  | Passed.                                                                             |
| `npm run e2e:catalog:validate`                                                           | All 29 sample definitions valid; these counts are not live benchmark pass rates.    |
| `git diff --check`                                                                       | Passed.                                                                             |

The browser runner emitted the pre-existing Node `NO_COLOR`/`FORCE_COLOR` warning; there were no
test failures. Changes and the rebuilt local `dist/` remain uncommitted. Loading this build in an
ordinary existing browser requires reloading the unpacked extension and refreshing old page tabs;
the diagnostic profile's successful run is not evidence that another profile has been updated.
