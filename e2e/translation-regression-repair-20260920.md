# Translation regression repair — 2026-09-20

**Acceptance status: incomplete.** The latest frozen build passes 1,700 unit/runner tests and 172
deterministic browser cases. QQ, NetEase, Baidu, Sina and both reported Lark targets finish their
12-stage real-provider replays with the scoped ordinary-text/table checks below. The QQ separator
and NetEase headline/footer defects have been repaired, but hao123 still fails the unchanged
150-second full-page quiet-state gate. Its continuously changing weather/search/menu islands are
an open stability limitation, not an all-page pass or a provider timeout.
A terminal ready/unsupported state alone does not close visual defects.
The final sections distinguish repaired ordinary layout defects from continuously changing native
tickers and intentional image/input exclusions. This is not an all-sites-pass report.

## Approved scope and execution plan

Repair the defects preserved in `translation-random-page-validation-20260920.md`, then verify the
same six public targets and additional layouts. Retain the read-only movable text lens, original
DOM invariance, context requests, native fonts, explicit retry and image/OCR exclusions. No site
selectors, new dependencies, source-document writes, commits, pushes or subagent work.

Ruling: work inline in the existing dirty feature checkout because the defects belong to the
uncommitted translation work. Preserve existing changes. The user's repair request approves the
previous report's follow-up plan; no new architecture or separate execution approval is needed.

- [x] Repair diagnostic cleanup: a screenshot failure must not skip settings restoration or hide
      the primary error. Test ordered cleanup and evidence persistence with a throwing screenshot.
      Files: `e2e/diagnostics/translation-lens.ts`, a small diagnostic cleanup helper and its runner test.
- [x] Diagnose and reproduce ordinary-DOM omissions and scroll persistence. Trace collected
      blocks, completed results and structural copies; add representative browser fixtures before
      changing `translation-dom.ts` or `translation-structure-layout.ts`.
- [x] Preserve table-internal root width and preformatted content. Browser regressions must
      inspect actual mirrored geometry, text line breaks and unchanged original markup.
- [x] Trace React's cancellation at the request/tab lifecycle boundary. Only change cancellation
      behavior if the recorded event identifies a reproducible product cause; retain navigation and
      user-cancellation safety.
- [x] Run focused checks, all repository gates, freeze a candidate, doctor/standalone verification,
      then real-model lens runs on the original six targets. Classify failures before another attempt.
- [x] Verify additional public pages and original Baidu/QQ/Hugging Face/Lark cases when reachable.
      Inspect screenshots, ordinary text coverage, tables, scroll persistence, resize, reopen and zoom.
      Do not infer visual acceptance from ready/HTTP 200 or hide an inaccessible target.

## Review focus

1. A fixed/sticky sibling must not be discarded because another source scrolled off-screen.
2. Preformatted source whitespace and code semantics must survive the read-only copy.
3. Table sections detached from their table must retain a valid sizing context.
4. Structural safety checks must consider current visible native surfaces without broad unsafe
   fallbacks or stale peer obstacles; ordinary paragraphs must remain readable.
5. A same-document URL change differs from destroying the page; explicit close/navigation still
   must cancel requests and remove previews.

## Evidence ledger

- Baseline: six-site report and immutable local `lens-translation-random-*` evidence retained.
- No production edits at plan creation. Code-block translation policy asked asynchronously;
  continue with independent coverage/layout work while awaiting the preference.
- Diagnostic cleanup: two ordered-cleanup tests failed against the old `finally` behavior and
  passed after independently attempting cleanup/persistence while rethrowing the first failure.
  A real JS.info load timeout retained an evidence JSON and restored settings. Visual readiness
  now uses DOMContentLoaded plus stable fonts/text/height, not completion of unrelated embeds.
- Header/table sizing: reproduced the HN-class failure in a synthetic table fixture (login at
  x=160.75 instead of the right edge beyond x=1000). A table formatting context restores width.
- Render budget: a parent rejected around a live canvas consumed the child budget again; the
  two-column synthetic regression failed unsupported, then passed when only retained copies
  consume the 6,000-node limit. No cap increase.
- JS.info trace: the first four paragraphs formed a safe flow, but a 24-pixel English expansion
  collided with an SVG image embedded as an `object`. It was incorrectly treated like a live
  HTML/PDF embed. Supported image objects now become inert original-URL image copies; other
  objects remain native. A regression failed before the change and passed after it.
- Code: no preference reply received while independent work continued. Chose the recommended
  conservative `pre` preservation policy and announced it: original code/comments/strings and
  whitespace remain native, prose outside translates. Unit test reproduced collapsed source
  text entering requests; unit/browser tests now assert unchanged code and no code request.
- Scroll discovery: reproduced a sidebar changing from normal flow to fixed after its parent
  leaves the viewport. It disappeared from translated spans. Traversable known-node ancestry
  fixes it without bypassing visibility/editability. Regression failed then passed.
- Guarded that repair against cache starvation: 128 off-screen owners must not consume the
  next viewport's discovery budget. The additional unit test failed, then passed after only
  currently visible cached source nodes were allowed to retain traversable ancestry.
- Seven focused browser regressions passed; 164 translation/diagnostic unit tests passed before
  the final ancestry change. Full repository gates and frozen multi-site verification follow.
- React cancellation did not recur in an initial real-model probe: two requests completed and
  no local AbortController abort was recorded. This does not establish its earlier cause or
  justify changing cancellation semantics. Retain the original failed evidence and test again.
- JS.info candidate evidence: `e2e/.runtime/lens-translation-random-javascript-1789902858894/`.
  Twelve stages ready; screenshot confirms all four opening paragraphs and native two-line code.
  This was before the final ancestry change and is not the final frozen verification.

## Frozen live matrix (declared before the final batch)

Use one authenticated canonical Profile serially. All targets require standalone readiness and
real-provider native-lens execution. Full diagnostics exercise twelve recorded stages; restricted
initial-only investigations are labeled and do not count as full interaction passes. Every failure
keeps its original attempt directory; no silent retries or replacements. Readable ordinary text,
native typography, coherent layout, code preservation and unchanged originals require screenshot
review as well as structural measurements. Context delivery is not proof of model comprehension.

| Sample                         | Direction | Width / anchor            | Structure                                        |
| ------------------------------ | --------- | ------------------------- | ------------------------------------------------ |
| translation-random-hackernews  | zh-CN     | 1440                      | Table layout, dense links, compact header        |
| translation-random-runoob      | en        | 1024                      | Affixed sidebar, article, code                   |
| translation-random-react       | zh-CN     | 1440                      | Sticky documentation and code                    |
| translation-random-w3c-table   | zh-CN     | 1024 / Delivery slots:    | Actual row/column-header data table              |
| translation-random-javascript  | en        | 1440                      | Long prose, SVG objects, code                    |
| translation-random-sina        | en        | 1440                      | Dense portal/news layout                         |
| translation-diversity-python   | zh-CN     | 1440                      | Definition lists, inline syntax, long tutorial   |
| translation-diversity-vue      | en        | 1024                      | Nested navigation, Chinese prose, code examples  |
| translation-baidu-readable     | en        | 1440                      | Compact menus, hot-news list, form exclusion     |
| translation-qq-readable        | en        | 1440                      | News cards, badges, photos and native live media |
| translation-hf-safety          | zh-CN     | 1440                      | Article, mixed inline links and illustrations    |
| translation-lark-readable      | en        | existing readiness target | Authenticated Docx document and table            |
| translation-lark-wiki-readable | en        | existing readiness target | Wiki document/table and editor boundaries        |

The two new sample contracts are ignored local data under `e2e/samples/`, not new authentication
or execution paths. Inaccessible/login-blocked targets remain unverified, not passed.

### Frozen-candidate findings in progress

The first frozen bundle is `page-content.iife.ts-COqLyBTv.js` and
`background.ts-DBM7YBHa.js`. Gates passed: 1,696 unit tests, 115 browser tests, format,
zero-warning lint, typecheck, bundle audit, sandbox check, 37 valid sample definitions and all
13 standalone readiness checks. Those gates did not establish a clean live-page pass.

- HN (`lens-translation-random-hackernews-1789903707632`): header width is repaired, but the
  settled lower-page news table still loses translations. Preserve as an open product defect.
- Runoob (`lens-translation-random-runoob-1789903878370`): fixed sidebar retains translations
  after scrolling. Its non-`pre` code sample still translates Chinese example literals; the
  new `pre` protection is not a universal code detector.
- React (`lens-translation-random-react-1789903961653`): no model abort on the full run;
  screenshots show readable prose and intact code. Some scroll stages still report unsupported,
  and the gesture probe recorded one 24-pixel event offset. Do not report universal zero lag.
- W3C (`lens-translation-random-w3c-table-1789904012228`): row/column headers and cells retain
  their shared table and code remains preformatted. The initial state snapshot preceded another
  translating frame, so initial terminal-state consistency requires a stricter diagnostic check.
- JS.info (`lens-translation-random-javascript-1789904071351`): twelve stages ready, code and
  SVG-object illustrations intact. A 24-pixel RAF-only scroll discrepancy remains in the probe.
- Sina (`lens-translation-random-sina-1789904134238`): source screenshot timed out waiting for
  fonts before opening the lens. Zero translation requests; this is unverified, not a product
  translation failure or a pass. Cleanup and evidence persistence succeeded.
- Python (`lens-translation-diversity-python-1789904199875`): definitions and tutorial prose
  are readable; native search/select controls remain. Unsupported toolbar boundary needs to be
  distinguished from ordinary content omissions.
- Baidu (`lens-translation-baidu-readable-1789904353449`): screenshot retains original-size
  menu/hot-search text, native single-line ellipsis and separated badges. The input placeholder
  remains native. This viewport does not scroll; zero scroll events is not a scroll pass.

The first batch completed before further product edits. Exit code zero alone is not a visual
acceptance result. Additional reviewed evidence:

- QQ (`lens-translation-qq-readable-1789904411074`): initial and scrolled headlines, ordinary
  product links and photo-caption cards translated at native sizes. Video pixels and banners
  intentionally stay original. The scroll probe recorded 32 events, 12 matched groups, zero
  sampled offsets; the dynamic page still had frequent long tasks and stationary replacements.
- Hugging Face (`lens-translation-hf-safety-1789904520240`): article paragraphs, heading and mixed
  inline links translated; the skewed Team badge/unsupported native UI stay original. Static
  illustrations are unchanged. Four matched groups had zero offset in 32 scroll events.
- Vue (`lens-translation-diversity-vue-1789904300446`): sidebar/prose translated and code retained;
  all 12 stages ready, three matched groups with zero offset in 32 scroll events.
- Docx (`lens-translation-lark-readable-1789904767962`): all 14 stages ready. Reviewed both initial
  and horizontally panned screenshots: table headings/cells and paragraphs are English, columns
  remain coherent, watermarks retained. Three matched groups, zero offset in 32 scroll events.
- Wiki (`lens-translation-lark-wiki-readable-1789904853695`): reviewed the mounted module table
  and numbered lists after TOC navigation and scrolling. Ordinary cells translated; the adjacent
  whiteboard/native boundaries remain original as explicitly scoped. Three matched groups with
  zero offset in 32 scroll events. Both Lark pages hydrate and update their own DOM, so live text
  counters alone are not proof of source mutation by the translator; deterministic tests separately
  assert original text/styles/markup invariance. No document-editing actions were performed.

## HN footer follow-up and diagnostic corrections

The retained trace (`lens-translation-random-hackernews-1789905050278` and the initial-only
bottom probe `lens-translation-random-hackernews-1789905347251`) isolated a 1.5px intersection:
the translated news table's empty rectangular backing touched the centered footer, while the
last actual text (More) was far to the left. The entire table was previously rejected. No native
surface intersected this region, and translation requests had completed. This is not a model
or missing-source explanation.

The generic correction permits a sibling cutout only when no copied glyph/graphic is touched,
the source footprints do not overlap, and both surfaces share a scroll anchor. It does not use HN
selectors, shrink fonts or patch source nodes. A final pass checks the peer's translated footprint
and caches any larger empty cutout relative to its source anchor. True text overlap still rejects
the island. The safety bounds remain unchanged.

- `translation-empty-peer-red-layout.log`: empty-overlap regression failed; actual glyph-overlap
  safety regression passed. The preceding `translation-empty-peer-red.log` was a fixture mapping
  error, not product evidence, and is retained separately.
- `translation-empty-peer-green.log`: nine focused browser tests passed on the first candidate.
- `translation-expanded-peer-red.log`: an expanding translated footer exposed a real missing
  second-pass safety check. The initial conservative guard then rejected harmless background
  overlap (`translation-expanded-peer-green.log`), also retained as failed evidence.
- `translation-release-focused.log`: ten focused tests passed after checking both footprints;
  the positive case asserts the footer is outside the actual clip path before/after a scroll and
  original markup is unchanged. The unsafe overlap cases still preserve the original island.
- `lens-translation-random-hackernews-1789906742503`: an intervening real-provider attempt failed
  with `TRANSLATION_RESPONSE_INVALID`. Recorded output for text-81 closed m6 with m7 and duplicated
  the m7 closing marker. Keep this failure; do not weaken marker validation or call it a layout
  pass. The final frozen run below is a separate attempt, not a replacement of failed history.

The diagnostic now captures the current Chrome frame directly through its canonical session,
avoiding Playwright's unrelated late-font screenshot wait. It verifies the same terminal state
and request count both before and after the captured frame. This prevents the initial W3C snapshot
from being labeled ready while an asynchronous request has already changed the frame. Cleanup
still independently restores zoom/settings/probes even when capture or execution fails. Temporary
production/console layout traces were removed before the final build.

## Second frozen candidate — defects retained, not an all-pass claim

Frozen page bundle: `page-content.iife.ts-AyRdWtot.js`; background:
`background.ts-DBM7YBHa.js`. The first-batch evidence above describes the earlier COqLyBTv bundle,
not this candidate.

Gates before the second matrix: formatting, warning-free ESLint, typecheck, 1,696 unit tests
(138 files), 118 browser tests, 17-asset bundle audit, sandbox check and 37-sample catalog passed.
The two additional regressions below were added only after these counts were recorded.

All 13 targets completed canonical standalone readiness and a real-provider attempt. The HN
attempt stopped at its model error; twelve completed their full 12-stage interaction sequence
(Docx has two additional horizontal-scroll stages). Inspected initial/scrolled screenshots:

| Target       | Evidence suffix | Second-batch observation                                                                                                                                                 |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baidu        | `1789907690781` | Readable, same-size menus/hot-search text, ellipsis/badges coherent. Native search input unchanged.                                                                      |
| QQ           | `1789907758304` | Ordinary headlines, cards and product links translate; video/banner pixels stay original. Some compact labels are heavily ellipsized.                                    |
| Hugging Face | `1789907875999` | Paragraphs, inline links and article heading coherent; static images unchanged, skewed/native UI excluded.                                                               |
| Lark Docx    | `1789907955925` | All 14 stages ready; English table cells/headers remain coherent after horizontal panning, watermarks retained.                                                          |
| Lark Wiki    | `1789908055240` | Mounted module table and numbered lists translate; adjacent whiteboard/native boundaries stay original.                                                                  |
| JS.info      | `1789908216816` | All 12 stages ready; prose, original SVG and preformatted code coherent. RAF-only 24px scroll discrepancy remains.                                                       |
| Runoob       | `1789908298988` | All 12 stages ready; affixed sidebar/prose readable. Non-`pre` HTML demonstration labels also translate; this is not a general code detector.                            |
| Python docs  | `1789908390603` | Prose/definitions and code preserved; native selects/search and constrained toolbar remain mixed.                                                                        |
| Vue          | `1789908499253` | All 12 stages ready; sidebar, prose and tooltip coherent, preformatted code original.                                                                                    |
| React        | `1789908154312` | Prose/sidebar readable, code original; top native toolbar excluded. Cancellation did not recur. Old geometry probe reported 192px and needs source-match disambiguation. |
| Sina         | `1789907435027` | **Fail:** 100 initial translated blocks but nested inline menu links overlap. Old scroll probe reported 288px; cannot call a scrolling pass.                             |
| W3C table    | `1789907619999` | **Fail:** initial ordinary main/table stays English while 7 sidebar blocks translate; becomes ready/40 after scrolling.                                                  |
| Hacker News  | `1789907304925` | **Fail:** initial ready/56, then model-invalid inline markers on scroll. No abort. The failed attempt and malformed marker shape are retained.                           |

No image input was sent. Context was present and under the 6,000-character bound for ordinary
requests; one Python navigation batch had no available context. Context delivery does not prove
that a model used it correctly. Source DOM hydration continues on live pages; isolated fixtures,
not raw live change counters, establish that the lens never writes source text/styles.

## Focused repair after the second matrix

- Two new browser fixtures first failed against the frozen candidate
  (`translation-menu-pinned-red.log`): a fixed native input inside the same sliced-flow parent
  was covered, and nested inline menu anchors ignored width/ellipsis.
- Fixed occluder membership to use actual copied flow children rather than the excluded common
  parent. Isolated inline labels in an overflowing flex menu get a block box, retaining font size
  and the existing ellipsis contract. Neither repair uses website names or selectors.
- All 12 focused browser regressions passed (`translation-menu-pinned-green.log`). These
  checks assert actual clipping/geometry, unchanged source markup and no draft text request.
- The diagnostic now requires source height as well as origin/width and rejects ambiguous
  fixed/static source matches. Per-pair offsets and unmatched/ambiguous counts are retained;
  excluded matches are not zero-offset passes. This changes measurement, not product behavior.
- Real W3C/Sina/React follow-up is recorded separately below after completion. A fixture pass
  alone does not establish that the W3C live omission is fixed.

Follow-up on `page-content.iife.ts-R0_MrHC-.js`:

- W3C `1789908692477`: initial screenshot now contains translated main paragraphs, caption,
  column/row headers and cells. The excluded native Back to Top control accounts for the initial
  unsupported state (39 translated blocks); later stages have 40. The large main/table omission
  is no longer present. Two matched groups, 32 scroll events, zero sampled offsets.
- Sina `1789908764536`: all twelve interaction stages completed. Inline labels no longer paint
  across their boxes, but tightly touching words still hurt readability. Added a minimum-gap
  assertion, reproduced a 0px gap (`translation-menu-gap-red.log`), and reserve half an em
  between shrunken flex items. Some ordinary lower headlines still remain Chinese: **do not
  classify the whole site as complete coverage**. Native ad/iframe pixels are a separate exclusion.
  Five reliably matched groups had zero offset in 32 scroll events; two unmatched groups remain
  unmeasured. The former 288px reading used an insufficient source-match predicate.
- React `1789908972170`: completed all stages without model cancellation. The corrected probe
  separately identifies the sticky header and sidebar; all four groups have zero sampled offset
  across 32 scroll events. Prose/code screenshots remain readable; this does not prove there is
  no compositor-frame lag on every page (JS.info's RAF-only discrepancy is still retained).

Final gap refinement and repository gates are recorded below. The first attempted final build
and lint caught optional-array indexing/non-null assertions in the new spacing test; corrected
the test's TypeScript guards, without weakening its geometry assertions or touching production
behavior to satisfy it. Failed logs are retained separately from the corrected gate logs.

The subsequent full-browser run (`translation-final-browser.log`, bundle D4wckCst) caught a
real regression: 119 passed, one existing non-shrinking menu test failed (20px actual spacing,
18px maximum). The new gap had been added on top of reduced source margins. Use one shared
gap and zero decorative item margins only inside this already-overflowing menu adjustment.
Do not weaken the old assertion; both nested-inline and existing inline-block menu cases must
pass. The failed candidate/evidence is retained and is not a release acceptance result.

## Latest frozen build and remaining acceptance boundaries

Frozen assets: `page-content.iife.ts-DDHlAb-0.js` and `background.ts-DBM7YBHa.js`.
The corrected focused run passed 44 browser tests, including both old and new menu spacing
assertions and the complete document/table structure suite. The fresh unit run passed
1,696 tests in 138 files. Latest full-browser and real-page results follow below.

Retained findings are not silently reclassified as passes:

1. Sina ordinary lower headlines can remain untranslated even when a stage says ready.
   The navigation overlap/spacing repair does not prove complete portal coverage. This needs
   separate source-discovery/budget evidence; native advertisements do not explain all of it.
2. Two HN attempts produced malformed inline markers. Invalid output remains rejected, cannot
   enter the completed cache, and is not repaired by guessing missing tags. Retry remains explicit.
3. JS.info had a 24px RAF-only discrepancy during real wheel scrolling. The fixed overlay can
   trail compositor scrolling; a static screenshot or zero event-time offset cannot prove no lag.
4. Model wording is not deterministic (for example, repeated Open/Closed table labels can use
   different synonyms). Context delivery and correct layout do not establish perfect terminology.

Separate intentional boundaries: original image text, whiteboards, video/Canvas/iframe content,
native drafts/inputs, and unsafe independent compositing remain original. Preformatted code is
preserved, but arbitrary non-semantic div-based code examples are not automatically recognizable.
No extra dependencies, site-specific renderer rules, OCR or document writes were introduced.

### Fresh repository gates for DDHlAb-0

| Command                                             | Result / retained log                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run format:check`                              | Pass, `translation-gap-corrected-format.log`                                            |
| `npm run lint`                                      | Pass, zero warnings, `translation-gap-corrected-lint.log`                               |
| `npm run typecheck` / `npm run build`               | Pass, `translation-gap-corrected-typecheck.log` / `translation-gap-corrected-build.log` |
| `npm run test:run -- --maxWorkers=2`                | 138 files / 1,696 tests pass, `translation-gap-corrected-unit.log`                      |
| `playwright test --config e2e/playwright.config.ts` | 120 tests pass in 4.7 minutes, `translation-gap-corrected-browser.log`                  |
| `npm run audit:bundle`                              | Pass, 17 assets, `translation-gap-corrected-audit.log`                                  |
| `npm run check:sandbox`                             | Pass, `translation-gap-corrected-sandbox.log`                                           |
| `npm run e2e:catalog:validate`                      | Pass, 37 samples, `translation-final-catalog.log` (no subsequent catalog edits)         |
| `git diff --check`                                  | Pass                                                                                    |

Playwright prints the environment's existing NO_COLOR/FORCE_COLOR warning; this is not a new
application/lint warning. No test assertion was weakened, no source files excluded for coverage.
Tests run against the production build. The real native-lens runs use the canonical existing
authenticated Profile serially after doctor and per-target standalone verification; fixture/model
mocks are not used for those runs.

## Additional portal sampling and visible-cache repair

The user requested generic fixes and portal sampling. Added canonical read-only local sample
contracts for hao123 and NetEase (163); the catalog now contains 39 valid samples. Together with
Sina and QQ this gives four portals, and 15 distinct targets across this investigation. A visited
target is not automatically a pass. Existing failures above remain part of the evidence.

DDHlAb-0 acceptance follow-up: Baidu `1789910340147`, QQ `1789910403506`, Docx
`1789910522565`, Wiki `1789910620838`, W3C `1789910266804`, and Sina `1789910061955`
completed their full interaction sequences. Screenshots confirm readable ordinary text, original
font sizes, coherent document tables and unchanged illustrations on the first five. Sina still
lost ordinary lower-page headlines; its process exit zero is not visual acceptance. HN
`1789910716983` is a focused initial-only footer investigation, not a full stability pass.

New portal baseline findings:

- hao123 `1789910877066`: failed to reach a quiet terminal state after continuous scrolling.
  Initial screenshot has omitted ordinary links and crowded weather/date text. The gesture probe
  recorded a 99px maximum RAF-only discrepancy (event-time maximum zero). This is a retained
  product/settling failure, not an authentication problem or a passed run.
- NetEase `1789911152775`: twelve stages completed, but ordinary top navigation stayed Chinese.
  Main news columns were readable. Original advertisements/images are a separate intentional
  exclusion and do not explain the navigation omission.

Two generic fixtures reproduced further causes before implementation:

1. A 200-link visible grid lost the final 72 entries because the same 128-entry bound capped
   visible discovery, active IDs and completed results. Visible entries/results are now retained;
   only off-screen history is limited to 128. The existing 10,000 source-node traversal and 6,000
   retained-layout-node budgets remain, as do two request slots and 32 blocks per request.
   Exceeding the traversal limit is reported as unsupported instead of silently ready.
2. A flex menu could fit without horizontal overflow while leaving only 3.98px between words.
   Compare lost source spacing as well as overflow, reserving half an em and retaining native
   fonts/ellipsis. No website domains, names or class selectors enter either repair.

Red evidence: `translation-dense-source-red.log`, `translation-dense-menu-red.log`, and
`translation-dense-menu-red-evidence/`. Green evidence: 52 DOM unit tests in
`translation-dense-source-verified.log`, 46 focused browser tests in
`translation-dense-menu-green.log`. The unit suite also verifies 200 active plus at most 128
off-screen retained entries. The active working set can consequently be larger on dense pages;
this trades bounded additional memory/work for not silently dropping visible content.

Frozen BxA4QNpJ assets passed 1,697 unit tests (138 files), all 122 browser tests, typecheck,
warning-free lint, build, bundle audit and sandbox checks. Logs use `translation-dense-fix-*`.
Fresh initial-only real-model observations (not full interaction acceptance):

| Portal  | Evidence suffix | Screenshot result                                                                                                            |
| ------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Sina    | `1789911750678` | Lower ordinary news now translates; flex menus retain separated labels.                                                      |
| hao123  | `1789911806383` | More ordinary links translate, but weather/date and rotating text overlap; lower ordinary content still omitted. Not passed. |
| NetEase | `1789911968490` | Main news remains readable; ordinary floated navigation remains untranslated. Not passed.                                    |

The optional layout diagnostic records only tag names, geometry and computed CSS ancestry, not
source text, credentials or request bodies. NetEase's retained ancestry identifies a block with
left-floated single-line anchor children, distinct from the earlier flex navigation. A generic
floated-row regression and the corresponding shared-layout repair are being evaluated next.

## Floated-row correction and remaining portal defects

The generic float fixture failed with translated glyphs reaching y=141 below a source row ending
at y=88 (`translation-float-links-red.log`; screenshot/trace in
`translation-float-links-red-evidence/`). The correction recognizes an originally single-line,
left-to-right row consisting only of isolated links; when translated children wrap out of it,
the copy uses bounded flex spacing/ellipsis at the source font size. The source DOM is untouched.
A separate multi-row float fixture ensures that real lists are not flattened into navigation.

The first focused run had 46 product-test passes and one extension startup failure before the
table fixture could begin: the Side Panel readiness locator timed out. The environment doctor
had inadvertently rebuilt the same assets during that fixture run. Preserve the failed trace in
`translation-float-startup-failure-evidence/`; do not classify it as a table assertion regression
or silently count it as a pass. The subsequent full suite runs against frozen assets with no
rebuild. Doctor's six checks passed separately.

Frozen assets are now `page-content.iife.ts-CFhAFJns.js` and `background.ts-DBM7YBHa.js`.
NetEase `1789912606940` completed all twelve real-model stages. Its ordinary news remains readable;
four reliable groups had zero sampled offset in 32 real wheel events (one ambiguous match is
excluded, not counted as passing). However, **the initial ordinary top navigation still stays
Chinese**. The float fixture demonstrates a repaired general layout bug but does not prove that
this site's navigation omission is fixed. Keep this visual failure open.

The extra hao123 BxA inspection `1789912270915` failed initial quiescence after 25 requests;
that failed attempt is retained too. Source-layout inspection now runs before invoking translation,
so a model/settling failure cannot discard the source-side diagnostic. A `source-only` diagnostic
mode uses the same canonical readiness/Profile and sends no translation request; it is never
counted as a translation or interaction pass.

The CFhAFJns hao123 attempt `1789912783317` again failed initial quiescence after 150 seconds.
Its 23 requests all completed without transport failure or local abort; late requests were small
one-to-five-block batches spread over 144 seconds. The screenshot still shows overlapping
weather/rotating search text and untranslated ordinary lower-page content. This is not resolved
by the visible-cache fix, and it is not explained by the intentional image exclusion. The CSS
ancestry for the selected tab includes an absolutely positioned strip of inline-block labels;
that observation alone is not enough to assign the whole failure to one layout rule.

NetEase's source-only follow-up `1789912991558` verifies that the inspected ordinary navigation
has no hidden/inert/editable ancestor, active animation, filter or unusual blend/clip in the
captured chain. Therefore those exclusions cannot justify calling its omitted navigation an
intended native boundary. Its remaining discovery/layout rejection needs further diagnosis.
The hao123 source-only `1789913002636` selected label had no visible exact match; no inference
about coverage is drawn from an empty source probe.

### Current frozen repository gates

- `npm run test:run -- --maxWorkers=2`: **1,697 tests / 138 files passed**.
- `playwright test --config e2e/playwright.config.ts`: **124 passed in 4.9 minutes**, including
  the previously unstarted editor-sentinel table test, the float regression and multi-row guard.
- `npm run format:check`, `npm run lint` (zero warnings), `npm run typecheck`: passed.
- `npm run audit:bundle`: 17 assets passed; `npm run check:sandbox`: passed.
- `npm run e2e:catalog:validate`: 39 samples passed; `git diff --check`: passed.

Logs are `translation-portal-final-*`; the last diagnostic-only edits have separate
`translation-portal-final-diagnostic-{lint,typecheck}.log` checks. No rebuilds occurred during the
full 124-test run or the subsequent live acceptance batch. These gates do not erase the real
portal failures above. No commits or pushes were performed.

## Completed CFhAFJns live acceptance batch and fixed-descendant diagnosis

All five targets passed their standalone readiness contract and used the real provider. No image
inputs or local model aborts were recorded. Stage completion is not sufficient visual acceptance:

| Target | Evidence suffix | Stages | Reviewed result                                                                                                                                                                       |
| ------ | --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sina   | `1789913012994` | 12     | Main news and initial menus readable; fixed navigation partly remains Chinese after scrolling. Partial, not whole-site acceptance.                                                    |
| QQ     | `1789913207199` | 12     | Main headlines/captions readable at source font sizes; compact product-icon links remain crowded. Video pixels intentionally unchanged.                                               |
| Baidu  | `1789913324756` | 12     | Readable menus/news, native ellipsis and separate badges. Zero scroll events because this viewport fits the page; no scrolling claim.                                                 |
| Docx   | `1789913388401` | 12     | Reviewed title, paragraphs and four-column table translate coherently. The source screenshot already has the English watermark; it was not translated.                                |
| Wiki   | `1789913474333` | 14     | Initial table and horizontal pan are readable, but `scroll-down.png` loses ordinary table rows and the following paragraph. This is a product failure, not an image/native exclusion. |

The Wiki failure is reproducible. Temporary geometry-only logging in two diagnostic candidates
(`1789914041464`, `1789914227559`) locates rejection at the peer-collision guard, not the node
budget, native media or provider timeout. The first growing table belongs to a four-child flow;
its expansion collides with the next table header, because an independently fixed descendant
prevents the surrounding document from remaining one flow. The normal-flow island was removed.
These temporary logs are preserved as `translation-layout-probe-*`; logging was removed from
production and the diagnostic before the repair build.

A site-independent regression with a fixed descendant header, growing table, paragraph and
second table failed with `unsupported` (`translation-fixed-descendant-red.log`, screenshots and
trace in `translation-fixed-descendant-red-evidence/`). The repair assigns each fixed descendant
its own paint context: normal flow omits that descendant, ownership does not swallow its separate
island, and the surrounding ordinary content can reflow together. Paint order/native occlusion
guards remain enabled. No domain, class or document content is used in the repair. Focused and
full frozen validation follows; the pre-repair live failures above remain part of the record.

Safety refinement: a second fixture exposed that a directly fixed input, excluded from source
discovery, could be covered by the enlarged parent copy. `translation-fixed-input-red.log` and
`translation-fixed-input-red-evidence/` preserve that failure. Parent grouping only omits fixed
descendants present in the observed pinned-surface set; unknown/excluded fixed controls keep the
previous grouping boundary. The first full-browser attempt (`translation-fixed-descendant-browser.log`)
was deliberately interrupted with exit 130 to validate this refinement, not counted as a pass.
The separate 63-test focused run and 1,697-unit-test run of the first candidate had passed; final
gates and live tests must use the refined candidate below.

Final live recheck matrix (declared before execution): Wiki, Baidu, Docx, Sina, QQ, NetEase and
hao123, serially in the same legitimate Profile after doctor and per-target standalone verify.
Keep every failed attempt and inspect screenshots, including scrolling, not only terminal states.
No provider mocks or additional site rules will be introduced for these checks.

### Refined frozen candidate gates

Final assets: `page-content.iife.ts-BF0G2LuV.js`, `background.ts-DBM7YBHa.js`.

- 18 focused regression tests passed (`translation-fixed-input-green.log`).
- All 1,697 unit tests / 138 files passed (`translation-pinned-final-unit.log`).
- All 126 browser tests passed in 4.9 minutes (`translation-pinned-final-browser.log`).
- Format, zero-warning lint, typecheck, build, six doctor checks, 17-asset bundle audit,
  sandbox and 39-sample catalog checks passed (`translation-pinned-final-*`).
- Temporary probe logging is absent from both production and the diagnostic.

The real Wiki recheck `1789915270853` **still fails visual acceptance**: initial and horizontal
table translations work, but scrolling down and moving the lens can remove ordinary translated
rows. The fixed-descendant change repairs the minimal fixture, not the whole live-page failure.
Do not infer complete root-cause resolution from that fixture. This attempt's one scroll group
cannot be unambiguously matched to its source, so zero reported offsets do not establish a
scroll-lag pass. The remaining live-page grouping/rejection condition is not yet fully diagnosed.
The candidate is retained uncommitted, with both failed live evidence and successful targeted
regressions; no rollback, commit or push was performed.

## Final seven-site acceptance — BF0G2LuV

The final serial batch completed on 2026-09-20 with a **failed acceptance outcome**. All seven
standalone readiness checks passed. Six targets completed their interaction sequence; hao123
stopped at the initial quiet-state gate, so its later interactions were not tested. The batch
exited 1. A completed sequence, `ready` status or HTTP 200 is not a visual pass.

The four portal targets were Sina, QQ, NetEase and hao123, selected before the batch. They were
not replaced with easier targets after failures. The same frozen extension, canonical authenticated
Profile and real provider were used throughout; no provider mocks, custom authentication, site
selectors or domain-specific production repairs were added. The existing document privacy adapter
is unchanged; this does not claim that the entire product has no pre-existing site adaptation.

| Target    | Evidence directory under `e2e/.runtime/`            | Result from reviewed initial/scroll screenshots                                                                                                                                                                                                                                                 |
| --------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sina      | `lens-translation-random-sina-1789915567439`        | Partial. Main headlines, captions and scrolled news are readable, but the fixed utility navigation returns to Chinese after scrolling. These are ordinary DOM labels, not excluded image text.                                                                                                  |
| QQ        | `lens-translation-qq-readable-1789915757330`        | Partial. Main headlines, photo captions and scrolled news retain readable fonts and native ellipsis. The compact product-icon links still crowd one another. Live video/image pixels remain unchanged by design.                                                                                |
| NetEase   | `lens-translation-random-netease-1789915885519`     | Partial. Main headlines, two-column lists and scrolled cards translate readably. The initial ordinary category navigation remains Chinese; this is a coverage failure, not an intentional media exclusion.                                                                                      |
| hao123    | `lens-translation-random-hao123-1789916032278`      | Failed initial acceptance. Weather/date/rotating search text and movie metadata overlap, and ordinary lower navigation/news remains untranslated. The wait for a quiet terminal state also encountered HTTP 503 and transport failures. No scroll/resize/reopen acceptance result is available. |
| Baidu     | `lens-translation-baidu-readable-1789915420046`     | Reviewed initial layout passes: readable navigation/news, native ellipsis, separate ranking badges and legible search button. Inputs and image logos remain native. The interaction sequence completed, but there were no actual scroll events at this viewport.                                |
| Lark Docx | `lens-translation-lark-readable-1789915485550`      | Reviewed initial and scrolled title/prose/four-column table pass: coherent rows and subsequent paragraphs, without shrinking translated text. This is acceptance of the observed document/table, not a claim about all Lark content.                                                            |
| Lark Wiki | `lens-translation-lark-wiki-readable-1789915270853` | Failed. Initial and horizontal table translation works, but downward scrolling removes translations from ordinary table rows and the following paragraph. The fixed-descendant fixture repair did not fully solve this live-page case.                                                          |

For each directory, `source.png`, `initial.png` and `evidence.json` are retained. Completed
sequences also retain `scroll-down.png`, resized/moved/zoom/reopen screenshots and source-after
evidence. Logs are `translation-pinned-final-live-<sample-id>.log`; standalone results are
`translation-pinned-final-verify-<sample-id>.log`. The Wiki URL resolved to the currently authorized
document during this run; document content can differ from the user's older screenshot.

### Transport, context and stability limits

| Target  | Requests | Context characters per request | Local aborts | Scroll measurement                                                                                         |
| ------- | -------: | ------------------------------ | -----------: | ---------------------------------------------------------------------------------------------------------- |
| Wiki    |        8 | 450–1,653                      |            0 | 32 events; the only group was ambiguous, so zero-offset fields cannot establish a pass.                    |
| Baidu   |        2 | 675–1,001                      |            0 | No scroll events; zero-offset fields cannot establish a pass.                                              |
| Docx    |        4 | 419–1,364                      |            0 | 32 events; the only group was ambiguous, so zero-offset fields cannot establish a pass.                    |
| Sina    |       13 | 286–1,656                      |            0 | 32 events; 5/7 groups reliably matched with zero event/frame offsets; 2 unmatched.                         |
| QQ      |        8 | 606–1,981                      |            0 | 32 events; 12/12 groups matched with zero event/frame offsets and no group replacement during the gesture. |
| NetEase |       14 | 509–1,206                      |            0 | 32 events; 4/5 groups reliably matched with zero offsets; 1 ambiguous.                                     |
| hao123  |       20 | 635–1,481                      |            0 | Initial gate failed before the scroll probe.                                                               |

All recorded requests are text-only and contain non-empty page context. This proves delivery,
not that the model always uses context correctly. The first six sites recorded no HTTP/transport
failure. hao123 recorded one HTTP 503 and two transport failures; 20 is the final evidence count
(the initial stage log had observed 19). Do not diagnose this as the previous 60-second local
abort: no local abort was recorded, and layout defects are independently visible in its screenshot.

Stationary probes recorded no hidden frames, but QQ replaced mirrored groups 9 times across 56
sampled frames, and NetEase 11 times across 205 frames. Dynamic content invalidation/replacement
therefore remains a stability concern. Other completed targets recorded zero replacements in
their stationary probes. A finite probe and ambiguous/unmatched source groups are insufficient
to claim that dragging/flickering is eliminated everywhere.

### Remaining work and handoff

The generic changes repair demonstrated cache truncation, compact-link spacing/float wrapping,
table sizing and an isolated fixed-descendant flow case, and the final automated gates pass.
They do **not** meet the user's complete-translation-and-layout acceptance target across the
live matrix. Do not mark the overall repair complete or release this candidate as all-sites stable.

Remaining investigation must stay generic: trace ordinary navigation rejection and source-to-copy
ownership on scroll; resolve the Wiki flow/peer-collision case without disabling native-surface
protection; constrain compact icon/text and fixed-height metadata layouts; attribute repeated
mirror invalidation before changing update scheduling. Preserve the failed screenshots and rerun
the same targets after corrections. HTTP/transport recovery must be assessed separately from
layout/coverage, without retrying malformed structured model output as if it were a network error.

All changes remain uncommitted. No commit, push, rollback, dependency addition or source-document
edit was performed in this verification task.

## Resumed repair — user requires closure, not a failure-only handoff

Ruling: the previous handoff stopped prematurely. Continue the already approved generic repair
inline in the existing feature checkout; do not ask again for execution approval, create a new
worktree, commit, push or delegate. Keep all previous failures. The same read-only lens, native
font, context and image/OCR-exclusion contract remains binding.

Execution checklist (systematic-debugging, TDD, executing-plans, verification-before-completion):

- [x] Capture geometry/ID-only rejection evidence for the failed NetEase navigation and Wiki
      table flow using the canonical diagnostic, including the collection/render boundary.
      Compare rejected candidates against retained candidates; remove temporary probes before
      final acceptance. Do not disable native-surface or collision safety to manufacture coverage.
- [x] Reproduce the actual rejection in generic browser fixtures, watch it fail, repair
      the responsible shared collect/flow/paint rule, then rerun the same failing real pages.
- [x] Reproduce fixed-height metadata and icon-link collisions from hao123/QQ with generic CSS
      fixtures. Preserve source fonts and structure; verify no overlap and unchanged source DOM.
- [x] Attribute repeated group replacement to its triggering DOM changes before updating
      invalidation. Add a deterministic dynamic-content regression; preserve necessary updates.
- [x] Classify network recovery independently, respecting cancellation and structured-output
      validation. Never treat a provider/transport failure as a successful layout run.
- [ ] Run focused and full repository gates, freeze one build, then repeat the same seven-site
      interaction matrix and review screenshots. Unresolved ordinary text/layout defects are
      required work, not a completion condition.

### Resumed diagnosis and candidate (not acceptance)

- NetEase rejection probes `1789917600226` and `1789918480500` prove that navigation IDs had
  translations but the layout was removed on collision with the immediately following iframe.
  The second probe narrowed the overflow to the **right-floated utility links / fixed-height
  product label**, not the previously repaired left-floated category row. The entire header
  was affected by that neighbour's expansion. No domain predicate is part of the correction.
- Wiki probe `1789917904910` reproduces the scroll-down failure: the safe paragraph/table flow
  collided with the next table's independently promoted sticky header. A sticky header still
  participates in normal flow; keeping it with its safe containing table allows their natural
  reflow together. Fixed controls remain independent and occluded as before.
- QQ source-only geometry `1789918105997` shows narrow flex cells containing an icon, an anchor
  and a separator. Outer-row overflow alone misses an internally overflowing cell; icons can
  collapse to zero width while the row still fits. The repair detects cell overflow, reserves
  decoration widths and gaps, and ellipsizes isolated labels without shrinking their fonts.
- Two browser regressions additionally reproduce a finished entrance animation that never
  becomes translatable, and a harmless color-only link transition that removes translated
  prose. Finished animations are no longer classified as live; color transitions are frozen
  in the readonly copy. Animation/transition completion and cancellation trigger re-observation.
  Genuinely live animation/media boundaries are unchanged.

Red evidence: `translation-resume-portal-red3.log` (three product assertion failures),
`translation-resume-portal-red3-evidence/`, and `translation-motion-red.log` / the separate
`translation-motion-red-evidence/` (two product failures). The earlier red2 fixture contained
an accidentally nested test declaration; that harness failure is preserved but is not a product
result. The first 72-test neighbouring check found one new inline-badge regression; the
fixed-height label rule was restricted to block labels, preserving inline badges' intrinsic growth.

Current verification: narrow unit checks passed 188 tests / 15 files. The subsequent browser
regression run and real-model NetEase/Wiki/QQ/hao123 rechecks are still in progress. Temporary
geometry probes remain in this diagnostic candidate and must be removed before final gates.

### Continuation: live failures were not closed by fixture passes

- `lens-translation-lark-wiki-readable-1789919492216`: all 14 interaction stages reached
  `ready`, including the previously failing scroll-down table, horizontal scrolling, zoom and
  three reopens. The stationary observation retained its groups (0 replacements / 243 frames).
- `lens-translation-qq-readable-1789919635756`: all 12 stages reached `ready`; the four product
  icon/anchor/separator cells are now readable without collapsed icons. The diagnostic still
  found six unnecessary stationary replacements, caused predominantly by hidden widget updates.
- The first NetEase correction was insufficient. `1789919341716` still rejected the header,
  and recorded 22 replacements / 180 stationary frames while scripts changed carousel `left`
  values. Deeper source geometry `1789919975417` revealed **shrink-to-fit float columns**:
  the left category container grows with English labels and pushes the right utility column
  down. The utility list also contains overflow-clipped rows, not just its five visible links.
- Generic corrections retain adjacent float columns' source widths and constrain only the
  originally visible single-line links. No hostname, website classes or source strings are
  recognized. A corrected fixture with the column preservation disabled reproduces
  `unsupported` (`translation-columns-baseline-red.log` and its separate evidence directory).
- Mutation handling skips still-hidden, never-copied branches; revealing them still collects and
  translates them. Pure `left/right/top/bottom` style changes synchronize existing copies;
  typography, content and other style changes still invalidate structure. Both actual failures
  were reproduced in `translation-motion-mutation-red.log`; the motion regression additionally
  checks that a subsequent font change is not ignored. Fixture failures due to missing marker
  responses are retained but excluded from product-failure claims.
- `translation-motion-columns-final-focused.log`: 9 browser checks pass. The current candidate
  also passes 1697 unit tests / 138 files (`translation-mutation-full-unit.log`). Full browser
  validation and remaining live-page fixes are still ongoing; this is not the acceptance build.
- `lens-translation-random-netease-1789920450532`: the ordinary header now translates; all
  34 measured scroll events have zero offset. The remaining two collision probes concern the
  small advertising label over an original iframe, not ordinary navigation. Source request
  identities in new diagnostics are session-local numbers only, to expose repeated requests
  without storing raw source text.

### Further portal repairs and retained red/green evidence

- hao123's composite weather/date cells now retain their original single-line inline-block
  grouping; the shrink/ellipsis budget belongs to the compound label, not each inner word.
  Fixed-height tickers keep their one- or two-line source cell and cannot paint over the next
  slide. The rule preserves separate icon widths and does not shrink fonts.
- The seven-site `oTrh8czn` batch is not an all-pass result: hao123 initial-state quiet checking
  timed out despite all 28 provider requests finishing with HTTP 200. Sina's auto-height top
  menu still wrapped. Both failed artifacts are retained as `1789922656459` and `1789922820135`.
- Sina's actual source has a padded label inside an auto-height floated item. On wrapping,
  its parent's height grows too, so bottom-overflow detection alone misses the defect. The
  corrected check compares translated items' top positions with their originally shared row.
  HTML comments containing retired login markup are non-rendered, not extra label content.
  `translation-auto-menu-red2.log` and `translation-menu-comment-red.log` retain the product
  failures; the separate `*-evidence/` directories preserve their browser artifacts. The first
  auto-menu fixture did not reproduce the real padded structure and is not counted as red.
  Eight portal browser fixtures pass after the two focused corrections.
- QQ's remaining unrelated stationary rebuilds were attributed to hidden 0×0 overflow-clipped
  widgets. They are now classified as unpainted alongside display:none. Revealing the same
  widget still discovers and translates its new text. A zero-height overflow-visible float
  wrapper remains traversable. `translation-zero-clip-red.log` / `*-red-evidence/` preserve
  the failing retained-group assertion. The subsequent motion/portal/paint/readability run
  passes all 45 checks (`translation-zero-clip-green.log`).
- The diagnostic now records bounded text-free settling deltas (IDs, sizes, positions, pending
  requests) to distinguish native carousel activity from provider errors or lost results.
  `1789923672270` is explicitly initial-only, not full acceptance: it reaches terminal with
  29 finished requests after ~145 seconds while the source reveals/rotates additional labels.
  Source geometry independently confirms an active 500 ms translated-position carousel.
  No provider retry, timeout increase, cache broadening or weaker terminal gate was introduced.
- Current frozen build: `page-content.iife.ts-Crp9VS_b.js` with unchanged
  `background.ts-DBM7YBHa.js`. Temporary production tracing was removed before this build.
  Doctor passes all six checks; final canonical interaction runs and screenshot review follow.

### Additional defects found during final screenshot review

- Sina `1789924206894` completes all 12 diagnostic stages and the top menu is corrected, but
  **scroll-down is not accepted**: a bordered selected tab paints its long label across the next
  tab, and the fixed top navigation reverts to original text. Status `ready`/`unsupported` was
  not treated as visual acceptance. The tab regression fails at right edge 201.40625 versus
  the source limit 107.5 (`translation-bordered-tab-red.log` and its retained artifacts).
  Compact-cell budgets now subtract the actual CSS padding/borders rather than count them
  as text space. Nineteen neighbouring motion/portal browser checks pass subsequently.
- QQ `1789924359494` completes 12 stages, with 32 scroll events, 12 matched islands and zero
  sampled position offset or replacement during the gesture. Three stationary replacements
  remain: a sliced flow's common parent was used as the invalidation boundary, so unrelated
  siblings dirtied it. The smaller boundary now uses the actual copied flow children; updates
  to their common parent or ancestor still invalidate. The red fixture reproduces loss of
  the retained-group identity when only the offscreen sibling changes; the green fixture
  additionally verifies that a later real prose change still updates its translation.
  Evidence: `translation-sliced-mutation-red.log`, `*-red-evidence/`, and
  `translation-sliced-mutation-green.log` (19 passes). Live confirmation remains required.

### Fixed-header/native-surface repair

The bounded temporary probe `lens-translation-random-sina-1789924960800` traced rejection of the
entire 46-pixel fixed header to a 240 × 350 iframe scrolled underneath it. There were no peer
collisions. Root/body clipping was inspected independently and was not the cause. The temporary
production console probes and diagnostic capture were removed before the verification build.

The native-surface descriptor now retains its local DOM element identity (never serialized to the
model). Browser hit-test order identifies a source fixed header already above the native surface.
Only matching original/copy opaque background coverage containing all source and translated ink
may remain; empty baseline pixels are clipped. Transparent/translucent overlays, expanded text
outside the original opaque footprint and foreground native media remain protected. No hostnames,
site classes, font shrinking, new dependencies or provider changes were introduced.

`translation-fixed-native-red.log` and `translation-fixed-native-red-evidence/` preserve the original
failing scroll-retention assertion. The first green attempt passed the repaired scroll assertion,
but a later assertion incorrectly required deletion of an already clipped shadow-DOM span. The
foreground-media assertion now verifies actual red iframe pixels instead of mounted-node absence;
the original attempt is retained as `translation-fixed-native-first-green-evidence/`.

`translation-fixed-native-focused.log` passes 38 browser regressions, including opaque/transparent/
translucent fixed headers, a one-pixel empty baseline, foreground media, expanded prose, sliced-flow
invalidation, portal labels and animation boundaries. Doctor passes all six checks. Fresh Sina/QQ
real-provider interaction runs follow; these fixture passes alone do not close live acceptance.

The first real follow-up (`1789925909380`) still failed the fixed-header scroll screenshot. A second
bounded probe (`1789926245290`) proved that hit-test order was correct (source index 1, iframe 8),
but the **original** close/unpin anchor contained a clipped second text line at y=36.5–50.5. Its
unclipped Range rectangle exceeded the 45px header background. Respecting original and copy
ancestor overflow/clip bounds fixes this false rejection without allowing visible ink to grow over
native media. The equivalent fixture first fails after scrolling in
`translation-fixed-clipped-ink-red.log` / `translation-fixed-clipped-ink-red-evidence/`.
The corrected focused run passes 39 cases (`translation-fixed-clipped-ink-green.log`). All temporary
probes were removed again. Fresh anchored and full-site verification is still required.

QQ `1789926062976` completes all 12 stages with readable native-sized ordinary headlines/cards and
separated product icons. The gesture records 32 events, 12 unambiguous matched groups and zero
offset/replacement. Stationary sampling still records 2 group replacements in 215 frames, with no
hidden frame; do not claim all dynamic activity or every repaint has been eliminated. The recorded
549 original nodes have zero disconnected/text/style changes in the checked interval.

### Acceptance candidate CqajJjwU — frozen before the final matrix

The real anchored replay `lens-translation-random-sina-1789926651708` now reaches ready/109
translated blocks. Its screenshot confirms the fixed navigation remains English over the scrolled
iframe, with close-button clipping and the independent advertising surfaces retained. It is an
explicit initial-only reproduction, not a substitute for the full interaction matrix below.

Freeze `page-content.iife.ts-CqajJjwU.js` with unchanged `background.ts-DBM7YBHa.js`. No product
changes/rebuilds during the matrix. Run canonical standalone readiness, then a complete native-lens
diagnostic for Sina, QQ, hao123, NetEase, Baidu, the reported Lark Docx and Wiki, Hugging Face,
W3C's data table and Hacker News. Keep every failed attempt and review screenshots separately from
ready/status metrics. The same dedicated Profile runs serially; no credentials are copied.

Fresh pre-matrix checks: zero-warning lint, typecheck, formatting, 1,697 unit tests / 138 files,
17-asset bundle audit, sandbox check and 39 sample contracts pass. Full browser results follow.
The optional shell-token `check:codex` preflight reported no configured token and made no request;
do not extract credentials or claim this optional CLI check passed. Real-provider verification uses
the already authenticated canonical Chrome Profile.

### Final frozen matrix — live acceptance in progress

The full browser suite on this candidate passes **151 tests** (5.6 minutes). This is fixture
coverage with a controlled model, not a replacement for the real-provider results below. The
ten-site matrix uses `acceptance-20260921-<sample>-verify.log` for standalone readiness and
`acceptance-20260921-<sample>.log` for the native diagnostic. No rebuild occurs between sites.

| Target    | Retained evidence directory suffix             | Interaction result                                                | Visual acceptance / boundaries                                                                                                                                                                                                                                    |
| --------- | ---------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sina      | `translation-random-sina-1789927108047`        | 12 settled ready stages; 10 real requests                         | Initial and scroll-down screenshots: ordinary news, compact menus and fixed navigation translate. Fixed header survives the underlying iframe. Zoomed lens clips at its own boundary; outside remains original. Image and iframe advertising text remains native. |
| QQ        | `translation-qq-readable-1789927258838`        | 12 settled ready stages; 10 real requests                         | Initial/scroll-down/resized screenshots: news lists, photo captions and product labels translate with native fonts and icon separation. Video subtitles, image banners and image logos remain native.                                                             |
| hao123    | `translation-random-hao123-1789927384233`      | **Failed** initial quiet-state gate at 150 seconds; 25 requests   | Retained screenshot still needs compact-row review. Dynamic source labels continue changing; one HTTP 503 has no recorded transport completion. Do not relabel this ready snapshot as a full pass. Further diagnosis follows the frozen batch.                    |
| NetEase   | `translation-random-netease-1789927545515`     | 12 settled stages; first two unsupported, then ready; 15 requests | Initial/scroll-down screenshots show ordinary two-column headlines, card captions and navigation translated. Native advertising/frame/image content remains Chinese. No overlap observed in the inspected views.                                                  |
| Baidu     | `translation-baidu-readable-1789927713423`     | 12 settled ready stages; 2 requests                               | Initial screenshot shows full-size single-line menu/hot-search labels, ellipsis and separate badges. Input placeholder/image logos stay native. The page has no scroll range here, so zero observed scroll events is **not** a scroll pass.                       |
| Lark Docx | `translation-lark-readable-1789927785209`      | 12 settled ready stages; 5 requests                               | Initial/scroll-down screenshots exercise actual four/five-column body tables and following prose, not just the TOC. Rows wrap at original font size; table structure, watermarks and document controls remain intact.                                             |
| Lark Wiki | `translation-lark-wiki-readable-1789927886849` | **Failed before opening translation**, zero requests              | The distant `模块划分` heading is not mounted. Retained source screenshot shows the current TOC entry `3.1 模块划分`. Replay through the diagnostic's existing explicit navigation argument; do not count a navigation timeout as a translation pass.             |

Sina records 242 stationary frames with zero hidden/replaced groups, and 32 gesture scroll events
with zero measured offsets/replacements across five unambiguous matched groups (two unmatched,
not silently included). QQ records 192 stationary frames with zero hidden frames and two group
replacements, plus 32 gesture events with zero offsets/replacements across all 12 matched groups.
The sampled original nodes have no disconnect/text/style change (Sina 1,351; QQ 549). These are
bounded observations, not a claim that every animation or dynamic repaint is eliminated.

NetEase has seven stationary group replacements in 185 frames, no hidden frame and zero measured
gesture offsets/replacements (six matched groups, one ambiguous). One original inline style changes
during the page's own live activity; this observation alone does not establish attribution. Baidu
has zero replacements/hidden frames in 242 frames and no source-node changes across 153 samples.

Docx has zero hidden/replaced groups in 242 stationary frames. Its single source/mirror flow is
ambiguous to the generic pairing probe, so the 32 real scroll events establish interaction but
not a measured zero-offset match. Virtualized document hydration changes the sampled source set
(one disconnected node, 18 text changes, zero styles); unchanged originals are additionally
covered by deterministic fixture assertions rather than claiming live hydration is immutable.

The remaining frozen-batch results and the Wiki navigation replay:

| Target           | Retained evidence directory suffix             | Interaction result                                                                       | Visual acceptance / boundaries                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hugging Face     | `translation-hf-safety-1789927929578`          | 12 settled stages; first five unsupported, then ready; four requests                     | Initial/scroll-down screenshots retain paragraph structure, title, inline links and sidebar typography. Image content and the skewed native Team badge remain unchanged.                                                                                         |
| W3C data table   | `translation-random-w3c-table-1789928011804`   | 12 settled ready stages; four requests                                                   | At 1024 px, delivery-slot table headers and cells translate with native column structure. Code examples remain untouched. The table fits this viewport, so no horizontal-scroll claim.                                                                           |
| Hacker News      | `translation-random-hackernews-1789928084450`  | 12 settled ready stages; five requests                                                   | Initial/scroll-down screenshots retain ranks, titles, domains and separate metadata rows. Native typography and table-based layout remain readable.                                                                                                              |
| Lark Wiki replay | `translation-lark-wiki-readable-1789928429972` | 12 settled stages; unsupported around the native diagram, ready elsewhere; five requests | Explicitly navigated through the observed `3.1 模块划分` TOC label. Initial/scroll-down screenshots show actual module-table headers, cells, numbered lists and following content translated. The nearby diagram remains native, as required by text-only scope. |

W3C and Hacker News each record 242 stationary frames with no hidden/replaced group, plus 32
gesture events and zero measured offsets/replacements across two unambiguously matched groups.
Their sampled source nodes show no disconnect/text/style change (382 and 631 respectively).
Wiki's first navigation failure is retained separately; the replay is not an overwrite of it.

### Continue after the matrix: generic inline rows and honest transport observation

The matrix remains **incomplete** while hao123 is repaired. Read-only source probe
`translation-random-hao123-1789928566950` confirms its 14-link row uses ordinary inline-block
anchors, normal white-space, a fixed 28 px content height and hidden overflow. The previous
nowrap-only rule misses this original single-line menu; longer labels wrap below the clip.
`translation-inline-row-red.log` and its screenshot/trace reproduce the disappearance with a
synthetic site-independent menu. The generic correction recognizes the original shared row
and retains visible labels with native-size ellipsis; an originally multi-row link collection
is a separate regression guard. The focused portal suite passes 11 cases after the correction.

Separately, `translation-request-monitor-red.log` proves the diagnostic waits forever for the
body of an HTTP 503 which the product intentionally canceled after inspecting headers. The
diagnostic now classifies that known HTTP failure without waiting for the canceled body, retains
its status, and still waits for a successful streaming response to finish. Five request/cleanup
tests pass (`translation-request-monitor-green.log`). This does not add product retries, hide
HTTP failures, or turn the failed live hao123 run into a pass; a fresh full replay is required.

Read-only probe `translation-random-hao123-1789928637886` additionally records a multi-row grid
of fixed-width, padded inline-block cells and nested labels. Its compact-label clipping/ellipsis
is under repair with a focused browser regression, not a hostname-specific exception.

The multi-row grid regression fails before correction with translated text painting across the
next cell (`translation-link-grid-two-rows-red.log`). The fix retains the source inline-block
ellipsis budget and carries it through atomic label wrappers, including icon padding. It does
not shrink fonts, change the source page or convert a multi-row collection into one row. The
focused portal suite now passes **12 cases** (`translation-link-grid-green.log`).

Fresh follow-up gates pass: **1,700 unit tests / 139 files**, **154 browser tests** (5.8 minutes),
zero-warning lint, typecheck, formatting, bundle/sandbox audits, 39 sample contracts and all six
doctor checks. Logs are `translation-final-followup-{unit,browser,lint,types,format,bundle,sandbox,
catalog,doctor}.log`. Freeze `page-content.iife.ts-u72RMK-B.js` with the unchanged background
bundle. Live follow-up begins with the full hao123 diagnostic after standalone readiness; do not
edit/rebuild this candidate during the real-page follow-up. The old hao123 failure is retained.

### Real follow-up rejects u72; repair the actual padded-link contract

`lens-translation-random-hao123-1789929463700` fails the unchanged 150-second quiet gate,
despite all 28 requests finishing with HTTP 200. Its screenshot confirms the repaired 14-link
navigation, but exposes a different grid-label defect: a fixed Chinese content width became the
border-box width after adding the icon-padding constraint, leaving only a few pixels for text.
The automated green result did not cover that exact nested fixed-width shape and is not accepted.

Source-only probe `translation-random-hao123-1789929693014` records a 28px content width plus
25px icon padding inside a 106px cell. The strengthened fixture first fails in
`translation-link-grid-padding-red.log`. Allowing the nested label to size intrinsically inside
the cell fixes the text budget, but its first replay also catches an existing compact-label rule
shrinking the outer ellipsized grid cell (`translation-link-grid-padding-green.log`, failed).
Exclude explicitly ellipsized cells from that auto-expansion rule; keep their original width.
The corrected portal suite passes all 12 tests (`translation-link-grid-padding-repair.log`),
including full visibility of the short `News` label, icon separation, bounded long labels,
the original two rows, native font size and source DOM invariance.

The independent quiet-state failure remains under investigation. A bounded, text-free diagnostic
now records native animation targets/geometry/property names alongside the unchanged settling
gate. No source animations are disabled, no timeouts are relaxed, and no site exceptions are added.

The next unchanged-gate replay (`translation-random-hao123-1789930216242`) remains failed.
All 21 requests finish, but the grid still exhibits nested ellipsis overrides, and the weather
header switches grouping during its top-position animation. The actual source anchor also declares
ellipsis (not only the outer cell); that additional declaration now reproduces an 8px visible
`News` label in `translation-nested-ellipsis-red.log`. Earlier simplified green fixtures therefore
remain partial evidence, not closure. The next correction must preserve the outer cell's allocated
label budget when visiting the inner ellipsis owner later in the traversal.

`translation-random-hao123-1789930515701` provides exact attribution: every weather transition
removes/re-adds the same translated IDs and moves 12 otherwise static header labels by up to
45px. Other changing positions are the source's search/news tickers, not transport work (zero
pending requests in the retained tail). The nested grid mirror reports a 28px max-width alongside
25px left/4px right padding, confirming the width override rather than a model/font defect.
Allocated inner labels now retain the enclosing cell's budget. Thirteen portal fixtures include
the mixed inline/padded-link cell; the nested ellipsis regression passes after the correction.

Source-only weather probe `translation-random-hao123-1789930863778` shows two absolute slides in
a 62 × 16px relative, overflow-hidden viewport. A generic CSS-animation fixture reproduces a
59px jump in a neighboring static label (`translation-ticker-isolation-css-red.log`). Clipped
containers whose visible children are all absolute now form persistent layout-island boundaries,
including between animations. This does not disable source motion or permanently exclude the
finished text: the fixture also requires the stopped ticker to translate again. Focused validation
and a new real replay follow; no hostname or timer heuristic is introduced.

### LTd1GT7q follow-up: repairs verified; continuous-source gate still failed

Freeze `page-content.iife.ts-LTd1GT7q.js` / `background.ts-DBM7YBHa.js`. The 44-case focused
motion/paint/portal suite passes, including two CSS animation cycles with invariant neighboring
label positions. Fresh 1,700-unit, zero-warning lint, typecheck, formatting, bundle/sandbox and
six-check doctor gates pass. The full browser suite is running on the same immutable build.

Live `translation-random-hao123-1789931169347` retains its **failed** 150s quiet gate. All 29
requests finish HTTP 200; the screenshot now shows readable Tencent/NetEase/Baidu Maps/QQ Mail
grid labels with preserved icons and bounded ellipsis, and all 14 press-navigation links. The
previous 12-label / 45px weather-neighbor shift is absent from the retained change trace. Remaining
changed positions belong to the weather slides and rotating search/news headlines. This is not a
passing full interaction run, nor grounds to disable source animation, loosen the gate, add a
site skip or discard the evidence. Other portal and document replays follow on this same build.

Deterministic browser checks and live correctness replays may overlap in separate Profiles; this
batch is not a performance comparison. Do not infer comparative rendering latency from its timing.

### Visual acceptance rejects a hover regression on LTd1GT7q

The complete browser suite passes 156 cases. Fresh full live replays reach settled stages on Sina
(`1789931439337`), QQ (`1789931634237`), NetEase (`1789931756546`), Baidu (`1789931922755`)
and Docx (`1789931987186`). However, **Docx does not pass visual acceptance**: the first table
is translated initially but its body falls back to Chinese after the pointer/scroll reveals
table editing handles. The diagnostic's `unsupported` terminal state is not an acceptance pass.
Other inspected portal views preserve typography and clipping; QQ records 32 scroll events and
13 unambiguous groups with no measured offset. Baidu has no real scroll range in this view.

Anchored Docx replay `1789932156218` reproduces the missing table body without a navigation
failure. Source-only probe `1789932262718` identifies a text-free, 1070 × 16px, absolutely
positioned and overflow-hidden resize-handle viewport containing one absolute decoration.
The new ticker-island rule wrongly treats it as a text track, splitting the table from the
following prose; translated row growth then collides with that independently positioned prose.
Repair must distinguish text tracks from passive empty decorations generically, without a
document hostname/class exception, and replay this same hover/scroll scenario.

The separately added compact condition/numeric ticker fixture passes at the native 12px font
and keeps a minimum 3px gap (`translation-ticker-sibling-width-red.log`, despite the exploratory
filename). Its initial attempt failed only because the mocked response lacked inline markers
(`translation-ticker-sibling-red.log`); neither is claimed as a proven new product defect.
The live weather area is dense/ellipsized, and still requires bounded visual qualification.

`translation-hover-handles-red.log` reproduces that real Docx regression with an ordinary HTML
table, clipped empty resize handles, growing translation and following section. Showing the
handles changes ready to unsupported and removes the translated table. Require actual text in
the isolated track; empty decorations now stay in the containing layout. The same fixture passes
three show/hide cycles, alongside the ticker-isolation and compact-label fixtures (30 cases in
`translation-handles-green.log`). No source edits or site rules are added.

Freeze `page-content.iife.ts-B9W8CipU.js` / unchanged `background.ts-DBM7YBHa.js`. Fresh 1,700
unit tests, zero-warning lint, typecheck/build, formatting, bundle/sandbox and all six doctor checks
pass. The first formatting check flagged the optional inspector; after formatting,
`translation-handles-format-recheck.log` passes. Full browser regression and the exact anchored
Docx hover/scroll replay follow on this candidate; the previous visual failure stays recorded.

### B9W8CipU verification after the hover-handle correction

The complete deterministic browser suite passes **158 tests** (`translation-handles-final-browser.log`).
The diagnostic runner suite passes **168 tests across 24 files**, and the catalog validates all
39 samples. An initial runner command named a nonexistent configuration file and failed before
test startup (`translation-handles-final-runner.log`); the repository-configured invocation
`npx vitest run e2e/tests/runner` is the successful recheck, not a suppressed test failure.
Fresh lint, formatting, typecheck and `git diff --check` also pass. No production edit or rebuild
occurs during this candidate's live replay batch.

Docx `translation-lark-readable-1789932599657` passes all 12 ready interaction stages and completes
seven real-provider requests. Its scroll-down screenshot shows the actual four-column table body,
visible editing handles, translated cells and following heading/prose without the previous Chinese
fallback. The continuous-scroll probe observes 32 real scroll events, but its one document-flow
group is ambiguous to the pairing probe; this is not a measured zero-drift claim for Docx.

Wiki `translation-lark-wiki-readable-1789932892737` completes all 12 interaction stages and five
requests. Both the initial and scrolled screenshots are inspected: the module table, numbered
integration options and surrounding prose translate at native size. The nearby original diagram
stays native, and the first stages retain an unsupported notice; this is acceptance of the scoped
text/table case, not a claim that every pixel or control label on the page translates. The scroll
probe records 32 events, two unambiguous groups with zero measured offset, and one unmatched group.

Both document replays use text-only requests with nonempty context. Their source pages hydrate
and virtualize while running; DOM-invariance assertions are made in deterministic fixtures, not
inferred from an absence of all live source mutations. Public portal replays follow serially.

The B9 portal batch reaches all 12 settled stages on Sina (`1789933016180`, 14 requests),
QQ (`1789933213221`, nine requests), NetEase (`1789933336405`, 15 requests) and Baidu
(`1789933490278`, two requests). Sina and QQ screenshots pass the scoped ordinary-text checks;
QQ's 32 scroll events have 12 unambiguously matched groups and zero measured offset.
**NetEase remains visually rejected**: comparing the initial result with the original reveals
the expanded right-hand submission label overlapping an adjacent decorative graphic. Previous
table/menu repairs do not close this separate defect. A geometry/background probe and generic
fixture follow; do not count the terminal `unsupported` status as a pass or add a site-specific rule.

Source-only probe `translation-random-netease-1789933589328` narrows this to an ordinary
270px right-aligned row: a text-free 140px absolutely positioned graphic on the left, and an
80px inline-block action on the right with its own 10px arrow. The graphic does not reserve any
inline width; the expanded action grows left over it. This is not image translation or OCR.
Two generic left/right graphic fixtures fail on the observed overlap
(`translation-graphic-label-red.log`). The shared compact-label constraint now preserves the
original slot when a same-row, originally non-overlapping absolute sibling is present. Intentional
image-overlaid captions do not match that non-overlap condition. Native font size, original source
markup and existing ellipsis behavior remain unchanged; focused and live rechecks follow.

Both graphic-adjacency fixtures now pass, alongside 50 neighboring document, motion, paint and
portal cases (`translation-graphic-label-green.log`, **52 passed**). Their red run measured the
translated edge over the protected graphic by 63–73px; the tests also require native 14px text
and unchanged original markup. Fresh 1,700-test, lint, formatting, build/typecheck, bundle/sandbox
and diff checks pass. Candidate `page-content.iife.ts-B4vhoyIC.js` retains the same background
bundle. After doctor, freeze it for the full 160-case browser suite and serial real replays of
NetEase (exact rejected graphic case), QQ and Baidu (compact-label regressions), then hao123
(unchanged 150s quiet gate). B9 document/Wiki/Sina results remain explicitly attributed to B9;
their original fixes also remain covered by the new complete deterministic suite.

### Auto-height floated ancestor clipping, found during B4 live acceptance

The full deterministic browser suite passes 160 cases. Real QQ (`1789934171391`) and Baidu
(`1789934296166`) finish 12 ready stages. NetEase (`1789934019879`) finishes 12 settled stages,
but its initial screenshot is **still visually rejected**: the constrained footer label no longer
overlaps the graphic because translated prose pushed the footer below an inherited clip, not
because the complete control is correctly visible. The 80px action slot is retained, but its text
at y723–743 is cut by an outer source container ending at y723.

Source-only typed-sizing probe `1789934586019` confirms that outer overflow-hidden container has
`height:auto`, `max-height:none`, `aspect-ratio:auto` and left/right floated columns. Its 364px
resolved source height is float-clearing layout, not an intentional fixed-height viewport. A
generic HTML/canvas/float-column regression reproduces the disappearing footer (text bottom302,
clip bottom250); fixed-height and max-height variants pass their clipping guards. Evidence:
`translation-auto-float-red.log` (one failed, two passed). The correction only relaxes vertical
clipping for a naturally sized float-clearing ancestor with no existing clipped source overflow;
horizontal clipping, explicit sizing, scrollports, aspect ratios, paint containment and collision
checks remain in force. Focused and real rechecks follow; this is not yet a completed live fix.

The unchanged hao123 full-page quiet gate again fails (`1789934364963`): 27 requests all return
HTTP200 and finish, while weather/search/news widgets keep changing. The failure remains recorded,
not classified as a pending-provider request and not converted to a pass by loosening the 150s
gate. Its initial image is retained for separate visual scrutiny, including the compact weather
strip; successful static menu/grid repairs do not imply acceptance of this whole page.

The first float fixture retained an inline canvas baseline, making its source scrollHeight137
against clientHeight130; the deliberately conservative source-overflow guard correctly retained
that clip. Set the native canvas to block (no baseline overflow) for the intended natural-height
case, then temporarily remove only the candidate clipping change and rerun the corrected fixture:
`translation-auto-float-corrected-red.log` still fails natural height (302>250), while both explicit
height guards pass. Restore the change; all three pass in
`translation-auto-float-source-corrected.log`. This correction does not weaken a product assertion.

The B5zP04QD real NetEase replay (`1789934984576`) makes the translated right-card footer visible
and keeps it separated from the absolute graphic. It also reveals that the left headline flow can
now fall back to native text when expanding over its following carousel/news area; the previous
old-height clip hid the overflow. Do not count the whole page as accepted yet. Inspect the layout
contract of these ordinary headlines before changing the collision guard.

hao123 source-only probe `1789935153723` identifies the separate weather-label overlap: the source
24px inline-block label has intrinsic `height:auto`, unlike the earlier fixed-height fixture.
The auto-height variant fails the existing gap assertion by 12px, while the fixed-height variant
passes (`translation-inline-auto-height-red.log`). A detached one-line inline label now retains
its original horizontal slot even with intrinsic height; natural multiline prose is unaffected.
The original request/quiet-state failure remains open until another real run.

The new auto-height label guard and float-clearing correction pass all 56 focused browser cases.
NetEase headline source probe `1789935448926` identifies normal `li > p > a` / `li > a` rows with
intrinsic height, not a live-text surface. The generic native-media fixture reproduces their total
translation fallback; the same links without a following native surface correctly wrap. Evidence:
`translation-linked-headline-red.log` (one failed, one passed). On collision only, originally
single-line list items consisting of linked text now retain their row budget and ellipsize;
unconstrained linked content and prose still reflow. No hostnames/classes or relaxed collision
checks are introduced. Full focused checks and a frozen real replay follow.

The linked-row fix passes the visibility check, but an added nested-block check demonstrates
missing visual ellipsis (`translation-linked-ellipsis-red.log`); carry the clipping/ellipsis
contract into its block wrappers as well as nowrap into inline descendants. A separate paint-
containment guard fails against the first float relaxation (`translation-float-containment-red.log`)
and passes after retaining contain:paint/content/strict boundaries. Both red runs remain retained.
An intermediate lint run caught three test-only non-null assertions; explicit missing-row guards
replace them. No source safety constraint or expected assertion is removed to make a test pass.

Freeze `page-content.iife.ts-BIplOamp.js` / `background.ts-DBM7YBHa.js` for final verification.
Six focused linked-row/float-height/paint-containment cases and all six doctor checks pass.
Run the complete 167-case browser suite and repository gates, then serial real-model replays of
NetEase (headline and footer defects), hao123 (weather gap and unchanged quiet gate), QQ, Baidu,
Docx, Wiki module table, and Sina. Every failure retains its directory and remains a failure;
no product edit or rebuild occurs during that live matrix. Screenshot review is required for
visual acceptance separately from the diagnostic's settled stage count.

### BIplOamp matrix and QQ separator follow-up

The full repository gates pass: 1,700 unit/runner tests across 139 files, 167 deterministic browser
tests, zero-warning lint, formatting, build/typecheck, bundle/sandbox audits, 39 sample contracts,
and six doctor checks (`translation-closure-*.log`). The separate 168-test runner execution is a
subset of the 1,700 total, not additional tests. The inherited Playwright NO_COLOR/FORCE_COLOR
environment warning remains unrelated to production code. Optional shell-token Codex checks are
not available; no Profile credentials were extracted.

| Real sample | Evidence directory suffix                      | Interaction result                                                      | Visual result                                                                                                                                                                   |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NetEase     | `translation-random-netease-1789936037527`     | 12 settled stages, 16 completed requests                                | Linked headlines now translate and ellipsize above the visible carousel; the footer is visible and clear of its graphic. Native exclusions still produce an unsupported notice. |
| hao123      | `translation-random-hao123-1789936206257`      | **Failed** initial 150s quiet-state gate, 24 completed HTTP200 requests | Static navigation/grid/headline repairs and the cloud-label gap are visible. Tiny weather/search/menu tickers continue changing; their complete stability remains unaccepted.   |
| QQ          | `translation-qq-readable-1789936368558`        | 12 ready stages, 8 completed requests                                   | Ordinary news, cards and badges are readable, but two large adjacent headlines lose their source gap. **Visual acceptance reopened**, despite ready status.                     |
| Baidu       | `translation-baidu-readable-1789936479819`     | 12 ready stages, 2 completed requests                                   | Native-sized single-row news and navigation; form input/logo remain native.                                                                                                     |
| Lark Docx   | `translation-lark-readable-1789936545350`      | 12 ready stages, 4 completed requests                                   | The actual four-column body, hover handles and following prose stay translated without table fallback.                                                                          |
| Lark Wiki   | `translation-lark-wiki-readable-1789936629858` | 12 settled stages, 5 completed requests                                 | Module table, numbered integration options and surrounding text translate; the original diagram stays native.                                                                   |
| Sina        | `translation-random-sina-1789936729882`        | 12 ready stages, 13 completed requests                                  | Dense news columns and compact menus remain readable before/after scroll; native ad/embed content is not counted as translated.                                                 |

All requests in this matrix are text-only and include nonempty context. QQ records 32 scroll events
and 12 unambiguously paired groups with zero measured offset. NetEase has five matched groups and
one ambiguous group; Wiki has two matched and one unmatched. Docx's single group is ambiguous, and
Baidu has no actual scroll events in this viewport. Those cases do not establish universal zero
scroll lag. Dynamic source hydration is not mistaken for source mutation by the lens; deterministic
fixtures carry the source-DOM-invariance assertions.

The QQ source-only inspection first used a non-exact headline and returned no match (`1789936994660`).
Point inspection (`1789937055162`, `1789937156976`) rules out stripped boundary whitespace: two inline
links are separated by a real text span, with 5px side margins. Inspecting that span confirms
`visibility:hidden`; it reserves space but was removed by the copy's paint-visibility filter.
The initial synthetic long-label probe failed because a range union included a clipped second
line, not because the visible pipe disappeared (`translation-inline-headline-separator.log`). A
shorter control passes; the accurate hidden/transparent variants then fail by 16.77px while visible
and display-none controls pass (`translation-hidden-separator-red.log`, two failed/two passed).

The minimal correction preserves only non-editable text-only leaf spacers in layout sizing/copying.
They are still excluded from request collection, hidden by the source CSS, inert and aria-hidden
in the copy. Live controls, large hidden subtrees and display-none content retain existing safety
boundaries. All four spacing variants pass on `page-content.iife.ts-iD7s0hr-.js`; a hidden-link
hit-testing/request-exclusion guard and the neighboring document/paint/motion cases follow.
No site selector, font fitting, prompt tweak or source-page write is involved.

### iD7s0hr- frozen recheck (2026-09-21)

The spacer correction passes all **172 deterministic browser tests** in
`translation-spacer-final-browser.log`, including four source-gap comparisons and a hidden-link
request/hit-testing guard. The focused document/paint/motion/portal run passes 64 cases before
the full suite. Fresh repository checks pass: **1,700 tests in 139 files**, zero-warning lint,
formatting, build/typecheck, production bundle and sandbox audits, 39 sample contracts, and all
six doctor checks. The first formatting check fails only on this report; formatting it and
rerunning the check passes (`translation-spacer-final-format-recheck.log`). Do not hide that
initial failure or count the 64 focused cases again in the 172 total. The inherited Playwright
NO_COLOR/FORCE_COLOR warning is unchanged. No shell-token Codex check or independent subagent
review is claimed; repository instructions prohibit delegation for this task.

Freeze `page-content.iife.ts-iD7s0hr-.js` and `background.ts-DBM7YBHa.js` through the serial
canonical-Profile real-provider batch. All six completed targets below have 12 settled recorded
stages, no diagnostic failures, and all listed requests finish HTTP 200. Screenshots are reviewed
separately from the ready/unsupported status. The final hao123 replay on the same build fails as
recorded after this table; the serial batch correctly exits with code 1.

| Target    | Evidence directory suffix                      | Completed requests | Scoped visual result                                                                                                                                                                                                                                                                                                                                      |
| --------- | ---------------------------------------------- | -----------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QQ        | `translation-qq-readable-1789937801712`        |                 10 | Ordinary headlines, picture-card captions, badges and neighboring columns remain readable. The new spacing fixtures preserve the actual hidden-separator contract; a longer model-generated first headline can still hide the second behind the source's existing one-line clamp. This is not proof that every translated word is simultaneously visible. |
| NetEase   | `translation-random-netease-1789937963554`     |                 17 | Both linked headline columns translate and ellipsize above the still-visible carousel. The expanded right-hand card retains its footer without covering the adjacent graphic. Original native/embedded exclusions still produce an unsupported notice.                                                                                                    |
| Lark Docx | `translation-lark-readable-1789938114733`      |                  4 | The actual four-column body and following prose translate at native size; visible editor handles no longer cause the table body to fall back.                                                                                                                                                                                                             |
| Lark Wiki | `translation-lark-wiki-readable-1789938198959` |                  5 | Module cells and their numbered lists remain translated after scrolling; the nearby original diagram is intentionally native and the source horizontal table scrollport remains clipped.                                                                                                                                                                  |
| Baidu     | `translation-baidu-readable-1789938297094`     |                  2 | Single-row navigation and hot-news entries retain native size and ellipsis, with separate rank/badges; editable input and logo remain original.                                                                                                                                                                                                           |
| Sina      | `translation-random-sina-1789938360468`        |                 13 | Dense news columns and fixed navigation remain readable in initial and scroll-down images; embedded advertisements stay native.                                                                                                                                                                                                                           |

The continuous-scroll probe records 32 source events on QQ and all 12 groups are unambiguously
paired with zero measured event/frame offset and no replacement. NetEase has five matched and
one ambiguous group; Sina has five matched and two unmatched groups; Wiki has two matched and
one unmatched group. Docx's single group is ambiguous and Baidu has no actual scroll range at
this viewport. These limitations prevent a universal zero-lag claim.

All 51 requests above are text-only. Unlike the preceding BIplOamp run, this QQ run has **two
requests with empty context** (two IDs, then one ID); the other 49 requests include nonempty
context. The collector intentionally excludes hidden/disconnected anchors and navigation/form/
footer content, but the redacted evidence does not retain enough source identity to attribute
those two individual requests definitively. Do not claim that every request carries context or
that context delivery establishes the model's comprehension. No context behavior was changed
to improve a test result. Request-local anchoring, the 6,000-character limit, and exclusion of
editable drafts remain covered by the unit/scheduling tests.

Code review of the touched spacer, compact-row and float-clip paths retains these boundaries:
hidden copies are inert; explicit height/paint clips remain enforced; free prose still reflows;
original source markup is unchanged in the deterministic fixtures. The production translation
directories contain no hao123/Sina/QQ/163/Baidu/Hugging Face hostname rules. No production edits
or rebuilds were made during the live matrix. The worktree remains uncommitted and unpushed.

#### Still open: continuously changing hao123 islands

`lens-translation-random-hao123-1789938559490` again fails the unchanged 150-second initial
quiet-state gate. The retained last snapshot says ready with 144 rendered text entries, but
`settled:false`; **do not count it as passed**. All 28 real-provider requests finish HTTP 200,
contain context and carry no images. In the last nine retained changes there are no pending
requests, while source identities, two-item ticker positions, group membership and ready/
unsupported status continue changing. Longer API timeouts or transport retries do not address
this failure. Scroll/resize/reopen stages are not reached and remain unverified on this target.

The failed screenshot is inspected, not discarded: static press navigation, icon-grid labels,
ordinary headline/card text and the weather-label/numeric gap show the generic repairs. It
does **not** establish continuous stability of the rotating search, weather and menu widgets.
Very narrow compact labels still use source-sized ellipsis rather than shrinking fonts; original
ads/images remain native, and proper names may legitimately remain untranslated.

The remaining scope is a lifecycle policy for continuously replaced/animated text islands, not
another site selector or font-size patch. Keeping such an island fully native for the lens
session avoids repeated translation/copy transitions but also withholds its readable paused
frames; freezing a translated snapshot makes the displayed information stale; translating every
new frame retains request/render churn. Choosing and implementing that policy adds state,
invalidation and cross-site regression work. It has not been silently selected here. The user
previously allowed bounded high-cost bad cases, so this scenario and its cause/cost trade-off are
reported explicitly, while ordinary DOM defects above are fixed. Overall acceptance remains
incomplete, and none of the historical failed runs is relabeled or removed.
