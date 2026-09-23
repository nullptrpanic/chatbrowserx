# Translation renderer contract validation — 2026-09-21/22

## Current frozen V20 matrix

Production identity: `d503bbb9-v20`, 216 source/dist hashes in
`.runtime/renderer-contracts-20260921-AG6WCY/final-v20-candidate-sha256.txt`.
This is a dirty-worktree build identity, not a Git commit. Root `dist` remains owned by the
user's development process; the canonical live session loads the isolated frozen build.

**Final V20 acceptance is complete within the approved text-only, read-only lens boundaries.**
All 13 first-round pages, five core repeats and two content supplements have completed and their
key screenshots have been reviewed: **20 rounds / 275 stages / 201 text-only requests**. The
first-round subset is 195 stages / 140 requests. There are no image inputs; maximum observed
context is 3,544 characters, below the unchanged 6,000-character total limit. These are native
feature diagnostic stages, not WorkSession benchmark success counts. Three completed rounds
contain a model-format error recovered by one explicit Retry each; they are not first-attempt
successes. Four additional failed attempts are retained and classified below, outside these totals.

| Page          | Stages / requests | Evidence suffix | Display review                                                                                                                                         |
| ------------- | ----------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feishu Wiki   | 16 / 9            | `1790071183764` | Heading 3.1, prose, table cells and highlights; selection toolbar/watermarks preserved; actual nested horizontal scroll.                               |
| Feishu Docx   | 16 / 9            | `1790071293409` | Requirements/identity tables, headings, prose and horizontal scroll; source-native hydration separately attributed.                                    |
| Baidu replay  | 14 / 5            | `1790072162406` | All ten hot-list titles, navigation, badges and original input; native font and single-line ellipsis. Earlier failed observer run retained below.      |
| QQ            | 14 / 12           | `1790071630208` | Static headlines, two-column news, photo captions and all seven product links; no upper-half glyph clip; video remains native.                         |
| hao123        | 14 / 15           | `1790071755797` | Shared navigation, icons, link grid and ten suggestion rows; native popup correctly occludes lower copies.                                             |
| Sina          | 14 / 16           | `1790071942567` | Static navigation/news/photo regions readable; actual changing recommendations remain original.                                                        |
| NetEase       | 14 / 27           | `1790072229194` | Native-sized navigation, static main headlines and photo cards; carousel/ad boundary retained.                                                         |
| Runoob        | 16 / 6            | `1790072427967` | Rendered table cells/headers, body, sidebar and previous/next arrows; code supplement reviewed below.                                                  |
| MDN           | 14 / 6            | `1790072503626` | Headings, prose, sidebar and inline-code backgrounds; native shadow controls/interactive example stay original.                                        |
| React         | 14 / 6            | `1790072615500` | Original wide search control, body, lists, sidebar, code indentation and syntax styling.                                                               |
| GitHub replay | 16 / 10           | `1790072807700` | Navigation/file list and complete short labels with natural wrapping; retained first-run HTTP 503 below; README supplement reviewed below.             |
| Wikipedia     | 16 / 8            | `1790072912872` | Wide colored/merged table, headers, links and sort icons, including actual horizontal movement.                                                        |
| Hacker News   | 17 / 11           | `1790073038243` | Compact list, domains, bylines and order preserved. One scroll-down model-format error recovers after one explicit Retry; not a first-attempt success. |

| Repeat / supplement       | Stages / requests | Evidence suffix | Display review                                                                                                                                                                                                                          |
| ------------------------- | ----------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feishu Wiki repeat        | 16 / 9            | `1790073564360` | Heading 3.1, body and actual table cells remain translated after manual refresh, scrolling and reopen-3; native selection toolbar/watermarks retained.                                                                                  |
| Feishu Docx repeat replay | 16 / 9            | `1790074142539` | Requirements/identity tables, green highlights, body and headings reviewed; actual horizontal pan 302.5 → 66. Earlier 503 attempt retained.                                                                                             |
| Baidu repeat              | 14 / 5            | `1790073740461` | All ten hot-list titles retain native font, single-line ellipsis and badge spacing; initial/manual/125%-zoom images reviewed.                                                                                                           |
| QQ repeat                 | 15 / 12           | `1790073809677` | All seven product links retain full glyph height; static news/photo captions and native video preserved. One manual-refresh format error, one explicit successful Retry.                                                                |
| hao123 repeat replay      | 14 / 15           | `1790074249455` | Ten suggestion rows, full main navigation after popup closes, icon spacing and static grid reviewed through cached reopen/reopen-3. Earlier 503 attempt retained.                                                                       |
| Runoob code supplement    | 2 / 7             | `1790074427451` | Actual table/thead/tr/th example keeps indentation, newlines, syntax colors and inline-code backgrounds; source/manual images reviewed. Native iframe ad/input unchanged.                                                               |
| GitHub README supplement  | 3 / 4             | `1790074475695` | README headings, prose, lists and links translate; both npm install commands remain preformatted originals. Source/initial/recovered images reviewed. One format error, one explicit successful Retry; SVG badges stay original images. |

### Failed attempts retained separately

| Attempt suffix                | Failure                                                                                                                             | Closure without discarding evidence                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baidu `1790071398855`         | Model omitted three source markers; explicit Retry recovered the display, but the diagnostic stalled on a canceled HTTP 200 stream. | Corrected the exact-request failure observer, with two RED unit regressions and a real-browser cancellation regression; unchanged-product replay `1790072162406` passed. |
| GitHub `1790072685955`        | Initial upstream HTTP 503.                                                                                                          | Unchanged-build full replay `1790072807700` passed; no automatic retry added.                                                                                            |
| Docx repeat `1790073673258`   | Initial upstream HTTP 503; cleanup then canceled its companion stream.                                                              | Unchanged-build full replay `1790074142539` passed.                                                                                                                      |
| hao123 repeat `1790073930268` | Upstream HTTP 503 at cached-reopen after six stages.                                                                                | Unchanged-build full replay `1790074249455` passed; earlier screenshots do not substitute for the missing stages.                                                        |

These are service/model or diagnostic failures, not evidence that every attempt succeeds. The
three explicit format recoveries inside the completed matrix are Hacker News scroll-down, QQ
repeat manual-refresh and the README supplement. All 201 requests in the selected completed
rounds finish transport observation; that fact does not turn malformed model output into success.

### Source preservation and motion limits

The Wiki rounds each contain ten equivalent-parent native hydration changes and one seven-character
native selection-counter change, not document writes. Docx's 17 source mutations in each round
preserve parent text and have the earlier default-world hydration/virtualization attribution.
Neither Feishu page has source style changes. hao123's three native homepage/weather style changes
per round and NetEase's native sprite change remain separately recorded. Other full-page rounds
record no source text/style changes. Input values, document data, media and watermarks are not written.

The completed full matrices contain **522 real scroll events and 201 unambiguous moving-page
source/copy matches**, with zero sampled event/frame offsets. Twelve stationary Baidu matches
are excluded from that motion count: Baidu has no actual scroll range at the tested viewport.
Each Docx round has no unambiguous source/copy match and one ambiguous match, so its screenshot
review is not a numerical zero-lag claim. Actual nested horizontal movement is observed in both
Feishu pages and Wikipedia; wheel attempts on non-overflowing Runoob/GitHub/Hacker News tables
are not claimed as horizontal coverage. Stationary checks record no hidden-layer sample;
NetEase has one copy replacement associated with native carousel changes.

QQ repeat's one observed-margin `native-overlap` target during reopen-1/2 is outside current
visible-line coverage; final reopen has none. Recovered/current-lens screenshots show no ordinary
static omission. No image review turns an uninspected or actually dynamic target into a static pass.

### Final deterministic gates and review

| Command / check                                             | Final result                                                                     | Evidence under `.runtime/renderer-contracts-20260921-AG6WCY/`     |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `npm run test:run -- --maxWorkers=2`                        | 1,760 / 1,760 tests, 142 files, 55.96 seconds                                    | `final-v20-units-observer.log`                                    |
| `npm run test:e2e` in the isolated source/build snapshot    | 289 / 289 browser cases, 42 files, 10.5 minutes                                  | `final-v20-browser.log`                                           |
| Additional real-browser canceled-stream observer test       | 1 / 1, 1.5 seconds; separate from the 289-case full suite                        | `v20-canceled-request-browser.log`                                |
| `npm run lint`, `npm run typecheck`                         | Pass; lint has zero warnings                                                     | `final-v20-lint-observer.log`, `final-v20-typecheck-observer.log` |
| `npm run audit:bundle`, `npm run check:sandbox`             | Pass; 17 production assets                                                       | `final-v20-bundle.log`, `final-v20-sandbox.log`                   |
| `npm run e2e:catalog:validate`                              | 39 samples valid; not 39 live benchmark passes                                   | `final-v20-catalog.log`                                           |
| Canonical doctor, standalone verification, serial live path | Doctor 6 / 6; all selected live rounds complete using the same dedicated Profile | `final-v20-doctor-separate.log`, `v20-*-live.log`                 |
| Final documentation formatting, diff and freeze integrity   | Pass; all 216 snapshot hashes and 199 root production source hashes match        | `final-v20-closure.log`                                           |

The existing Node `NO_COLOR`/`FORCE_COLOR` environment warning is not a new lint warning.
The optional shell-token Codex contract check is not run because that token is absent; no Profile
credentials are read to manufacture it. Canonical authenticated native live requests are exercised.

A separate same-agent whole-change review is complete, **not independent review**. It checks
layout-policy ownership, safe source structure/whitespace binding, bounded discovery, visibility
attribution, partial-block validation, stale generations/cache, cancellation and read-only source
protection. No new site-specific layout rule, dependency, permission, renderer, automatic model
retry or public protocol is introduced. Earlier replaced painter responsibilities remain removed.
All implementation changes remain uncommitted; inherited unrelated changes and root `dist` are preserved.

The closure is for the frozen candidate and observed cases, not a guarantee for every website,
future page revision, model response or service outage. The live build is isolated; an already
loaded user extension is not silently replaced or restarted by these diagnostics.

Image review also checks the agreed display boundaries: original-font ellipsis for constrained
headlines, source-width flow clipped by a small/moved lens, original images/video/Canvas and
preformatted code, native interactive controls, and minimum actually dynamic branches. None
of these boundaries permits an unexplained omission of ordinary static prose or table text.

## V20 continuation — clipped wrapping rows are not accepted

The sections below are chronological investigation evidence, not current acceptance status.
Earlier open/failed checkpoints remain recorded even when later V20 results close them.

V19's 13 first rounds, five core repeats and two supplements have executed, but **V19 is not
accepted**. A second separate image review of QQ repeat `qq-readable-1790067300468` finds
ordinary static product links missing from view. The first-round QQ review below overlooked
this defect; completed requests and rendered-target counts do not establish visible coverage.
The hao123 repeat's dense navigation remains under investigation for the same layout contract.

Canonical read-only attribution `qq-readable-1790067810481` confirms the source row uses
`display:flex; flex-wrap:wrap; height:16px; overflow:hidden; padding-bottom:10px`. The source
links fit one line, but a translated link moves from y315.98 to y339.47, below the row's clipping
edge. V19 excludes all wrapping flex containers from shared row allocation. Outer-height
measurement also mistakes padding for available text height. Neither dynamic-content retention
nor bounded utility-label fallback covers this ordinary static omission.

Two generic regressions (`height:16px` and `max-height:16px`) fail against the unchanged V19
build: a later link has -0.09px intersected painted height instead of at least 15.5px.
Preserve `v20-bounded-wrap-red.log` and `v20-bounded-wrap-red-artifacts/`. The correction stays
in the existing constraint owner: use content height and an explicit one-line clipping limit
to distinguish bounded rows from naturally growing tag groups. Preserve the V19 GitHub wrap
regression. Targeted tests and actual failing-page preflights must pass before another full gate.

The first adjustment passes 48 focused cases but actual `qq-readable-1790068596856` reveals
top-half clipping after forced nowrap changes flex cross-axis sizing. The refresh also retains
an upstream HTTP503, independently of that layout failure. Attribution `1790068776249` confirms
centered children with bottom margins; the two centered fixtures RED at 10.95px visible height.
Removing the unnecessary forced-wrap override preserves the source cross-axis layout. All 48
focused cases pass again; canonical `1790068976774` shows the links in their original y315.98 row,
all seven visible on both initial and manual refresh. Six text-only requests complete without
model errors; nine existing bounded utility fallbacks remain separately classified. GitHub
preflight `1790069125584` retains complete short labels and native wrapping (eight requests).

hao123 attribution `random-hao123-1790069036580` confirms a second ordinary static omission:
12 inline navigation items fit the original 766px track, but their 42px boxes exceed the 40px
parent by 2px while their text fits. The strict outer-box row check misses that shared contract;
whole-track ellipsis then hides later links. The generic inline-row RED and its first repair
attempt remain in `v20-inline-row-*.log`: admitting the actual one-line text band is necessary,
but a sole nested label's 32px outer margin is also double-charged beside the row's new gap,
leaving only 23.75px for text. Shared-row spacing must own those positive outer margins while
preserving icon/text-sibling and negative positioning margins. No source DOM writes or site rule.
Preflight is still open; no full-matrix or completion claim.

Further source-preservation checks catch two flaws in the first margin repair before acceptance:
`v20-icon-gap-red.log` loses a background icon's reserved 24px gap, and
`v20-inline-baseline-red.log` reproduces an 8px baseline shift from an auto-height wrapper with
an inline label and border. Preserve icon-reserving margins and align only the sole nested label
box without anonymous descent. All **50 focused browser cases pass** (`v20-paint-safe-focused.log`).
Fresh doctor passes all six checks. Actual hao123 `1790070201960` now shows all 12 navigation
items, readable at source font size, with the baseline difference reduced to 1px rather than 8px;
all ten suggestion rows remain translated on initial and manual refresh. Twelve text-only requests
complete without error/retry; the 16 pre-existing bounded utility fallbacks remain separately
classified. QQ/GitHub preflight and the renewed whole gate/matrix are still required.

The isolated full-suite discovery initially fails because sandbox audit assets were omitted from
the private source snapshot (`v20-case-list.log`). Copy only the repository's three static sandbox
web assets through the existing snapshot path; no Profile/authentication files are copied. Corrected
suite discovery reports **289 cases in 42 files** (`v20-case-list-ready.log`). This is an environment
assembly failure, not product or browser test evidence.

Final preflights are visually reviewed: QQ `1790070298651` retains all seven product links,
full glyph height, source typography, static headlines and photo captions through refresh;
its native video remains untouched (seven requests; nine/eight bounded utility fallbacks).
GitHub `1790070360560` keeps complete short topic labels and native wrapping (eight requests,
no layout rejection). Neither run has a model error/retry. Production implementation is frozen
for whole-gate validation; the README is updated to describe these common constraints.

Whole-gate execution retains two test-environment faults rather than treating them as product
failures. Root Vitest discovers private source snapshots recursively because its exclusions omit
`e2e/.runtime`; that duplicate/dependency scan is terminated (`final-v20-units.log`). Running
inside the snapshot instead finds the intentionally absent portable sample catalogue
(`final-v20-units-isolated.log`). Fix the actual discovery owner with one runtime-directory
exclusion in `vitest.config.ts`, then run the full suite from the repository again. No production
file or legitimate test is excluded. A concurrent doctor process exits 137 without a result;
the canonical doctor must be rerun separately after the gates. Preserve its empty log/exit,
do not call it passed. The two new non-null assertions rejected by lint are also corrected
without weakening the geometry assertions; retain `final-v20-lint.log` before the clean rerun.

Corrected root discovery lists exactly 142 test files and no runtime path. The full root unit
gate passes **1,758/1,758** in 70.55 seconds (`final-v20-units-runtime-excluded.log`); the two
snapshot-only failures were missing tracked catalogue/documentation fixtures, not failed product
assertions. Format, zero-warning lint, fresh typecheck, bundle audit (17 assets), sandbox and
39-sample catalogue pass. The complete 289-case browser gate remains in progress.

Final browser gate passes **289/289** in 10.5 minutes (636.84 seconds including build), with
no failed case. Fresh doctor then passes all six checks. Final identity is
`final-v20-candidate-sha256.txt`, **216 source/dist paths** from the isolated build; all root
production source files match the snapshot. The full frozen 13-page matrix and five core repeats
are running. No completion claim until source/display/interaction evidence is reviewed.

The first final-candidate Baidu attempt (`baidu-readable-1790071398855`) is retained as a
failed diagnostic, not quietly replaced. The model omitted three source-owned markers;
one explicit Retry recovered the page to `ready` with 40 visible translated targets. A
different, concurrent 200 stream was canceled by that user action. The installed Playwright
client emits `requestfailed` without settling `Response.finished()` for that stream, so the
diagnostic incorrectly waited the remaining 150-second stage limit despite the recovered
display. Exact-request failure observation now races that pending response/body wait; it
retains cancellation/transport failure metadata instead of converting it to HTTP success.
Production source/dist and the frozen identity are unchanged. Two RED regressions reproduce
the unresolved before/after-header cases; the five observer unit tests now pass. A real
browser streaming cancellation also passes (`v20-canceled-request-browser.log`, 1/1), using
a local unauthenticated fixture. No layout assertions, model retries or time budgets are relaxed.

The canonical fresh Baidu replay (`1790072162406`) completes 14 stages and five requests
without error or rejection. Initial/manual-refresh screenshots show every visible hot-list
title translated at source font size, one-line ellipsis and badges retained; source text/styles
are unchanged. This closes the harness fault and verifies the page, but does not erase the
earlier model format failure. The page does not actually scroll at this viewport, so its zero
scroll-event count is not used as evidence of motion alignment. The two Feishu pages, QQ,
hao123 and Sina have also completed their first full matrices; the remaining sites and core
repeats are still in progress.

### V20 execution-cost diagnosis

The hours-long task time is primarily repeated engineering/validation cycles, not one browser
translation taking hours. In the retained `final*browser*.log` files, 21 broad executions with
at least 200 passing cases report **185.5 summed execution minutes**. This includes failed
executions' passing cases; it is neither 21 successful gates nor exclusive wall-clock time.
The repeated full gates and subsequent site matrices, together with earlier visual-review
misses, account for substantial avoidable rework. They are not justified as model latency.

The current complete browser gate is 10.5 minutes; the latest root unit gate is **1,760/1,760
in 55.96 seconds**, including the two canceled-request observer regressions. Frozen V20 Wiki
and Docx 16-stage native diagnostics take **105.3 / 102.0 seconds** respectively. Their
recorded page-query durations sum to 1.274 / 0.704 seconds; this narrow instrumentation is
not total rendering CPU time. Model streaming, page startup, gestures, screenshots and
settling account for the remainder; do not infer that all of it is model or rendering time.

Two actual unnecessary waits are corrected: root unit discovery no longer traverses private
runtime snapshots, and an observed canceled stream no longer waits for an unresolved
Playwright response promise until the 150-second diagnostic deadline. Product timeouts and
coverage gates are unchanged. For the final candidate, run the 50 focused regressions and
the actual QQ/hao123/GitHub preflights first, then freeze and run the full suite/matrix. Review
saved screenshots while the next serial live page is waiting; never run two jobs against the
authenticated Profile. No percentage speedup is claimed without a matched benchmark.

The final GitHub first attempt (`github-readable-1790072685955`) receives HTTP 503 during
initial translation. It remains a failed upstream-service attempt, not a layout pass. The
unchanged canonical replay (`1790072807700`) completes 16 stages / ten text-only requests
without errors or rejections; actual app/file-list display and complete naturally wrapping
topic labels are reviewed. No automatic retry or product change is added for this incident.

## V19 continuation — preserve native flex wrapping

V18 is not accepted as the final candidate. Nine pages' full matrices were visually reviewed;
NetEase retains an upstream HTTP 503 failure awaiting replay. The tenth completed page, GitHub
(`lens-translation-github-readable-1790061325139`), has a real visual defect despite all requests
succeeding: two short topic labels become one-glyph ellipses. Initial-only attribution using the
same canonical diagnostic (`1790061830010`) confirms that the source has `flex-wrap: wrap`, while
the compact-row adapter assigns the translated labels `flex: 1 1 0px`. Their padded 40.29px boxes
leave only 14.29px for a two-character 24px label. This is not a translation/model failure or an
approved small-utility fallback.

The generic padded wrapping-label regression fails on unchanged V18: 16.80px visible width for
24px of ink (`wrapped-label-red-confirmed.log`, `wrapped-label-red-artifacts.tgz`). The earlier
`wrapped-label-red.log` used a removed source class in its test selector; that harness mistake
is preserved but is not product RED evidence. The production correction is a single contract
condition in the existing text-constraint owner: only `flex-wrap: nowrap` qualifies as a compact
single row. Wrapped containers retain browser layout. No hostname or alternative renderer.

Narrow regressions and the actual failing page are verified before another full gate. Existing
V18 evidence is retained but will not be combined with V19 results to claim one final build passed.
This explicitly avoids restarting the ten-minute suite before the demonstrated defect is closed.

V19 focused browser regressions pass **40/40**. Canonical live preflight
`lens-translation-github-readable-1790062216775` passes both initial and refreshed display with
eight completed text-only requests, no model error/retry and no layout rejection. The two short
labels are visibly complete, and the tag group retains its native two-line wrap. The inspected
label has 23.03px of un-clipped content inside a 49.03px padded box, rather than the previous
14.29px content slot. Source font and source DOM remain unchanged. Static gates and **1,758/1,758**
unit tests pass; the complete browser gate is running. Preflight manifest:
`preflight-v19-candidate-sha256.txt` (216 source/dist paths).

V19 full gates pass: **282/282 browser cases** (9.7 minutes), **1,758/1,758 unit tests**
(142 files), format, zero-warning lint, typecheck/build, bundle audit, sandbox and 39-sample
catalogue. The final build matches all 216 preflight source/dist hashes. Fresh doctor and the
freeze check pass; evidence is `final-v19-*.log` and `final-v19-candidate-sha256.txt`.
The final 13-page matrix and five core repeats are now running on that unchanged build.

### V19 frozen first matrix — display review completed

Thirteen completed rounds have been visually reviewed: **195 stages / 138 completed text-only
requests**, maximum context 3,544 characters. Twelve rounds have no model error or retry;
Hacker News has one explicitly recovered format failure. All transports finish HTTP 200, which
does not hide that content-format error. Separate NetEase and environment failures below remain
recorded. Five core repeats and two supplements are still required for the 13+5+2 acceptance set.

| Page           | Stages / requests | Evidence suffix                    | Reviewed result                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wiki           | 16 / 9            | `lark-wiki-readable-1790063003197` | Actual headings, prose and table cells translated; horizontal pan 302.5 → 134. Two matched groups / 32 scroll events, zero sampled offsets. Ten parent-equivalent editor run changes plus a native selection counter; zero styles. One bounded utility-label fallback.                                                                                                                                                                                             |
| Docx           | 16 / 9            | `lark-readable-1790063188343`      | Both visible tables, intervening paragraph and colored inline emphasis retained; horizontal pan 302.5 → 66. Seventeen parent-equivalent native run changes, zero styles. No rejection. Thirty-two scroll events but no unambiguous matched group (one ambiguous): no numerical zero-offset claim.                                                                                                                                                                  |
| Baidu          | 14 / 5            | `baidu-readable-1790063356164`     | Navigation, ten hot headlines, ellipsis, numbers, badges and button remain readable at native size. Inputs/logo intentionally unchanged. No source changes or rejection. Homepage fits viewport: no real scroll events.                                                                                                                                                                                                                                            |
| QQ             | 14 / 10           | `qq-readable-1790063690237`        | Static headline grid, lists and photo captions translated; native media preserved. Nine bounded utility fallbacks. At 125% zoom one observed-margin target retains a native-overlap code, outside the current lens; current lens is ready and its pictured eligible labels translate. Thirteen matched groups / 32 scroll events, zero sampled offsets. Three native live stock-counter changes, zero styles.                                                      |
| hao123         | 14 / 15           | `random-hao123-1790063869250`      | Ten search-suggestion rows translated without native-overlap or duplicate border; grids keep native font/icons. Sixteen bounded utility fallbacks. Fifty-eight matched groups / 32 scroll events, zero sampled offsets. Zero source text changes; three native home/weather display/animation updates.                                                                                                                                                             |
| Sina           | 14 / 17           | `random-sina-1790064128611`        | Static columns, navigation and photo captions retain source typography. Seventeen bounded utilities and nine native-overlap entries on the previously classified changing recommendation list; neighboring static lists translated. Five matched groups / 32 events, zero sampled offsets or source changes.                                                                                                                                                       |
| NetEase replay | 14 / 27           | `random-netease-1790065377665`     | Static columns, headings, photo captions and source ellipsis retained. One overlap is the previously attributed small advertising label above an iframe; moving carousels stay native. Five matched / one ambiguous group, 32 events, zero sampled offsets or scroll replacements. Stationary window: 189 frames, zero hidden, two replacements alongside page-owned carousel/class updates. Zero source text changes; one native advertising-sprite style update. |
| Runoob table   | 16 / 6            | `random-runoob-1790065595292`      | Actual HTML-tag table headers/cells, green links, sidebar and previous/next controls translate; native sizes retained through scroll/zoom/reopen. No errors, rejection or source change. Two matched groups / 32 events, zero offsets/replacements/hidden. Horizontal wheel produced no movement (251.914 → 251.914), so it is not horizontal-motion proof. Code-example supplement remains due.                                                                   |
| MDN            | 14 / 6            | `mdn-readable-1790065713433`       | Headings, prose, table guidance and sidebar translate; inline code backgrounds and links retain source styles. Native embedded editor and inputs remain original. Five matched groups / 32 events with zero sampled offsets; no errors, retry, rejection or source changes.                                                                                                                                                                                        |
| React          | 14 / 6            | `random-react-1790065819317`       | Search control retains its original width, navigation and lists remain readable, code examples retain indentation and syntax styles. Four matched groups / 32 events, zero sampled offsets; no errors, retry, rejection or source changes.                                                                                                                                                                                                                         |
| GitHub         | 16 / 10           | `github-readable-1790065928857`    | The previously clipped short language/type labels are complete through refresh, zoom and reopen, with native two-row wrapping. File list, avatars and icons retain their layout. Native relative-time components and filenames remain original. Twenty-five matched groups / 32 events, zero sampled offsets; no errors, retry, rejection or source changes. Horizontal attempt does not move (112 → 112); README supplement remains due.                          |
| Wikipedia      | 16 / 7            | `wikipedia-table-1790066077599`    | Actual comparative table headers, multilevel rows, colored cells, references and links retain structure; prose and headings translate. Four matched groups / 32 events, zero sampled offsets; horizontal motion 121.594 → 96.594. No errors, retry, rejection or source changes.                                                                                                                                                                                   |
| Hacker News    | 17 / 11           | `random-hackernews-1790066769514`  | Tight news-table rows, titles, metadata and navigation retain native size. One bad block in a 30-block response becomes an explicit error; a real notice click resubmits only its source key, keeps completed neighbors and restores ready display. This is recovery, not first-attempt success. Two matched groups / 32 events, zero offsets/replacements/hidden; source unchanged. Horizontal attempt does not move.                                             |

No sampled group was replaced or hidden during continuous scrolling in these runs. NetEase's
separate stationary-window replacements are reported above, not counted as zero. Source and
manual-refresh images, scrolling, 125% zoom and repeated reopen images are checked separately
from request completion. QQ's post-zoom margin rejection is not described as zero rejections or
as permission to leave ordinary visible static text untranslated.

First-round totals include **384 real scroll events / 131 matched groups**. Each per-round
ambiguity and zero-motion exception remains explicit. On a narrow moved lens the source-width
flow remains clipped to the lens: a shorter translation may end before the lens's left edge;
that empty slice is not full-page line wrapping or a missing-source-target claim.

Retained V19 NetEase failure `random-netease-1790064379190`: request six returns an invalid
model envelope (five requested IDs, only one returned). Completed neighboring translations are
preserved and the visible notice offers Retry. The diagnostic then selects the first `button`
in the entire shadow root, which can be an inert button copied from the webpage, instead of the
notice action. The seventh request's transport cancellation follows diagnostic cleanup and is
not the upstream cause. This is a harness failure after a model-format error, not HTTP 503.

A generic real-extension fixture with an inert translated button before the notice reproduces
the wrong click (`v19-retry-selector-red-confirmed.log` and archived traces). The earlier narrow
button fixture hit the approved utility fallback before clicking and is not this RED evidence.
The E2E helper now targets `.notice > button`; the tsx serialization unit test includes the competing
page button. The focused unit and all three retry/error browser cases pass. Product source and
dist remain unchanged; the six accepted V19 rounds are not discarded. Full gates and a fresh
canonical NetEase replay remain required, and the original failed attempt remains retained.

The first corrected-helper replay (`1790065132468`) passes standalone environment verification,
then Chromium's canonical persistent-context launch times out after 180 seconds, before target
navigation or translation requests. Its failed browser process has exited. Preserve
`v19-netease-replay-live.log` as an environment failure, not product evidence; restart through the
same canonical verification/session path with a fresh evidence directory, without changing or
copying the authenticated Profile. This launch wait is another concrete task-latency contribution.

At 16:38 on September 22, a separately launched IDE-terminal `npm run dev` rewrote three `dist`
entry files. Wikipedia's evidence completed at 16:36, before that write. The next Hacker News
freeze check fails before verification or navigation (`v19-hn-freeze.log`); no mixed-build run is
counted. The user's server is left running. A private source/test snapshot at
`e2e/.runtime/translation-v19-isolated-MsE44k` is built using the existing build command. Relocation
changes only the background asset filename, not one byte of its contents; restoring the frozen
filename and loader gives an exact match for all **216** frozen paths
(`v19-isolated-freeze-confirmed.log`). The failed initial path check is retained separately.

Doctor passes all six checks in that snapshot. The RUNBOOK's existing isolated-product settings
transfer and external-target verification are used with the same authenticated Profile; no Profile
or credential file is copied and no credential value is logged. Remaining live checks use the
canonical external-build selector and opaque revision `d503bbb9-v19-frozen216`. Deterministic
browser verification will use the same snapshot's unchanged fixtures against the byte-identical
build, avoiding both an overwrite of the user's dev server and a new test-only product path.

## V18 continuation — foreground popup text repair in progress

V17's frozen matrix is **not accepted**. Wiki, Docx, Baidu and QQ completed and their key
images were reviewed, but the fifth page (hao123 with the search suggestions open) leaves
three ordinary static suggestion rows untranslated. The diagnostic exits zero and all 15
requests complete, but seven `native-overlap` rejections explain this visual failure. This
is not the approved tiny-utility-label or dynamic-content fallback. The remaining pages
and repeats were stopped; those four V17 passes cannot replace the next final matrix.

Read-only source paint inspection confirms an absolute popup above underlying native
content, with an opaque RGB linear-gradient backing, padding-box clipping and rounded
bottom corners. The existing opacity guard only accepts fixed islands and rectangular
solid backgrounds. Two generic solid/gradient popup cases reproduce the static omission
on unchanged V17; preserve `popup-text-gradient-red.log` and its traces. An earlier pseudo
background hypothesis is not used as evidence for the actual page or added to product scope.

The correction remains in the existing structure compositor: browser paint order selects
already-covered native surfaces, and original opaque coverage bounds both source and
translated ink. Gradient alpha, uncovered media and expanded text are not silently exempted.
No hostname, source mutation, new permission, dependency or model retry is introduced.
Narrow regressions and live preflight are in progress; no completion claim.

The first correction passes 24 focused browser cases, but its real preflight still fails
(`1790057489894`). Temporary bounded geometry instrumentation, subsequently removed, shows
two overly restrictive cases in the same coverage contract: a shorter copied popup invalidates
already-opaque original coverage, and a static list beside a live input cannot use its parent
popup's background. A third generic input-bearing popup case reproduces the latter failure
(`popup-control-red.log`). Coverage now belongs to the original foreground, with browser hit
order proving it is above each protected native surface; source and translated ink must both
remain inside that coverage. A white ancestor behind the media is explicitly not such proof.
Keep all preflight, RED and intermediate failed protection evidence. A gradient pixel-equality
check failed once and passed unchanged on an isolated replay; repeated pixel verification is
still required rather than treating the isolated replay as final acceptance.

The corrected source-coverage preflight (`1790057965356`) renders all ten search-suggestion rows
both initially and after manual refresh, with 12 completed text-only requests and no native-overlap
rejection. The 16 remaining rejection entries are bounded utility labels, not ordinary suggestion
rows. Its screenshots also expose a shorter copied popup border inside the original border. A
generic auto-height popup with a shorter translation reproduces this discrepancy; out-of-flow
copies now retain the original minimum background/border height, without changing normal flow.

Repeated gradient protection checks isolate the intermittent difference to **57 channels out of
9,800, maximum delta 1/255** in the gradient, with no text or geometry change. The assertion now
decodes pixel channels: at most one quantization step inside a gradient, exact equality outside
the popup/on the native canvas, and unchanged source/input/translated-text checks. Failed traces
remain retained. This does not permit displaced edges or native media being blanked.

The first envelope build stopped at a fixture-only `Element`/`HTMLElement` type error, before
building. A concurrently launched preflight (`1790058386847`, misleadingly named `final` in its
log) therefore uses the preceding build and is **not** final-candidate evidence. Preserve it;
fix the fixture type and rebuild only after its dedicated Profile session closes. Fresh full
browser gates, final live preflight and the entire frozen matrix remain required.

The corrected envelope build (`v18-popup-build5.log`) passes typecheck/build. Focused browser
verification passes **37/37**, and the three gradient-protection variants repeated five times
pass **15/15**. Final live preflight `1790058629467` renders all ten suggestion rows initially
and after refresh, without the duplicate inner border: 12 completed text-only requests, no
model error/retry or native-overlap rejection. Both images were reviewed. The remaining 16
utility-label fallbacks retain their original readable text; inputs, icons and uncovered media
remain native. This two-stage preflight does not replace the full cross-site matrix.

Author self-review checks the source/copy ink bounds, original opaque coverage, paint-order proof
for ancestor backdrops, alpha/partial-gradient rejection, native media outside the popup, and the
out-of-flow minimum border envelope. The existing structure compositor adds **57 net lines** over
V17; the seven-owner change totals **718 net TypeScript lines** versus the archived inherited dirty
baseline. No new renderer, model path, dependency, permission, hostname rule or automatic retry.
This is author self-review, not independent review. Fresh full gates and final live matrix follow.

Final V18 repository gates pass: **1,758/1,758 unit tests** (142 files), **281/281 browser tests**
(10.3 minutes), format, zero-warning lint, typecheck/build, bundle audit (17 assets), sandbox,
catalogue (39 samples), doctor (six checks), and diff check. Evidence: `final-v18-*-confirmed.log`
for static/unit gates, `final-v18-browser.log` and `final-v18-doctor.log`. The 216 source/dist hashes
are frozen in `final-v18-candidate-sha256.txt`; each live round checks this manifest before the
canonical standalone verification. The final 13-page, five-repeat and two-supplement matrix is
in progress. No product edit or rebuild is permitted while collecting that candidate's evidence.

### V18 final matrix — in progress

The first five complete rounds have no model errors or retries. All requests are text-only;
context maxima remain below 6,000. The key source/translated, scroll, zoom and reopen images
were reviewed, not just the process exit status. Native source changes are distinguished below.
The remaining eight pages, five core repeats and two supplements are still required.

| Page   | Stages / requests | Evidence suffix                    | Reviewed result                                                                                                                                                                                                                                                                                          |
| ------ | ----------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wiki   | 16 / 9            | `lark-wiki-readable-1790059598061` | Heading, prose and actual table cells translate; selection tools/watermarks preserved. Horizontal pan 302.5 → 134. Two matched groups / 32 scroll events, zero measured offsets. Ten parent-equivalent editor run changes plus one native selection counter; zero style changes.                         |
| Docx   | 16 / 9            | `lark-readable-1790059734137`      | Both visible tables, prose and green inline emphasis retained. Horizontal pan 302.5 → 66. Seventeen parent-equivalent editor run changes, zero styles. Thirty-two scroll events but no unambiguous matched groups (one ambiguous); numerical zero-offset proof is not claimed from this page.            |
| Baidu  | 14 / 5            | `baidu-readable-1790059908654`     | Navigation and both hot-search columns readable, source ellipsis/badges/icons/button size preserved. No source changes or rejection. Homepage fits viewport: zero real scroll events, excluded from scroll claims.                                                                                       |
| QQ     | 14 / 10           | `qq-readable-1790060028252`        | Static headlines, link grids, photo captions and lists translated; photos/video native. Nine bounded utility-label fallbacks. Thirteen matched groups / 32 events, zero measured offsets. Source text differences localized to live stock quote rows; zero styles.                                       |
| hao123 | 14 / 15           | `random-hao123-1790060336382`      | All ten search suggestions translated; no duplicate border or native-overlap. Static grid/headlines retain fonts; 16 bounded utility labels preserve original text. Fifty-eight matched groups / 32 events, zero measured offsets. Source text unchanged; four page-owned home/weather/ad style updates. |

Evidence directories have the prefix `e2e/.runtime/lens-translation-`. Source page behavior
and deliberately native image/video/dynamic text are not counted as ordinary static omissions.

Retained V18 upstream failure: NetEase `random-netease-1790060771436` stops during initial
translation after one of 14 text requests returns HTTP 503. The visible notice is
`text/MODEL_TRANSIENT`; the diagnostic exits 1. No automatic retry, source change or product
correction is introduced for this response. Its evidence remains a failed attempt, and a fresh
complete replay of the same frozen candidate is required; other pages continue meanwhile.

### Execution latency audit (task continues)

The user requested a latency assessment without pausing this work. Read-only evidence from V18:
the full single-worker browser gate takes 10.3 minutes; Wiki's 16-stage live round takes 109.6
seconds and Docx's 103.0 seconds. The union of request-start to completed-stream intervals is
51.5/51.1 seconds respectively, not a sum of overlapping requests. The remainder includes page
startup, interactions, quiet-state proof, screenshots and cleanup; it is not all renderer CPU.
Page-state queries total 1.34/1.92 seconds, although unrelated page and extension main-thread
work is not isolated by that metric. Across retained completed whole-browser logs, 23 batches
sum to 177.1 execution minutes (not exclusive wall-clock time for the task).

The main avoidable cost is entering full validation too early, then repeating it after another
common defect. Prefer generic failing cases plus the actual failed page first, then one frozen
whole gate/matrix. Pipeline prior-page image review with the next serial live run and read compact
diagnostic summaries. Keep all required final checks. Synthetic browser parallelism needs a
separate focus/screenshot-isolation pilot; live concurrency requires independently authenticated
Profiles. Neither is silently introduced into this final candidate run.

## V17 continuation — native descendant footprint repair in verification

V16 gates pass (1,758 unit / 268 browser tests), but the first full Wiki run
`lens-translation-lark-wiki-readable-1790052176700` is not accepted. Initial/manual refresh retain
30 translations, while horizontal-back leaves one and reports 27 native-overlap rejections. A
separate cached-reopen failure contains an upstream `server_is_overloaded` stream error; HTTP 200
is not recorded as successful completion. Neither failure is discarded or waived.

Bounded, temporary geometry-only instrumentation reproduces the horizontal-back failure without
the upstream error (`lens-translation-lark-wiki-readable-1790052829766`). A moving transparent
descendant inside the pinned sidebar falls back to its entire rectangular box, although its
ancestor's foreground scan already distinguishes painted content from empty space. The original
source and dist hashes were restored and checked after removing the instrumentation.

The generic transparent native-descendant regression fails with no retained article translation;
the opaque-ancestor protection case already passes. V17 gives pinned descendants an independent
footprint in the existing bounded foreground walk and resets ancestor coverage at that boundary.
Actual painted children remain protected even under an opaque ancestor. No site rule, budget
increase, model retry, permission, source-page write or new module is added. Both variants and
the related popup, clipping and portal-removal regressions pass: **17/17**. RED trace/log and GREEN
log are preserved as `native-descendant-*` under the same private evidence root.

The first V17 live preflight still fails horizontal-back. Its second geometry probe confirms the
foreground scan is complete (53 painted surfaces, 59 pinned roots), so increasing budgets would
not address it. The collision is recorded while the sidebar is still moving; no animation-end
event remeasures the settled geometry. An independent CSS-animation fixture reproduces the
persistent loss after the native overlay moves entirely offscreen, with no subsequent DOM write.
The existing lifecycle now observes animation/transition end and cancel and invalidates only
geometry for an already-deferred branch. Cached static text may repaint; the moving branch stays
manual-refresh-only. Both failed preflights and the animation-end RED trace are retained.

Full live preflight, final gates and frozen matrix remain in progress. Completion is not claimed.

The animation-end correction passes 33 focused cases but the next real preflight still fails.
A second temporary probe confirms end events arrive and records the exact remaining discrepancy:
the opaque sidebar list paints above the article, but the cutout condition only checks the main
flow box and misses its existing table overflow. The V17 footprint extension had incorrectly
inherited the narrower absolute-media overlap guard. Keep that guard for absolute native media;
pinned descendants follow the established pinned-foreground cutouts. A generic sliced-flow table
plus native canvas boundary reproduces the loss (the two simpler unsliced attempts passed and are
not represented as RED). Preserve `native-overflow-red3.log` and its trace. Source pixels, ordinary
article/table translation, no extra requests and source immutability remain the GREEN assertions.

The corrected focused browser suite passes **41/41**. Real Wiki preflight
`lens-translation-lark-wiki-readable-1790054536969` completes all 16 interaction stages and nine
text-only model requests, with no retry or request failure. Initial/manual refresh and the
horizontal-back images were independently compared to source: headings, prose and table remain
translated; the actually animated sidebar stays original until refresh, and the native selection
toolbar/watermarks remain intact. There are no native-overlap rejections; only one bounded utility
label retains the approved label-overflow fallback. Horizontal wheel movement is 302.5 → 134 CSS
pixels. Continuous-scroll evidence has two unambiguous matched groups/32 actual events, no measured
offset, no replacements or hidden-layer samples; the unmatched group is not a zero-error sample.
Eleven source text observations comprise ten parent-equivalent editor run changes and the native
selection word-count SPAN (`rangecode-bomb-container-bottom show`); zero source style changes.
The preflight is not a substitute for the final frozen multi-site and repeat matrix.

Separate author review of V17 checks paint-footprint completeness, opaque ancestor coverage,
absolute versus pinned cutout contracts, animated-boundary event teardown and geometry-only
invalidation. The already-deferred branch is not rejoined or automatically requested. V17 adds
**22 net lines** over V16 in the three existing owners; total seven-owner delta is **661 net
TypeScript lines** versus the archived inherited dirty baseline. No extra layout engine, state
machine, dependency or permission. This is author self-review, not independent review.

Final V17 repository gates pass: **1,758/1,758** unit tests (142 files), **272/272** browser tests
(8.8 minutes), format, zero-warning lint, typecheck/build, bundle audit (17 assets), sandbox,
catalogue (39 samples), doctor (six checks) and diff check. Evidence: `final-v17-confirmed-*` for
format/lint/unit/diff and `final-v17-*` for browser/audit/sandbox/catalogue/doctor. The earlier
pre-correction checks are retained, not substituted. Final frozen identity records **216 source
and dist files** in `final-v17-candidate-sha256.txt`; the 13-page first round follows on this build.

## V16 continuation — dynamic boundary repair in verification

V15's deterministic gates pass: 1,758 units and 262 browser cases, format, lint, asset audit,
sandbox, catalogue, doctor and diff checks. Its frozen matrix is **not** accepted: Wiki's initial
stage briefly translates, then drops every group after a small native animated tooltip is removed.
The diagnostic terminal status alone misses this; initial screenshot/settling history identifies
the static omission. The queue was stopped after five completed pages (Wiki, Docx, Baidu, QQ and
hao123); their evidence remains. Unstarted pages and repeats are not reported as passing V15.

Four generic browser reproductions fail with an empty translation layer on V15: removing or
replacing static/animated portal branches under a shared application parent. The DOM mutation
owner promoted the removed branch to that shared parent, retiring unrelated static siblings. V16
transfers the boundary only to actual replacement elements; deletion does not defer an ancestor.
The first correction preserves static siblings but exposes a zero-height replacement-portal
refresh failure. Explicit refresh now also checks the branch's native Range content bounds.
This is a one-module lifecycle correction, not a site rule, automatic retranslation or new renderer.
Both RED evidence and the intermediate failed GREEN run/trace are retained. Two further cases
prove that remove+append in separate records of the same mutation batch must transfer the same
boundary. The owner indexes added branches once per batch. All six cases pass
(`removal-boundary-green3.log`); genuine moving-track and manual-refresh tests also passed in the
26-case focused run. The final whole suite includes both protections.

The preflight Wiki run (`lens-translation-lark-wiki-readable-1790051249986`) retains 30 translated
targets both initially and after explicit refresh, five completed text-only requests; both images
were compared. The affected 3.1 heading, prose and table remain translated; the native selection
toolbar and watermark remain intact. This preflight precedes the content-bounds correction and
does not substitute for the final frozen matrix. Narrow units: **220/220**. Full verification follows.

Separate self-review of this correction checks deletion, replacement, split records, zero-height
portals, explicit versus targeted refresh and unchanged-source behavior. The change adds **23 net
lines** in the existing DOM owner versus V15; the complete seven-owner renderer-contract delta is
**639 net TypeScript lines** against the archived inherited baseline. No second lifecycle owner,
new scanning loop on scroll, model request, protocol or dependency was added. The Range measurement
is limited to explicit full-region refresh; targeted failed-block retry does not clear dynamic
boundaries. Author review is not represented as independent review.

## V15 continuation — deterministic gates passed, live initial failure retained

V14's final repeat failures are retained below. The foreground fix stays in the existing DOM
collector and structure compositor: include positioned positive-z stacking owners, and continue
the bounded paint walk below opaque ancestors to retain overflowing surfaces. Covered child paint
does not create redundant cutouts; the existing 6,000-node/64-surface limits remain unchanged.
No hostname, site class, new module, permission or product request path was introduced.

Two generic relative/fixed-parent browser fixtures reproduce the paint failure on V14. V15 passes
their pixel-equality, native input/source integrity, cache reopen and popup-close checks, together
with native-visibility and partial-response regressions: **10/10** (`foreground-overflow-green3.log`).
The intervening fixture-only assertion/order corrections and artifacts remain alongside the RED
trace. The Retry helper also fails under the real tsx runtime before correction; a plain-JavaScript
browser program removes the injected closure helper. Its standalone regression passes, and the
narrow suite passes **220/220** (`v15-narrow-unit.log`).

The hao123 popup preflight (`lens-translation-random-hao123-1790049344780`) passes standalone verify
and two live stages, with 12 completed text-only requests and no model/transport error. Source and
manual-refresh screenshots were compared: underlying page translations no longer paint through
the open native suggestion surface; adjacent static translations remain visible. Tiny labels and
actual native collisions retain their explicit reasons. This is a preflight, not final acceptance.
Fresh repository gates, the full 13-page matrix, five repeats and two supplements follow on V15.

The first V15 whole-browser command stopped at TypeScript compilation: the new fixture's locator
callback could be typed as SVGElement and therefore could not assign `.hidden`. The fixture now
sets the same native `hidden` attribute through Element's API; product code and paint assertions
are unchanged. This failed command remains `final-v15-browser.log`; the complete rerun is
`final-v15-browser-confirmed.log`.

### Separate author self-review

Reviewed all seven changed production owners against `baseline.tgz`, the archived inherited dirty
candidate, rather than treating the large HEAD diff as this task's changes. Current delta is
**616 net TypeScript lines**, including **24 net lines** for V15. A separate generic renderer,
site registry or request/cache layer was not added. Three layout-adaptation branches were removed
from style copying; the constraint module owns adaptation. Inline templates are sanitized source
copies, model text is never interpreted as HTML, and graphic-only cells keep source sizing.

Reviewed strict envelope/identity handling, per-block validation, preview versus completed cache,
targeted explicit retry, generation cancellation, bounded revealed-target discovery, original-label
fallback termination, foreground collision/cutout ownership and listener teardown. Source data and
editable state are not assigned by those changes. Reviewed the existing context path: source-local
before/after passages share the total 6,000-character budget and enter untrusted input, never the
system instruction field. Public protocol, model settings, dependencies and permissions are not
changed by the renderer-contract continuation. No additional important code finding was identified
in this pass; final readiness still depends on the pending gates and live visual review.

This is author self-review, not an independent reviewer or subagent review. The explicit task
prohibits delegation. No deferred code-polish work is required for this scope. Approved limitations
remain image/OCR exclusion, manual refresh for changing content, native/live-surface protection and
original labels in unreadably small fixed slots; ordinary static omissions are not waived.

## V14 continuation — validation failed; follow-up in progress

The final repeat/supplement review exposes two additional failures, retained rather than waived:
hao123's second round (`lens-translation-random-hao123-1790048121408`) completes its requests but
the translated page paints over a native open search-suggestion surface. This fails native-pixel
protection and is not an approved untranslated-dynamic boundary. The first GitHub README supplement
(`lens-translation-github-readable-1790048320559`) isolates malformed model output, then the declared
explicit Retry diagnostic fails with `__name is not defined`: its shared browser-action helper
serializes a tsx closure helper. This is a harness failure, not successful recovery. The serial
queue exits one; no all-matrix pass is claimed. Investigate the shared foreground owner and add
generic regressions; preserve this candidate's evidence and repeat acceptance after correction.

The user explicitly requested continuing the unfinished items. V14 fixes the demonstrated
batch-failure propagation in place: the model envelope and source identities remain strict, while
each known block's text and markers are validated independently. Only completed valid blocks
reach the existing cache; invalid/missing IDs produce a visible error and keep source text.
The existing Retry action now refreshes only failed IDs. Alt/Option+R still refreshes the full
current region. No automatic retry, markup repair, new protocol, dependency or site rule.

This continuation changes three production modules by **24 net lines** versus V13. The complete
renderer-contract candidate changes seven production modules by **592 net lines** against the
archived inherited dirty baseline, not against HEAD. A UI-only change could not prevent the
provider parser from aborting on the first bad block; the existing parser, page scheduler and
DOM refresh owner each need a small coordinated correction.

Six added unit cases and the real-extension partial-response browser fixture failed on V13
(`partial-batch-red.log`, `partial-batch-browser-red.log`, retained trace archive). The repaired
candidate passes 219 translation units, 1,757 repository units and 11 focused browser cases.
The browser case verifies valid text on both sides of the malformed block, unchanged source,
no movement retry, a one-block explicit retry, full-size readable output and cache-only reopening.
The first full-gate build caught a diagnostic-only missing `notice` type; corrected and retained
in `final-v14-browser.log`. Whole-browser verification passes **260/260**
(`final-v14-browser-confirmed.log`, 9.1 minutes). All 13 frozen first real-page rounds now complete:
194 stages and 136 completed text-only requests, maximum supplied context 3,544 characters.
Their key screenshots are reviewed. No format-error retry was needed. The five core repeat rounds
then completed, but hao123 failed the visual boundary; the README supplement subsequently failed
in the Retry helper. First-round success did not establish final acceptance.

Wiki source attribution: a no-lens hover/double-click control and a longer source-cell control
leave table text/styles unchanged, while normalizing editor text runs. A separate CDP DOM
breakpoint probe watches 32 original cells with translation active: ten subtree mutations come
from the Feishu page's default-world editor bundle, none from extension code; final cell text is
unchanged. The no-lens breakpoint control independently captures transient cell text lengths
(54→60→54, 56→63 and 77→84 during run replacement) from the same page bundle, with unchanged final
text. Those initial probes alone did not explain the historical TD 30→10 case. The new frozen
matrix retains child-level metadata for any changed cell, without raw text.

**Source-cell observation closed by direct follow-up:** V14 Wiki reproduces the identical
`cell-121` 30→10 difference. All connected list content is unchanged; two ten-character ordered
blocks are disconnected and a `bear-virtual-renderUnit-placeholder` remains. A no-lens round trip
on the exact source cell proves the cause: visible = 34 characters / three list blocks; offscreen =
ten characters / one block / one placeholder; visible again = 34 characters / three blocks with
exactly equal full text. The four-character difference from the early 30-character sample occurs
after editor run/zero-space normalization, not missing list content. All 31 captured DOM mutations
originate in the Feishu default-world editor bundle; the trace includes cell lengths 10, 20 and 30
as its list blocks are mounted. This is source virtualization, not document data deletion or an
extension source write. Evidence: `source-cell-virtualization-roundtrip2.log` plus Wiki's child
metadata. The first round-trip control timed out because its offscreen heading was itself
unmounted; corrected the probe to restore the original scrollport positions, not any source text.
That failed probe is retained in `source-cell-virtualization-roundtrip.log`.

Evidence: `e2e/.runtime/renderer-contracts-20260921-AG6WCY/`; source/build identity:
`final-v14-candidate-sha256.txt`. No commits, pushes, subagents or document-writing actions.

### V14 first real-page rounds

Every row has a successful standalone verification followed by the full interaction diagnostic on
the same frozen production candidate. Each stage retains a screenshot and opaque target outcomes;
the paths below are inside `e2e/.runtime/`. All 13 commands exit zero, and their recorded failures,
model/transport errors and format retries are empty. These are native feature diagnostics, not
WorkSession benchmark runs.

| Page              | Stages / requests | Evidence directory                                  | Reviewed display and qualifications                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feishu Wiki       | 16 / 9            | `lens-translation-lark-wiki-readable-1790045727366` | Refresh and reverse horizontal pan: 3.1 heading, prose, table cells and watermark retained. Two matched groups / 32 scroll events; source-cell virtualization attributed by the exact-cell control above.                                                                                           |
| Feishu Docx       | 16 / 9            | `lens-translation-lark-readable-1790046198489`      | Initial and horizontal pan: English table cells wrap at native font size, heading/prose/watermarks retained. Actual 236.5px pan. Zero matched / one ambiguous vertical pair despite 32 events; no numeric zero-drag claim.                                                                          |
| Baidu             | 14 / 5            | `lens-translation-baidu-readable-1790046314966`     | Initial and post-zoom refresh: horizontal navigation, hot-list ellipsis/badges, original font size. Inputs/placeholders and logo remain native. No vertical scroll range; zero events do not prove absence of drag.                                                                                 |
| QQ                | 14 / 9            | `lens-translation-qq-readable-1790046387051`        | Initial and scroll-down: static headlines, photo captions and lists translate; photographs/video preserved. Complete tiny utility originals with notice. Thirteen matched groups / 32 events, no measured offset. Source changes are stock/ticker updates, no style change.                         |
| hao123            | 14 / 14           | `lens-translation-random-hao123-1790046512873`      | Refresh and scroll-down: icon/link grid, photos, list typography and fixed search remain intact. Tiny labels, animated snippets and native media stay original. Fifty-six matched groups / 32 events, no measured offset. Four page-owned display/weather/advertisement style changes.              |
| Sina              | 14 / 17           | `lens-translation-random-sina-1790046657719`        | Refresh and scroll-down: navigation, multi-column news, photos and overlay captions retained. Narrow labels and moving recommendations keep originals. Five matched groups / 57 events, no measured offset. One stationary replacement, not reported as zero.                                       |
| NetEase           | 14 / 27           | `lens-translation-random-netease-1790046796717`     | Refresh and scroll-down: static headline block, two columns, photo cards and typography readable. Native carousel/advertising boundaries retained. Five matched / one ambiguous pair, 32 events, no measured offset. One stationary replacement and one page-owned advertising sprite style change. |
| Runoob HTML table | 16 / 6            | `lens-translation-random-runoob-1790046983669`      | Refresh and scroll-down show the actual table: header, all visible descriptions, tag names, alternating row backgrounds and previous/next controls. Two matched groups / 32 events. Horizontal wheel has zero displacement, not panning coverage.                                                   |
| MDN               | 14 / 6            | `lens-translation-mdn-readable-1790047058956`       | Refresh and scroll-down: heading, prose, sidebar, inline-code background and native embedded example/control surfaces retained. Five matched groups / 32 events. No source text/style change.                                                                                                       |
| React             | 14 / 6            | `lens-translation-random-react-1790047141255`       | Refresh and scroll-down: full-size search, headings, list, sidebar and inline code; preformatted examples unchanged. Four matched groups / 32 events. No source text/style change.                                                                                                                  |
| GitHub            | 16 / 10           | `lens-translation-github-readable-1790047216569`    | Refresh and scroll-down: navigation, file list, commit descriptions, links and avatars remain readable. Source filenames and native relative-time components preserved. Twenty-five matched groups / 32 events. Horizontal wheel has no displacement.                                               |
| Wikipedia         | 16 / 8            | `lens-translation-wikipedia-table-1790047329803`    | Refresh and horizontal-pan images preserve prose, links, combined table headers, cell colors and footnotes. Four matched groups / 32 events, actual 25px horizontal displacement.                                                                                                                   |
| Hacker News       | 16 / 10           | `lens-translation-random-hackernews-1790047456029`  | Refresh and scroll-down: compact titles, metadata, ranks and footer remain readable. Two matched groups / 32 events. Source text/styles unchanged; horizontal wheel has no displacement.                                                                                                            |

All matched moving pairs have zero measured source/copy offset in this first-round sample; unmatched
and ambiguous pairs are not included in that claim. Stationary samples contain no hidden frames;
Sina and NetEase each have one replacement alongside native page mutation, with no sustained blank
or duplicate layer in reviewed output. No all-websites or every-compositor-frame guarantee follows.

## V13 checkpoint (retained historical assessment)

Status at that checkpoint: **not complete overall**. V13 deterministic gates pass (1,753 unit / 259 browser tests).
All 13 first real-page rounds, five core repeat rounds and the code/README supplemental probes
have completed and their key screenshots are reviewed on the same frozen source/build. Their
successful display results are bounded evidence, not an all-attempts reliability pass: one QQ
repeat and the first README probe failed model-marker validation before unchanged-build replays.
A changed Wiki source-cell node also lacks conclusive attribution; the no-lens control reproduces
editor text-run normalization but not that cell change. Neither uncertainty is silently waived.
Earlier failed evidence below is retained, not relabeled as passing.
Do not interpret a successful request or a settled diagnostic stage as visual acceptance.

### V13 architecture assessment and remaining closure

The renderer now has one layout-adaptation owner and a separate bounded discovery owner. It keeps
source typography, complete structural binding, native surfaces and transactional original-label
fallback. The current six-module production delta is +568 net lines against the archived inherited
dirty baseline, not against HEAD. No new production module, dependency, permission, hostname branch,
model protocol, cache owner or retry path was introduced. Three duplicated style-copy adaptation
branches were removed. The complexity is not eliminated: a readonly lens must still reconcile
translated flow with an independently laid-out, scrolling source and protected native media.

The final matrix's **18 completed full rounds** contain 268 diagnostic stages and 180 completed
text-only requests, with maximum supplied context 3,544 characters (configured cap remains 6,000).
The two successful supplemental probes add four stages / ten requests. These are native diagnostic
counts, not WorkSession benchmark successes. Interrupted/failed attempts are additional and retained.
The 216-file source/build manifest matches after the entire matrix (`v13-freeze-after-matrix.log`).

There is a concrete remaining request-boundary weakness. `translateTexts` rejects the complete
batch when one streamed block has invalid inline markers; the page then marks all IDs in that
request failed and removes its uncommitted previews. Rejecting malformed markup is correct, but
its failure scope is wider than the offending block. QQ omitted a complete marker pair; README
omitted one opening marker. This retained protocol behavior was not redesigned in this renderer
task. Unchanged-build replay demonstrates that valid output renders correctly; it does **not** fix
the model-format failure or establish reliable recovery. Item-level validation/outcomes and targeted
explicit retry should be evaluated as the common fix, without guessing missing markup, weakening
validation or adding automatic provider retries. No such behavior change has been implemented here.

The remaining Wiki source-integrity observation is recorded below. Because its provenance is not
fully established, the source-safety part of acceptance remains open. Code self-review finds writes
targeting inert copies, not source text/styles; deterministic source-immutability tests pass. These
facts are not a substitute for explaining the observed live cell change.

## V12 approved bounded-label fallback

The user selected keeping unreadable fixed utility labels original with the existing unsupported
notice, without font shrinking or internal vertical rearrangement. Generic button/toolbar fixtures
fail on V11 (`utility-red.log`, retained traces); the same shared constraint owner measures fractional
ink bounds after row allocation. Only clipped utility labels or clipped single-line slots narrower
than three em fall back through the existing safe source-marker binding. Larger headline ellipsis,
normal prose and sufficiently roomy controls retain translation. `label-overflow` is a layout
boundary, not a model failure, and it neither retries nor changes provider/cache protocols.

The first implementation replay found that the adaptive 7px gap was 1px wider than the tiny source
button's 6px spare gap. Its failure is preserved (`utility-original-gap-failure.tgz`); native button
gaps now retain enough space for the original label/icon. The two focused lifecycle cases pass,
including refresh/reopen, normal adjacent translations and unchanged source/input. A 79-case
structural/paint regression passes (`utility-regression.log`). An initial test typecheck failure
was confined to an Element/HTMLElement annotation and is retained in `utility-build.log`.

Canonical doctor/verification plus live QQ initial/refresh evidence
`lens-translation-qq-readable-1790037242421` confirms search/AI/right-toolbar originals and the
notice, but still exposes tiny non-button weather readouts. A separate generic readout/direct-button
test fails before broadening the same constraint check (`tiny-label-red.log`, retained trace).
All four compact-row tests then pass (`tiny-label-green.log`), including complete short navigation
labels, intact graphic widths and no source mutation. This two-stage live probe is diagnostic only,
not the final full QQ/matrix acceptance. No site-specific branch, dependency or extra renderer added.

## V12 failure and V13 source-layout restoration

V12 format/lint, 1,753 units, bundle/sandbox/catalog/doctor and diff gates passed. Its whole-browser
run was stopped with **155 passes, five failures, one interrupted and 95 unrun**, not accepted.
The five failures expected abbreviated tiny controls to be ready; their expectations are updated
for the explicitly approved original-label boundary while retaining source, typography, geometry,
adjacent-translation and lifecycle checks. Motion-only fixtures use fitting translations so they
continue to test stability independently of overflow fallback.

Full QQ `lens-translation-qq-readable-1790037664674` completed 14 stages and ten requests, but the
restored city was still clipped. A read-only probe (`1790038106029`) identified a generic flex row
with a pre-existing max-width plus auto-height readouts. Inserting original text into the already
redistributed boxes did not restore their source widths. The source-derived generic fixture fails
with 46.734375px reduced to 35.15625px (`fallback-layout-red2.log` and archived trace).

V13 includes allocated row cells in the same bounded-label check, then synchronously recreates
the safe copy with affected labels/layout kept original and neighboring translations reapplied.
Original decisions retain the model value for cache reuse and are reconsidered on width/source/
value changes. The temporary button-gap exception is removed. Eight targeted cases pass
(`fallback-layout-green.log`), including restored original widths and translation becoming visible
when its source control gains room. Initial syntax/typecheck failures are preserved in
`fallback-layout-build{,2}.log`; the successful build is `fallback-layout-build3.log`.
This is not yet final real-page acceptance.

The first V13 92-case focused replay passed but live QQ `1790038754375` still clipped the city.
Read-only copy geometry in `1790039076737` showed an adjacent changed unit label keeping the shared
row adaptive after its city/condition fell back. A nested generic fixture reproduces 48px original
text compressed to 38.5px (`nested-fallback-red2.log` / trace archive); its first version had a
shrinkable graphic unlike the measured source and was not used as the reproduction. The row owner
now reserves unchanged/original cell widths too. If this exposes another clipped tiny label, the
same synchronous fallback transaction repeats monotonically: at least one translated entry is
removed per pass, bounded by the group's entry count. There are no asynchronous retries, provider
calls or per-frame copy loops. Narrow and full verification must be repeated after this correction.

The corrected V13 related browser replay passes **93/93**. QQ initial/refresh diagnostic
`1790039531511` shows the complete original city and condition with static news/nav/card translation
retained. Fresh format/lint, **1,753/1,753 units**, bundle/sandbox/catalog/doctor/diff gates pass.
The 216-file `final-v13-candidate-sha256.txt` is frozen after the full-browser command's build;
there is no subsequent production edit or rebuild during real-page acceptance.

The first full browser run finished with **257 passes and one failure**. Its retained
`final-v13-browser.log` and `final-v13-browser-artifacts.tgz` show an old display-contents fixture
expecting `Upvote` inside a detached 52px button beside a native input. The prior assertion required
only nonzero painted width, not the complete label. This is the explicitly changed narrow-control
contract, not a new zero-width island regression. Without changing production code or rebuilding,
the fixture now verifies both a fitting `Vote` and original-label fallback for `Upvote`, including
complete ink, original width/font/line-height, unchanged source and unmoved input. Both pass in
`display-contents-contract.log`; the fresh full replay passes **259/259** in
`final-v13-browser-confirmed.log`. A missing HTMLElement generic in the test's shadow-root query
caused the first standalone typecheck to fail; this test-only annotation is corrected and
`final-v13-typecheck-confirmed2.log` passes. Lint and the second format check also pass. The live
queue was stopped during
Sina after 13 stages while investigating; that interrupted attempt is retained and not a pass.
Source/build hashes still match the original V13 freeze, so completed earlier V13 rounds remain
the same candidate, not stitched versions. The eight remaining pages resume with Sina in a new page.

### V13 frozen real-page matrix (13 first rounds reviewed; repeat details below)

| Page              | Full round                        | Evidence and qualifications                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QQ                | Pass within approved boundaries   | `lens-translation-qq-readable-1790039681838`: 14 stages, 11 requests all successful/text-only, max context 2,596. Initial/refresh/scroll/125%/final-reopen images reviewed. 13 matched groups, 32 real scroll events, zero measured offset/replacements; 241 stationary frames with no hidden frames/replacements. Original-label utility boundaries and native image/video text remain. Four source text changes belong to page-owned stock values; no source style change. Freeze matches before/after. |
| Wiki              | Pass within approved boundaries   | `lens-translation-lark-wiki-readable-1790039837035`: 16 stages, nine successful text-only requests, max context 1,206. Source/refresh/scroll/horizontal/final images reviewed; 3.1 heading and table translate, watermark retained. Horizontal pan 168.5px; two matched scroll groups with 32 events and zero measured offset/replacement. Editor run normalization has unchanged parent text; separate word-count widget changes are page-owned; no source style changes.                                |
| Docx              | Pass within approved boundaries   | `lens-translation-lark-readable-1790039953339`: 16 stages, nine successful requests, max context 1,575. Title/prose/table/watermark and 236.5px horizontal pan reviewed. 32 scroll events but zero matched/one ambiguous pair, so no numeric zero-drag claim. Stationary frames show no hiding/rebuilding; editor text-run changes retain parent text and source styles.                                                                                                                                  |
| Baidu             | Pass within approved boundaries   | `lens-translation-baidu-readable-1790040061664`: 14 stages, five successful text-only requests, max context 966. Refresh/zoom screenshots show normal horizontal navigation, hot-list ellipsis, badges and readable search button. 153 sources unchanged. No vertical scroll range: no zero-drag claim from its zero events.                                                                                                                                                                              |
| hao123            | Pass within approved boundaries   | `lens-translation-random-hao123-1790040140888`: 14 stages, 13 successful text-only requests, max context 1,362. Refresh/scroll/zoom screenshots preserve grid icons, images and native typography. Tiny utility originals and native media/dynamic snippets remain. 57 matched groups, 32 events, zero measured offset/replacement; 234 stationary frames without hiding/rebuilding. No source text changes; four page-owned display/weather/advertisement animation style changes.                       |
| Sina              | Pass within approved boundaries   | `lens-translation-random-sina-1790040600384`: 14 stages, 17 successful text-only requests, max context 1,667. Refresh/scroll screenshots retain photos, columns and headline typography; narrow labels and changing recommendations remain original. Five matched groups / 32 scroll events / zero measured offset. 233 stationary frames, no hiding, one replacement (not reported as zero). 1,412 sources unchanged. Earlier interrupted Sina evidence is not a pass.                                   |
| NetEase           | Pass within approved boundaries   | `lens-translation-random-netease-1790040763521`: 14 stages, 25 successful text-only requests, max context 1,373. Static headings, columns and photo captions reviewed; native carousel/advertising boundaries retained. Five matched scroll groups / 32 events / zero measured offset. 229 stationary frames without hiding/rebuilding. No source text changes; one page-owned advertising sprite style animation.                                                                                        |
| Runoob HTML table | Table pass; code probe reviewed   | `lens-translation-random-runoob-1790040979025`: 16 stages, six successful text-only requests, max context 1,277. Actual table headers/cells, tag names, row colors and links reviewed. Two matched groups / 32 scroll events / zero measured offset. 240 stationary frames without hiding/rebuilding; 1,223 sources unchanged. Horizontal wheel has no displacement, so it does not establish panning coverage.                                                                                           |
| MDN               | Pass within approved boundaries   | `lens-translation-mdn-readable-1790041060433`: 14 stages, six successful text-only requests, max context 2,266. Heading/prose/inline code background/badge/TOC reviewed. Native shadow controls and interactive demo remain unchanged. Five matched groups / 32 events / zero measured offset. 242 stationary frames without hiding/rebuilding; 785 sources unchanged.                                                                                                                                    |
| React             | Pass within approved boundaries   | `lens-translation-random-react-1790041135977`: 14 stages, six successful text-only requests, max context 1,839. Header/sidebar/prose/list translations and preserved code indentation reviewed, including scrolled header appearance. Four matched groups / 32 events / zero measured offset. 242 stationary frames without hiding/rebuilding; no source text/style changes.                                                                                                                              |
| GitHub            | List pass; README replay reviewed | `lens-translation-github-readable-1790041207123`: 16 stages, ten successful text-only requests, max context 1,643. File rows, links, navigation, toolbar, avatars and native text size reviewed. Native relative-time widgets stay unchanged. 25 matched groups / 32 events / zero measured offset. 242 stationary frames without hiding/rebuilding; 698 sources unchanged. Horizontal wheel has no displacement.                                                                                         |
| Wikipedia table   | Pass within approved boundaries   | `lens-translation-wikipedia-table-1790041319820`: 16 stages, seven successful text-only requests, max context 3,544. Actual merged-row table, heading/prose/emphasis and links reviewed; horizontal movement 25px. Four matched groups / 32 events / zero measured offset. 241 stationary frames without hiding/rebuilding; 12,028 sources unchanged. This large DOM reaches the explicit discovery node budget and displays the partial-unsupported notice; this is not a claim of whole-page coverage.  |
| Hacker News       | Pass within approved boundaries   | `lens-translation-random-hackernews-1790041446681`: 16 stages, ten successful text-only requests, max context 2,675. Compact navigation/list headings/metadata, arrows, numbering, typography and background reviewed. Two matched groups / 32 events / zero measured offset. 241 stationary frames without hiding/rebuilding; 631 sources unchanged. Horizontal wheel has no displacement.                                                                                                               |
| Five core repeats | Completed; qualifications below   | Same frozen build. The first QQ repeat failed model validation before an unchanged replay; the Wiki cell attribution remains open.                                                                                                                                                                                                                                                                                                                                                                        |

### Core repeat interruption: invalid model markers, not a layout regression

Wiki, Docx and Baidu repeats complete on the same V13 source/build. The first QQ repeat
(`lens-translation-qq-readable-1790042146766`) is **failed**, not counted as a completed round.
Initial translation settles; manual refresh enters `TRANSLATION_RESPONSE_INVALID`. Read-only
request/stream shape evidence identifies `text-179`: its request contains `<m0></m0>`, but its
completed streamed item contains no marker. The sixth stream stops after 19 of 30 items with
five preceding completed requests; the diagnostic later expires waiting for every transport to
finish. Earlier successful translations remain visible and the error/retry notice is present.

The layout implementation cannot safely invent a missing inline boundary. This is an existing
model-output failure mode, also retained in earlier V2 evidence, not a reason to relax validation
or add automatic retry. The failed attempt stays in the report. QQ's fresh-page replay uses the
same product, model, profile and assertions and completes; this is diagnostic separation, not a
claim that the failure has been fixed.

### Five core repeats and supplemental content

All evidence directories below are under ignored `e2e/.runtime/`; logs are under
`renderer-contracts-20260921-AG6WCY/`. Static rendering screenshots were independently compared
with the source, rather than accepted solely from request completion or status.

| Page                           | Evidence                                            | Result and limits                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wiki                           | `lens-translation-lark-wiki-readable-1790041829137` | 16 stages / nine requests; heading, prose, table, watermark, horizontal pan and final reopening reviewed. Pan 168.5px. Two matched / one unmatched scroll group, 32 events, zero measured offset; 241 stationary frames with no hiding/replacement. No style changes. The source-cell observation below prevents full source-integrity closure.                                                                                                                       |
| Docx                           | `lens-translation-lark-readable-1790041962902`      | 16 stages / nine requests. Heading/prose/table/watermark and 236.5px pan reviewed. 242 stationary frames without hiding/replacement. 32 real scroll events but zero matched / one ambiguous pair, so no numeric zero-drag claim. Editor run changes retain parent text; no style change.                                                                                                                                                                              |
| Baidu                          | `lens-translation-baidu-readable-1790042072758`     | 14 stages / five requests. Manual refresh and 125% images retain horizontal navigation, readable search, hot-list ellipsis and badges. All 153 sources unchanged. No vertical scroll range; zero events do not establish absence of drag.                                                                                                                                                                                                                             |
| QQ replay                      | `lens-translation-qq-readable-1790042371872`        | 14 stages / ten requests after the retained failed attempt. Manual/continuous-scroll/down/final images reviewed: complete original tiny controls, translated static news/photo captions, native media retained. 13 matched groups / 32 events, zero measured offset/replacement. Stationary observation has 153 frames, no hiding, five replacements alongside 100 page mutations; not reported as zero. Source price/ticker updates are page-owned; no style change. |
| hao123                         | `lens-translation-random-hao123-1790042515606`      | 14 stages / 13 requests. Manual/scroll/125% images preserve grids/icons, photos and native fonts. 57 matched / two unmatched groups, 32 events, zero measured offset/replacement; 236 stationary frames without hiding/replacement. No source text changes; four page-owned weather/advertisement/display style changes. Tiny/native/dynamic boundaries remain.                                                                                                       |
| Runoob code supplement         | `lens-translation-random-runoob-1790042666298`      | Two stages / seven requests, max context 1,817. Source and refreshed HTML example visually compared: nested indentation, tag colors, code structure, prose and neighboring controls retained. Complements the actual-table full round, not an extra full round.                                                                                                                                                                                                       |
| GitHub README first attempt    | `lens-translation-github-readable-1790042720108`    | **Failed** initial stage, one HTTP-200 stream without completed response. Requested `text-1` has marker pairs m0–m3; its returned complete item omits opening `<m2>` but retains `</m2>`. Strict validation rejects it and all 26 request IDs become model-failed. This is not a layout rejection.                                                                                                                                                                    |
| GitHub README unchanged replay | `lens-translation-github-readable-1790043075994`    | Two stages / three completed requests, max context 2,871. README paragraph, source-owned links, installation headings, code backgrounds/content and contribution list visually reviewed. No layout rejection; native tabs/badges/relative-time remain. Passing replay does not erase the first model-format failure.                                                                                                                                                  |

### Source-cell attribution remains open

The second Wiki full round observes ten editor text-run changes with identical parent text, a
word-count widget update, and one connected TD whose text length changes from 30 to ten characters
without identical parent text. No source style changes are recorded. A screenshot or a passing
unit immutability test cannot by itself explain that one TD change.

The generic no-lens control uses the same canonical catalog/profile/readiness path, navigates and
selects only, and makes no translation/model/document-write request. `v13-source-control.log`
records `lensPresent:false`, 617 sampled nodes, three disconnections, zero style changes, ten
run-normalization changes with identical parent text and one separate widget update. It confirms
native editor hydration, but **does not reproduce the TD change**. Do not assert a document write,
but also do not label this particular cell change conclusively harmless without further evidence.
Its attribution remains a required verification item, not grounds to weaken source safety.

### Review and command status

A separate self-review, without agents, inspected the six production deltas, source/copy write
ownership, bounded fallback termination, geometry/clip ownership, request generations and the
unchanged strict marker protocol. The code is not claimed to have received independent review.
Full unit/browser and static gates are recorded above; source/build hashes match after all live
work. Runtime authentication used only the canonical dedicated profile; no credentials, document
text or raw model responses are included in this report. Changes remain uncommitted and unpushed.

## Candidate and scope

The baseline is the inherited dirty `feat/refactor_dev` worktree at HEAD
`d503bbb9b9d8081e126e427aabf9903002558350`, not a clean checkout of that commit.
Baseline source, tests, bundle, status and differences were retained under
`e2e/.runtime/renderer-contracts-20260921-AG6WCY/`. The preceding V8 frozen source/bundle
identity is `final-v8-candidate-sha256.txt` (216 source/build files), verified before that
matrix. V8 is no longer the current candidate and its passes cannot close V11 acceptance.
All edits remain uncommitted and unpushed.

This is a focused renderer-core correction, not a second translation engine. It retains the
movable lens, read-only source policy, native typography, context/input protocol, cancellation,
cache and manual dynamic refresh. There are no new dependencies, permissions or site-layout
branches. The existing document privacy adapter remains; image translation/OCR stays absent.

## V8 live failure and V9/V10 correction

V8 full QQ evidence `lens-translation-qq-readable-1790029442905` completes 14 stages/11
requests, but trailing primary navigation items disappear beyond the viewport. This is a
product layout failure. Read-only source probes `lens-translation-qq-readable-1790029631342`
and `lens-translation-qq-readable-1790030088743` identify one shared flex row: 1440 CSS px,
19 items, 20px caption line-height, but actual single-band glyph ink is 25px high (22.5px at
0.9 CSS zoom). The old union-height/line-height test incorrectly excludes the whole single
line from adaptation. The generic tight-line fixture fails before V9, then passes after line
recognition also admits a single actual glyph band (`nav-ink-line-{red,green}.log`, RED trace).

V9 QQ probe `lens-translation-qq-readable-1790030262847` no longer loses the entire nav tail,
but short labels are still disproportionately truncated, and the trailing inline icon wraps.
A generic six-label flex fixture reproduces a fully available 41px short label being clipped
to 16.625px (`compact-short-red.log` and retained trace). V10 uses the existing bounded row
owner's intrinsic capped sharing for both original and converted flex rows, rather than
shrinking every label proportionally. Label formatting follows the actual cell, not its parent
row, so an inline label/icon pair is not converted into separate block lines. No character
threshold, hostname rule, font shrinking, extra rendering path or wider source mutation is added.

The separate QQ search-control probe `lens-translation-qq-readable-1790030207447` identifies
a fixed 51px button containing a 17px icon and a 28px label next to another independently
positioned button, all over a native input. Full English text cannot occupy this same slot
without changing the internal layout or giving up the translation there. The current overly
short `S…`/`A…` output is **not accepted as readable**. The user was asked whether to preserve
these bounded native controls or allow different internal arrangement; no new fallback is
implemented without that decision. The shared-navigation defect is separate and still repaired.

V9 format/lint and 1,753/1,753 unit tests passed; its focused browser suite passed 54/54.
The V9 whole-browser run was deliberately interrupted after the second generic RED case:
56 passed, one interrupted, 195 not run; exit 130. This is **not** a passing whole-suite result.
Fresh V10 validation is required. No failed evidence or source changes were rolled back.

V10's preliminary QQ probe `lens-translation-qq-readable-1790030866229` confirms the nav
tail/short labels/inline arrow improvement, but catches a **newly introduced** defect: the
intrinsic `max-content` cap also reaches text-free background graphics, whose intrinsic text
width is zero. A generic 120px blue graphic is reduced to 0px on V10
(`compact-decoration-red.log`, retained trace). V11 keeps the original measured decoration
width out of that text-only cap. No site-specific logo treatment is added. The V10 full browser
run was deliberately interrupted (21 passed, one interrupted, 231 not run), not counted as a
pass. V10 format/lint and 1,753 units passed, as did the 37-case narrow compact suite, which
did not yet contain this new decoration case. Its first typecheck also caught a test selector
typed as Element instead of HTMLElement; the test annotation was corrected before the build
replay. The QQ probe overlapped a same-source rebuild and is only preliminary diagnosis,
not frozen-matrix acceptance. The fresh V11 evidence below replaces that preliminary probe.

## V11 current verification

The first V11 whole-browser command finished with **253 passes and one failure**, not a pass.
The failure required the nested navigation anchor itself to have `display:block`, `overflow:hidden`
and a 28px box. The intended cell-owned clipping retains that anchor inline: its glyph box is
22px, inside the original 28px cell. The retained screenshot shows three same-font, single-line
ellipsized labels with intact spacing. The failed trace/screenshots remain in
`final-v11-nested-inline-failure.tgz`; no product code was changed to satisfy the old shape.

The corrected test checks the actual clipping owner (anchor or cell), mandatory hidden overflow
and ellipsis, 28px line budget, 20px font, retained source hrefs/full translated strings, painted
extents, nonzero visible label width, same-line alignment, at least 9.5px adjacent spacing, and
unchanged source HTML. The targeted regression/compact-row replay passes **20/20**. This is an
assertion of the approved output contract, not removal of overflow/font/source protections.
The first full replay then caught TypeScript's unchecked indexed access in the new adjacent-row
assertion before browser execution. An explicit missing-row guard corrects the test typing;
the failed build log remains `final-v11-browser-replay.log`. The fresh whole command
`final-v11-browser-replay2.log` passes **254/254** in 8.3 minutes, including fresh typecheck/build.

V11 repository units pass **1,753/1,753** in 141 files (`final-v11-unit.log`). The focused contract,
compact, clamp and relative-budget browser gate passes **38/38** (`compact-decoration-green.log`).
The current renderer-core delta against the archived dirty baseline is six existing production
TypeScript modules, **+478 net lines**; there is no new production module, provider path,
dependency, permission or hostname layout branch. A separate self-review checked source-only
inline shells/links, cell-owned layout constraints, shared collision/cutout footprints, bounded
discovery/reconciliation, and wheel listener lifecycle. This is self-review, not independent review.

All required deterministic gates have exit status 0: `npm run format:check`, `npm run lint`,
`npm run test:run -- --maxWorkers=2`, `npm run test:e2e`, `npm run audit:bundle` (17 assets),
`npm run check:sandbox`, `npm run e2e:catalog:validate` (39 samples), canonical doctor (six
checks), and `git diff --check`. Evidence uses `final-v11-*`; the final format/lint replay uses
the `replay2` suffix. The pre-existing Node NO_COLOR/FORCE_COLOR warning remains; zero-warning
lint passes. `check:codex` is not run and no Profile credentials are extracted.

## V11 frozen QQ correction replay and remaining gate

The candidate manifest `final-v11-candidate-sha256.txt` contains 216 source/build files.
Before/after checks pass (`v11-freeze-{before,after}-qq.log`); no source edits or builds occurred
during live execution. Canonical standalone verification passes before the diagnostic. Evidence:
`lens-translation-qq-readable-1790032762792`, command log `v11-qq-full.log`.

The full 14-stage interaction completes with ten successful text-only requests, maximum context
2,591 characters, and no model error or layout rejection. Reviewed original, initial, refresh,
scroll-return, 125% zoom, third-reopen and restored-source images confirm the main navigation
tail/More arrow and text-free Tencent/product graphics are retained; news columns, photo captions
and images remain intact. Still-playing video/image-internal text remain native by contract.
All 537 tracked original elements have zero text/style changes or disconnections. Stationary
sampling records 232 frames, zero hidden/replaced layers; real scrolling records 180 frames,
32 events and 13 matched source/copy groups, with zero ambiguous/unmatched groups and zero
measured event/frame offset. This is bounded evidence, not a guarantee for all scrolling.

**QQ still fails overall visual acceptance:** native fixed small labels show `S…`, `A…`, `R…`
or `F…`; weather and dense product labels are also heavily ellipsized. Zero diagnostic errors
does not close this readable-output failure. The earlier source measurement identifies the
51px search button with its 17px icon and 28px text slot. Changing these independently bounded
controls' arrangement or leaving them untranslated changes the requested output contract, so
the pending user choice is not silently resolved by retaining one-letter translations or by
classifying ordinary static omissions as dynamic. No additional fallback was implemented.

Current-candidate real-page acceptance status (older candidates cannot substitute):

| Page                    | Current V11 evidence                                                 | Required repeat |
| ----------------------- | -------------------------------------------------------------------- | --------------- |
| QQ                      | Full 14-stage correction replay; **fails** small-control readability | Not run         |
| Lark Wiki               | Not rerun on V11; V8 bounded pass retained separately                | Not run         |
| Lark Docx               | Not rerun on V11; V8 bounded pass retained separately                | Not run         |
| Baidu                   | Not rerun on V11; V8 pass retained separately                        | Not run         |
| hao123                  | Not rerun on V11                                                     | Not run         |
| Sina                    | Not rerun on V11                                                     | Not required    |
| NetEase                 | Not rerun on V11                                                     | Not required    |
| Runoob HTML table       | Not rerun on V11                                                     | Not required    |
| MDN table               | Not rerun on V11                                                     | Not required    |
| React Quick Start       | Not rerun on V11                                                     | Not required    |
| GitHub TypeScript       | Not rerun on V11                                                     | Not required    |
| Wikipedia browser table | Not rerun on V11                                                     | Not required    |
| Hacker News             | Not rerun on V11; earlier provider-invalid response retained         | Not required    |

Do not ship this status as “all pages passed.” The deterministic gates and specific layout repairs
are verified; the final 13-page/five-repeat acceptance remains open pending the small-control
decision and the corresponding frozen-candidate runs. Worktree remains uncommitted/unpushed;
evidence and the plan ledger are retained, not deleted.

## V8 preceding deterministic verification

Required deterministic checks pass: `npm run format:check`, `npm run lint`,
`npm run test:run -- --maxWorkers=2` (1,753/1,753, 141 files), `npm run test:e2e`
(251/251, 8.2 minutes, fresh typecheck/build), `npm run audit:bundle` (17 assets),
`npm run check:sandbox`, `npm run e2e:catalog:validate` (39 samples), canonical doctor
(six checks), and `git diff --check`. Evidence: `final-v8-*.log` and
`v8-freeze-before-matrix.log`. The focused browser gate also passes 47/47.

The V8 React probe `lens-translation-random-react-1790028510978` completes 14 stages and
six requests. Its scrolled screenshot retains the translated stationary header, sidebar,
body and native code; no source changes or layout rejections. Four matched real-wheel groups
have zero measured offsets. This preliminary probe is not a replacement for the final matrix.

The NetEase probe `lens-translation-random-netease-1790028395209` attributes the retained
advertisement label to a 30 × 17 absolutely positioned SPAN overlapping a native 1200 × 125
IFRAME. The rejected IDs match the inspected label. It is the approved native-media boundary,
not a missing ordinary headline; no site rule or weakening of pixel protection is added.

The V8 Hacker News preliminary probe `lens-translation-random-hackernews-1790028758672`
fails at manual refresh after a visually readable initial translation. The provider returned
HTTP 200 but malformed markup for `text-201`: `<m6>` was closed with `</m7>`, with another
`</m7>` and no opening `<m7>`. The affected batch is rejected as `TRANSLATION_RESPONSE_INVALID`.
The failure is preserved, not counted as a pass; no validation relaxation or automatic retry
is added. The final unchanged-build matrix must obtain its own full-page evidence.

## V7 preceding deterministic verification

The two new normal-whitespace indentation cases pass after their preserved RED failures.
The focused structure/readability/contracts suite passes **78/78**, repository units pass
**1,749/1,749** in 141 files, and the full browser replay passes **249/249** (8.1 minutes,
fresh typecheck/production build). Formatting, zero-warning lint, 17-asset bundle audit,
sandbox integration, 39-sample catalog, six doctor checks and diff checks pass. Logs use
`final-v7-*`; the whole-browser passing command is `final-v7-browser-replay.log`.
The renewed frozen live matrix is still required; preceding-version passes are not substituted.

Preliminary V7 Runoob source/translation screenshots in
`lens-translation-random-runoob-1790024577405` confirm restored NBSP indentation in the actual
code example, retained colored tag markers, native typography and readable prose. Initial and
manual-refresh stages completed with seven successful requests and no layout rejection. This is
a visual pass for that narrow probe, not a completed 13-page acceptance matrix.

Against the archived dirty baseline, V7 changes five production TypeScript modules, net **+472
lines** (lens lifecycle +13, DOM discovery/binding +171, structural layout +157, text constraints
+124, local text metadata +7). No new production file or parallel execution path was introduced
in this renderer-core task. Existing inherited changes remain separately preserved.

The first V7 whole-browser run encountered the same pre-existing history-fixture networking
failure: `page.goto('https://example.com/reply-history')` timed out before business assertions.
The trace is retained in `final-v7-reply-navigation-failure.tgz`; the earlier V6 occurrence is
also retained. The three history cases only require an ordinary tab, not external page content.
Their exact fixture URLs now receive local HTML through Playwright routing, as the neighboring
image-history case already does. All four history cases pass (`v7-reply-fixture-green.log`),
without changing product behavior or relaxing any business assertion. The failed first command
finished with 248 passes and one fixture timeout. The subsequent full command passes all 249;
the failed first command is not called a pass. The pre-existing Node NO_COLOR/FORCE_COLOR
environment warning remains; lint has zero warnings and no application warning was introduced.

## V7 live failures and V8 corrections (in progress)

The Wikipedia run `lens-translation-wikipedia-table-1790027613339` completed 16 diagnostic
stages with **zero requests and zero targets**, despite visible static prose and table cells.
It is a product failure, not an accepted dynamic boundary or a successful settled run. The
discovery walk exhausted its 10,000-node admission budget later in the article, then the global
exhaustion condition also prevented extraction of already visited, complete earlier blocks.

The generic unit case fails with an empty target list (`admitted-budget-red.log`). A real browser
fixture with visible prose/table cells followed by a large hidden subtree also fails on the V7
build (`admitted-budget-browser-red.log`, archived trace). The correction separates new-node
admission from reuse of inspected nodes within the same bounded pass. Complete admitted owners
survive exhaustion; a block interrupted mid-extraction is still excluded rather than sent as a
truncated paragraph. No budget increase, site rule or second discovery pass is added. The
56-case DOM unit suite passes; full browser/live verification still remains.

A separate read-only source-animation probe
`lens-translation-random-react-1790027818864` attributes the React header's scroll-time fallback
to actual `box-shadow` transitions on an otherwise stationary NAV (1440 × 64, x=0/y=0), not
text updates or geometric motion. Temporary event metadata was archived and removed. Static
header translation should not be lost for a decorative shadow; generic appearance and browser
regressions reproduce this before the correction.

The appearance unit and stationary-header browser cases both fail on V7
(`shadow-appearance-{unit,browser}-red.log`, archived browser trace), then pass on V8. The
47-case focused discovery/structure/motion/zoom suite passes, including the unchanged real
border-width and motion deferral assertions. Translation units pass 215/215; all repository
units pass **1,753/1,753** in 141 files. The 251-case whole-browser gate also passes.
Temporary animation instrumentation was removed and its pre/post diagnostic file hash agrees.

The preliminary V8 Wikipedia probe `lens-translation-wikipedia-table-1790028251778` has two
stages, five successful requests and 40 initially displayed targets. Reviewed source/translation
screenshots retain linked prose, notices, serif heading typography, colored table cells, column
alignment and untranslated code/brand names. There are no layout rejections. The large-page
budget notice correctly remains a bounded-discovery notice, not a claim that the entire long
article has been scanned. This probe is not the renewed final matrix.

Current V8 production delta against the archived dirty baseline: six existing TypeScript
modules, net **+477 lines** (lifecycle +13, discovery/binding +175, structural layout +157,
text constraints +124, local text metadata +7, animation classification +1). No new production
file, rendering engine, dependency, permission or request path is introduced in this task.

## Shared corrections and preserved failure evidence

| Owner              | Correction                                                                                                                                                                                                                     | Evidence                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text constraints   | Removed adaptive sizing from style copying; shared rows use intrinsic text widths, with explicit fixed bounds and native neighbors still protected. Full-width controls retain their width.                                    | `contracts-red.log`, `layout-final.log`; 96-case layout suite                                                                                       |
| Text constraints   | Auto-width floated section tabs must not be capped to the Chinese source's used width. Large photo cards are not compact text navigation.                                                                                      | `intrinsic-tab-red.log`, `intrinsic-tab-green.log`; `photo-cards-bare-caption-red.log`, `discovery-browser.log`                                     |
| Text constraints   | A one-line numbered paragraph with whitespace-preserving prose is not compact navigation. Reuse the existing line inspection to retain its source wrapping contract.                                                           | Wiki `lens-translation-lark-wiki-readable-1790009760760` and generic `numbered-prose-red.log`; full gates and matrix restarted for this correction. |
| Structure binding  | Retain safe shared inline ancestors, semantic styles, code decoration, links, graphics and explicit breaks. Neutral editor runs coalesce only if the entire path is visually neutral.                                          | Binding and editor-decoration RED/GREEN logs and trace archives                                                                                     |
| Structure binding  | Source owns literal line membership and indentation; model may reorder words inside a line without moving that line's structural whitespace.                                                                                   | `line-order-red.log`, `line-style-order-red.log`, `line-order-green.log` (30/30)                                                                    |
| DOM reconciliation | Registration/revealed-text discovery belongs to bounded reconciliation, not paint. Newly exposed cached entries yield through the existing scheduler. Local text-free outcomes distinguish results from actual retained paint. | Discovery unit RED; `discovery-unit.log` (211/211), `discovery-browser.log` (78/78)                                                                 |

Some intermediate corrections failed regression and were repaired, not erased from the record.
The first bounded-caption photo fixture did not reproduce the source defect and was not treated
as RED proof. A bare-caption floated-card fixture did reproduce displacement. The initial full
229-test browser pass predates the final floated-tab and literal-order corrections; it is not
used as the final candidate gate.

## Preceding v2 deterministic gates

Final logs use the `final-v2-` prefix under the candidate evidence directory. The final focused
layout gate is 110/110 (`numbered-prose-green.log`). Earlier `final-` logs describe the preceding
candidate, not the final live build.

| Command                              | Result                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `npm run format:check`               | Passed; final documentation check still to be repeated after reporting  |
| `npm run lint`                       | Passed                                                                  |
| `npm run test:run -- --maxWorkers=2` | 141 files, 1,749 tests passed                                           |
| `npm run test:e2e`                   | 233/233 passed, 7.8 minutes; includes fresh typecheck/production build. |
| `npm run audit:bundle`               | Passed, 17 assets                                                       |
| `npm run check:sandbox`              | Passed                                                                  |
| `npm run e2e:catalog:validate`       | Passed, 39 samples                                                      |
| Canonical environment doctor         | All six checks passed                                                   |
| `git diff --check`                   | Passed                                                                  |

No assertions were relaxed to accept missing text, font shrinking, overlapping icons, altered
source documents or missing media. One inherited test expected flattened SPAN nodes; its
assertion now requires original STRONG/EM semantics while retaining font/style/link checks.

## Preceding live evidence

The fixed 13-page and five-core-page repeat contract is in
[the acceptance specification](translation-renderer-contracts-acceptance-20260921.md).
Use the canonical authenticated profile, standalone target verification and existing native
lens diagnostic, serially on the frozen build. Evidence is private/ignored runtime data, not
WorkSession benchmark history. Every page requires screenshot and coverage attribution.

| Page / attempt              | Evidence directory under `e2e/.runtime/`            | Observation                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docx first attempt          | `lens-translation-lark-readable-1790008693895`      | Preserved failure: HTTP 503 / MODEL_TRANSIENT at refresh after zoom. Earlier body/table/scroll stages readable; not a full pass.                                                                                                                                                                                                 |
| Docx unchanged-build replay | `lens-translation-lark-readable-1790008847022`      | 14 stages complete, 8/8 requests successful, all targets rendered or unchanged-result, no layout rejections. Reviewed full body table, scroll, zoom, reopened lens; source text/style attribution requires the repeat's bounded metadata. Scroll probe has one ambiguous group and zero matches, so no numerical zero-lag claim. |
| Wiki first full run         | `lens-translation-lark-wiki-readable-1790009060534` | All 14 stages completed, but screenshot review rejected premature wrapping of a numbered paragraph. Source/copy probe attributes this to compact-row constraints, not model newlines. Not a visual pass.                                                                                                                         |
| Wiki first inline probe     | `lens-translation-lark-wiki-readable-1790009639645` | Preserved provider failure: HTTP 503, followed by outstanding-request cancellation during cleanup.                                                                                                                                                                                                                               |
| Wiki inline probe replay    | `lens-translation-lark-wiki-readable-1790009760760` | Reproduced premature wrapping. Copied flow was block/nowrap while the source paragraph and decorated runs used break-spaces; no model newlines.                                                                                                                                                                                  |
| Baidu prior candidate       | `lens-translation-baidu-readable-1790009182641`     | 14 stages, 5 successful requests, no source changes/rejections. Readable single-line news, native input preserved. Page has no vertical scroll, so zero scroll events is not scroll evidence. Must rerun after shared-core correction.                                                                                           |
| QQ prior candidate          | `lens-translation-qq-readable-1790009255640`        | 14 stages, 11 successful requests. Reviewed static news/photos/native video boundary; 32 scroll events, 13 matches, zero measured offsets/replacements. Source changes are live stock quotes. Must rerun after shared-core correction.                                                                                           |
| hao123 prior candidate      | `lens-translation-random-hao123-1790009389796`      | 14 stages, 13 successful requests. Static links/cards readable; live search ticker remains native. 32 scroll events, 58 matches, zero measured offsets. Stationary window includes a page-owned animated group retirement; not zero mutations. Must rerun after shared-core correction.                                          |

Preliminary Sina initial/manual-refresh evidence
`lens-translation-random-sina-1790007684073` shows restored Column/News/Video section labels and
visible original photos; it predates the literal-line-order correction and is not a final full
matrix pass.

## Preceding v3 validation

The v2 full/probe sequence is not final acceptance. V3 additionally corrects native button
alignment (16px RED reproduced), nested inline markers escaping their enclosing single-line
contract (65px RED vs a 24px line), intrinsic floated columns frozen to Chinese used widths,
and unconstrained float rows incorrectly turned into ellipsis. Each fix belongs to the existing
safe-copy or text-constraint owner. Temporary collision instrumentation was removed before
freezing `final-v3-candidate-sha256.txt`.

The auto-height padded-menu regression previously required every label to stay above an absolute
single-row coordinate, although the source has auto height and a clear-flow following paragraph.
Its test now requires full glyph visibility, two natural rows and clearance before following prose,
as well as unchanged source HTML and original font size. Fixed-height/clipped menu tests remain
unchanged. The failed intermediate trace is retained in `compact-owner-regression-artifacts.tgz`.

V3 gates: focused 52/52, full browser **238/238** (8.1 minutes), unit **1,749/1,749** in 141 files,
format, lint, fresh build/typecheck, 17-asset bundle audit, sandbox check, 39-sample catalog,
six doctor checks and diff check passed. Logs use `final-v3-`; the final documentation formatting
check remains due after writing this report. Full live matrix/repeats are still in progress.

Preserved invocation failures (not product passes): a nonexistent hao123 sample alias stopped
before execution; the verified catalog ID is `translation-random-hao123`. Wiki attempt
`lens-translation-lark-wiki-readable-1790014388207` timed out on an incorrect exact TOC label
before translation; the observed section label is used for the new invocation. Neither changes
product code, authentication or the page contract.

## Self-review

### V3 custom table pan failure and v4 correction

The full narrowed Wiki run `lens-translation-lark-wiki-readable-1790014540844` initially
translated the module table, but actual horizontal wheel panning moved the table by 168.5 CSS
pixels and removed its translations. The dynamic boundary count increased; no model or layout
error explained it. Cached reopen restored the table. This is a product defect, not the approved
dynamic-content exception: CSS displacement from a custom user scroller was being treated as
programmatic motion because it did not emit a native scroll event.

A generic wheel-driven table fixture, without document/site-specific selectors, reproduces the
loss after the gesture settles (`custom-pan-red.log`, `custom-pan-red-artifacts.tgz`). V4 routes
ordinary trusted wheel intent through the existing scroll lifecycle before page handlers run.
There is no new refresh loop, retry, site rule or source write. The fixture also checks cached
round-trip positioning, unchanged source text and no new requests, then verifies that unrelated
programmatic motion after the gesture still defers translation.

The preceding Docx attempt `lens-translation-lark-readable-1790014653864` failed separately with
HTTP 503 / `MODEL_TRANSIENT` before its first settled stage. This provider failure is retained;
it is not a pass or evidence of a rendering defect. V3 live checks on Baidu, QQ and NetEase are
diagnostic evidence only once the shared lifecycle changes; final acceptance must use V4.

### V4 validation and transparent foreground correction

V4 passed 1,749 unit tests and 239 browser tests, format, lint, build/typecheck, bundle audit,
sandbox, catalog and doctor. Logs are `final-v4-*`; production was frozen by
`final-v4-candidate-sha256.txt`. The full Wiki attempt
`lens-translation-lark-wiki-readable-1790015777054` preserved table translation on forward pan,
but reverse pan rejected the surrounding article with `native-overlap`. It is not a full pass.

Bounded temporary instrumentation reproduced the issue in
`lens-translation-lark-wiki-readable-1790016038903`: the conflicting surface was the transparent
sticky catalogue, **not the selection toolbar**. Its whole container extended to x=171.14 while
its painted child extended only to x=84.45. Foreground cutouts used actual children, but collision
validation used the empty parent rectangle. This inconsistent pair of geometry owners rejected
otherwise readable static prose. Instrumentation was removed after retaining the evidence.

Generic fixed and sticky transparent-shell fixtures both fail after the native branch moves
(`transparent-native-red.log`, archived traces). V5 shares the existing foreground paint facts
with collision validation. Complete scans may use actual child footprints; incomplete-budget or
uncertain-clipping scans keep the conservative original obstacle. Tests require neighboring prose
to remain translated while the native blue menu pixel and source text remain unchanged. No site
rule or removal of actual native-content protection is involved. V5 final gates are recorded below.

V5 focused regressions pass 58/58, including both transparent-shell RED cases and unchanged
source/native-blue-pixel assertions. A preliminary full Wiki probe
`lens-translation-lark-wiki-readable-1790016593890` completes 16 stages and 9 successful requests;
reviewed horizontal-return screenshot retains the body and table and has no layout rejections.
The preliminary Docx probe `lens-translation-lark-readable-1790016751714` retains its real tables
through a 236.5px horizontal pan/return and zoom, but its ninth request fails HTTP 503 on the
post-zoom refresh. Both probes run before the final full-browser gate completes and are not
counted as the final serial acceptance round. No product auto-retry was introduced.

## V5 gates and serial acceptance (not final: live defect found)

Candidate: `final-v5-candidate-sha256.txt` (216 source/build files); no source changes or rebuilds
are permitted during this serial round. The inherited dirty baseline remains archived separately.

All required V5 gates passed: 141 unit files / **1,749 tests**, **241 browser tests** (8.1 minutes,
fresh build/typecheck), formatting, lint, 17-asset bundle audit, sandbox check, 39-sample catalog,
six doctor checks and `git diff --check`. Logs use `final-v5-*`. Formatting/diff will be checked
again after the final report. No copied credentials, new dependencies, permissions or agents.

The 13-page serial matrix found a live defect. Prior version/probe passes are not substituted
for a final round; completion and the five-core-page repeat are still pending.

### Final serial round 1

Evidence directories below are under the ignored `e2e/.runtime/` directory. A pass is limited to
the fixed text-only contract and reviewed stages; native pixels and truly dynamic branches remain
unchanged. Standalone verification preceded each page on the canonical authenticated profile.

| Page      | Evidence directory                                  | Stages / requests | Visual and integrity result                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lark Wiki | `lens-translation-lark-wiki-readable-1790017089027` | 16 / 9            | Pass: module heading, numbered prose and real table remain translated after horizontal wheel pan (302.5→134 CSS px) and return. No layout rejection. Native animated catalogue and selection toolbar retained. Source 11 text-node changes: 10 same-parent-text hydration changes, one page-owned selection counter; zero source style changes.                                                                                                                                              |
| Lark Docx | `lens-translation-lark-readable-1790017317777`      | 16 / 9            | Pass: requirements and identity tables, body, watermark, horizontal pan/return (236.5 CSS px), zoom and refresh reviewed. No layout rejection. Source 17 changed runs all retain identical parent text; zero source style changes.                                                                                                                                                                                                                                                           |
| Baidu     | `lens-translation-baidu-readable-1790017457308`     | 14 / 5            | Pass: native-font navigation and two-column hot list, badges, original ellipsis, button alignment, logo and untouched search input reviewed. No layout rejection or source text/style changes. This page does not scroll in the test viewport; zero scroll events are not lag evidence.                                                                                                                                                                                                      |
| QQ        | `lens-translation-qq-readable-1790017527790`        | 14 / 10           | Pass: static headlines, photo captions and lists remain readable through scroll/zoom/refresh; photos and live video remain native. No layout rejection. Eleven source text changes are page-owned live stock quotes, zero styles. Scroll: 32 events, 13 matched groups, zero measured offsets/replacements.                                                                                                                                                                                  |
| hao123    | `lens-translation-random-hao123-1790017656765`      | 14 / 13           | Pass: static link grid, native-font columns and photo cards reviewed at normal and 125% zoom. Animated search/news/weather remain native. No layout rejection or source text changes; four source styles are homepage-button visibility, weather opacity/top and advertising sprite animation. Scroll: 32 events, 56 matched / two unmatched groups, zero measured offsets/replacements. Stationary window has one animated-group retirement, zero hidden frames; not a zero-mutation claim. |

Wiki scroll probe: 32 events, two matched groups and one unmatched group, zero measured offset or
replacement in the matched groups. Docx: 32 events, one ambiguous group and no matched group;
its visual scroll checks pass, but this is not numerical proof of zero lag. Both stationary
windows have zero hidden frames/replacements. Requests for the five pages above finished
successfully, contained no image input, and stayed within batch/context bounds. Other pages and
round 2 are still pending.

The remaining V5 executions preserve these observations:

| Page        | Evidence suffix / directory                        | Observation                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sina        | `lens-translation-random-sina-1790017797340`       | 14 stages / 18 successful requests; readable static columns/photos. A scroll-down recommendation block remains original with a dynamic boundary; explicit refresh/source attribution remains to be checked. |
| NetEase     | `lens-translation-random-netease-1790017951052`    | 14 stages / 25 successful requests; static lists readable, animated carousels native. One small native-overlap target at the advertisement needs identity confirmation.                                     |
| Runoob      | `lens-translation-random-runoob-1790018120956`     | **Fail:** initial real table is translated, but scroll-down rejects 30 targets with native-overlap and removes the table/prose. Zero tracked source changes. Not an approved dynamic exception.             |
| MDN         | `lens-translation-mdn-readable-1790018194850`      | 14 stages / 6 successful requests, zero target/layout rejections or tracked source changes; reviewed body, inline-code and native embedded editor boundary.                                                 |
| React       | `lens-translation-random-react-1790018269425`      | 14 stages / 7 successful requests; body/sidebar/code remain readable, scroll-responsive header deferred and recovered by refresh/reopen. Zero tracked source changes.                                       |
| GitHub      | `lens-translation-github-readable-1790018341675`   | 16 stages / 10 successful requests; app/file list readable, native relative-time components unchanged. One scroll-down native-overlap target and actual README remain for focused checking.                 |
| Wikipedia   | `lens-translation-wikipedia-table-1790018448434`   | 16 stages / 8 successful requests; reviewed actual merged table and horizontal return, readable text and native icons.                                                                                      |
| Hacker News | `lens-translation-random-hackernews-1790018568234` | Initial translation passed; manual refresh did not complete and the diagnostic failed. Preserve request/stream failure evidence; do not count partial execution as a pass.                                  |

V5 production was not modified during this serial matrix. After it ended, bounded temporary
collision instrumentation was added for diagnosis of the Runoob rejection; that probe build is
not an acceptance candidate and will be removed before the next frozen validation.

### V6 discovery and intrinsic-flow correction

The V5 Runoob failure has two independent generic causes. Its fixed sidebar is visible beneath
an offscreen ordinary ancestor only two pixels high; pruning that ancestor before discovery
omitted the sidebar on a first visit. Separately, both previous/next links are intrinsic floats,
but their copies were pinned to the Chinese used widths. The added line grew 24px and placed
real glyphs about two pixels inside the adjacent advertising frame. This was not harmless
padding and could not be fixed by relaxing the native collision threshold.

V6 keeps the same 10,000-distinct-node discovery walk, excludes offscreen leaves rather than
unknown subtrees, and removes the observed-cache-ancestry workaround. Opposing intrinsic
floats retain browser shrink-to-fit allocation; the existing budget for a genuinely fixed-width
neighbor remains. A separate generic fixture also reproduces false rejection when only empty
expanded flow padding reaches native media. The existing bounded ink check now permits a
native cutout in that case, still rejecting actual glyph, graphic or border overlap.

All three new cases were RED before correction and GREEN afterward. Evidence:
`escaped-island-native-padding-red.log`, `opposing-float-red.log`, corresponding trace archives,
and `escaped-float-padding-green.log` (3/3). Translation units pass 211/211; the focused browser
suite passes 71/71 (`v6-focused-*`). Temporary collision instrumentation was removed.
The full Runoob diagnostic `lens-translation-random-runoob-1790019722197` completes 16 stages
and seven requests without a rejected target. Reviewed initial/down/pan/zoom screenshots retain
the sidebar, real table, one-line previous/next links and native ad pixels. This preliminary run
is not substituted for the final frozen matrix.

Additional attribution: NetEase's remaining tiny overlap is the 30x17 advertising label over
a native iframe (`lens-translation-random-netease-1790018790357`), not an ordinary headline.
Sina's recommendation list really changes between initial and refresh screenshots, while
surrounding static lists remain translated (`lens-translation-random-sina-1790020159576`, ten
successful requests). This is the approved dynamic boundary; refresh does not freeze a still
rotating list. Its preceding probe's HTTP 503 is preserved separately.
GitHub README prose, inline links and code are visually correct in
`lens-translation-github-readable-1790020007390`; a subsequent app-list probe failed HTTP 503
on refresh (`lens-translation-github-readable-1790020074884`). Hacker News V5 refresh failed
`TRANSLATION_RESPONSE_INVALID`, not layout; neither failure counts as a pass.

### Scope/delta self-review (preceding V5)

Compared with the archived inherited tree (not HEAD), this turn changes five existing production
TypeScript modules: structure layout, DOM reconciliation, text constraints, text metadata and
lens lifecycle. Their net growth is 421 lines. The old three adaptive style-copy branches and
typography-only inline reconstruction were replaced, not retained as alternate paths. The added
code retains source shells/whitespace, owns intrinsic layout in one place, and makes discovery
and painted outcomes explicit. There is no new renderer, dependency, public protocol or retry
loop. Geometry, clipping, privacy, media protection and cache/generation guards were retained
because removing them would weaken correctness rather than remove redundancy.

A separate self-review found and reproduced the decorated-editor and reordered-literal-line
defects before correcting them. No subagents were used, as required by this task; this is not an
independent review. Requests still use at most 6,000 context characters, 32 text blocks/16,000
characters per batch, two concurrent requests and a 120-second timeout. Context is untrusted
reference data in input, not instructions. Native pixels, editable drafts and genuinely changed
or moving content retain their approved boundaries. Unexplained ordinary static omissions are
failures, not approved exceptions.

### V6 graphic ownership and detached cell context

Real GitHub comparison found a pure avatar subrow expanded from source spacing 14.40625px to
39px. Adaptive row constraints were running on a row with no translated text. The existing
changed-text ownership gate now also guards rows; no new site/layout heuristic was added.
`graphic-stack-confirmed-red.log` records 27.59375px drift, and `graphic-stack-green.log` passes.
The actual application comparison `lens-translation-github-readable-1790020592373` retains
overlapping source avatars, but still rejected one commit-description line.

That remaining failure was not merely an ellipsis footprint. The bounded probe
`lens-translation-github-readable-1790021014904` identifies a detached TD: original width
405.203125px, copy width 464.53125px, beside a native relative-time component. Outside its table,
anonymous auto layout expands the cell to clipped text's intrinsic width and loses vertical
alignment. A fixed single-cell table context now preserves the measured column and original
row alignment. The initial short-translation fixture did not reproduce this and is not RED
evidence. `detached-table-cell-red.log` and its trace archive reproduce the long-translation
failure; `detached-table-cell-green.log` passes coverage, clipping, alignment and source-invariance
assertions. Temporary instrumentation was removed before renewed validation.

The diagnostic source anchor now explicitly uses instant scrolling. Smooth CSS scrolling had
captured the source screenshot before reaching its requested anchor, invalidating comparisons;
this correction changes only evidence capture, not product behavior or authentication.

### V6 gate interruption

The first full browser gate timed out navigating the existing reply-history fixture to external
`example.com/reply-history`, before any history task or translation ran. Its trace records
`page.goto: net::ERR_ABORTED` after the 120-second navigation wait. Preserved evidence:
`final-v6-reply-navigation-failure.tgz` and `final-v6-browser.log`. This is an unrelated network
dependency of an unchanged test, not a renderer assertion. Do not suppress it or count that
full run as passing; repeat the unchanged frozen candidate and report both attempts.

The same run had 244/246 passing assertions. Its second failure was an obsolete intrinsic-tab
assertion: an auto-width floated label was required to fit inside its Chinese **used** width,
despite the approved source-intrinsic contract. The preserved screenshot shows a complete
Recommendations label inside its expanded border, separated from the second tab and following
prose. `final-v6-bordered-tab-failure.tgz` retains this result. The test now separately requires
intrinsic text to remain completely visible inside its copied border, and a declared fixed-width
variant to retain the original width. Both require no overlap with the next tab/following prose,
original font size and unchanged source HTML. This does not permit text to escape its own border.
Both tab variants pass (`bordered-tabs-contract.log`). The unchanged reply-history navigation
and complete task assertions pass in 4.8s during the full replay; final replay status is recorded
below once the remaining gate finishes.

### V6 final deterministic gates

The replay passes **247/247 browser tests** in 8.1 minutes, including fresh typecheck/build.
The final product's unit suite passes **1,749/1,749** in 141 files. Format, zero-warning lint,
17-asset bundle audit, sandbox integration, 39-sample catalog, all six doctor checks and
`git diff --check` pass. Logs: `final-v6-unit.log`, `final-v6-browser-replay.log`,
`final-v6-{format,lint}-replay.log`, and `final-v6-{audit,sandbox,catalog,doctor,diff}.log`.
The first failed gate remains separately preserved. Source/build identity checks pass after
the final build. Product code is frozen during the serial real-page matrix; only this report
and the execution ledger may change. No prior-version passes substitute for this round.

## V6 live acceptance (not final: supplemental whitespace defect found)

All rows below use the same `final-v6-candidate-sha256.txt` product, canonical authenticated
profile and standalone verification. Visual review is separate from diagnostic completion.
The first hao123 standalone verification failed its declared page-text readiness check before
translation (`v6-hao123-verify.log`); unchanged replay verification passed. That first attempt
is not a translation success. Product auto-retry was not added.

| Page      | Evidence directory under `e2e/.runtime/`            | Stages / successful requests | Reviewed result                                                                                                                                                              |
| --------- | --------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lark Wiki | `lens-translation-lark-wiki-readable-1790022718346` | 16 / 9                       | Pass: module heading, numbered prose and real table; 168.5px horizontal pan/return. Zero layout rejection. Interactive catalogue/selection UI can stay native until refresh. |
| Lark Docx | `lens-translation-lark-readable-1790022840499`      | 16 / 9                       | Pass: actual requirements/identity tables, prose, watermark, 236.5px horizontal pan/return and zoom. Zero layout rejection.                                                  |
| Baidu     | `lens-translation-baidu-readable-1790022981669`     | 14 / 5                       | Pass: navigation, two-column hot list, source font size/ellipsis, badges and button box. Native search input and logo unchanged. Zero layout rejection.                      |
| QQ        | `lens-translation-qq-readable-1790023076920`        | 14 / 11                      | Pass: static news, navigation, photo cards and lists at normal/125% zoom; native live video preserved. Zero layout rejection.                                                |
| hao123    | `lens-translation-random-hao123-1790023369393`      | 14 / 13                      | Pass after standalone readiness replay: readable static grid/navigation/news/photo cards; genuinely animated search/weather remains native. Zero layout rejection.           |

Source attribution: Wiki's 11 changed text nodes are ten same-parent-text hydration changes and
one page-owned selection counter; Docx's 17 are same-parent-text hydration. Both have zero style
changes. Baidu and QQ have zero tracked source text/style changes. hao123 has zero text changes;
three styles belong to its homepage-link visibility and two animated weather labels. These are
not described as zero page mutations. All five pages have zero stationary hidden frames and
zero replacement events; QQ/hao123 have page-owned observed mutations.

Scroll sampling: Wiki has 32 events / two matched groups / one unmatched; Docx has 32 events /
zero matches / one ambiguous group; QQ has 32 events / 13 matches; hao123 has 32 events /
57 matches / two unmatched. Matched samples have zero measured offsets/replacements. Docx's
visual pan/scroll checks are not numerical zero-lag proof, and Baidu has no vertical scroll range.
All requests above finished, contain zero image inputs and remain within context/batch limits.
Remaining eight pages and the five-core-page repeat are still pending.

### V6 supplemental code-example failure and V7 correction

The real-table Runoob run `lens-translation-random-runoob-1790023931983` completes 16 stages /
six successful requests, with no rejections. Its actual table, first-visit sidebar, opposing
navigation and adjacent native advertisement pass visual checks. However, the separate top/code
probe `lens-translation-random-runoob-1790024048981` (two stages / seven requests) fails visual
acceptance: natural-language lines within the non-PRE example lose their leading indentation.
Request completion and a ready state are not counted as a pass for this case.

The source-only probe `lens-translation-random-runoob-1790024236783` shows explicit BR elements,
normal white-space and alternating NBSP/ordinary spaces before colored inline tokens. These
spaces do not collapse in the browser; source metadata previously preserved edges only under
pre/pre-wrap/break-spaces CSS. Normalization consequently lost visible source indentation.
V7 preserves noncollapsing edge whitespace in the existing source-binding metadata, without
treating ordinary HTML formatting newlines as literal lines. No site selector or model/protocol
change is involved. Generic NBSP and em-space fixtures both fail before the correction:
`noncollapsing-indent-red.log` and `noncollapsing-indent-red-artifacts.tgz`. The first V7 build
caught a missing HTMLElement generic in the new test; it was corrected without product changes.
Full gates and the fixed final matrix must be renewed on V7; preceding V6 passes are not stitched
together with new-version results to claim complete acceptance.
