# Text translation repair — 2026-09-21

Scope: repair ordinary text omitted in a readonly translation lens, preserve readable single-line
toolbar labels, and classify retryable upstream failures correctly. The source document must not be
edited. Image/OCR translation, automatic dynamic-region retries, site-specific rules, and unrelated
refactors are out of scope. Changes remain uncommitted.

## Execution and acceptance

1. Preserve the current candidate and the earlier cleanup baseline. Reproduce each product defect
   in a deterministic test before changing its owner.
2. Correct only the animation/native geometry boundary, compact-label layout, or upstream error parser shown to be
   defective. Keep moving/changing text native until explicit Alt/Option+R refresh.
3. Run targeted regressions, all unit/browser tests, and repository gates on one candidate build.
4. Run canonical-profile live checks serially on Wiki, Docx, QQ, Baidu, and hao123. Inspect translated
   heading, prose, tables, and toolbar spacing; a settled/unsupported state alone is not a pass.
5. Record remaining service/access limitations separately from product correctness. Do not infer
   causation from a different screenshot, selection, scroll, or page layout state.

## Preserved evidence / investigation

- `e2e/.runtime/translation-cleanup-baseline.tar`: pre-cleanup source snapshot (prior turn).
- `e2e/.runtime/translation-repair-baseline.tar`: source before these production repairs.
- `translation-repair-provider-red.log`: 2 new nested upstream error tests fail; both are incorrectly
  classified as non-retryable INVALID_RESPONSE. Existing 47 provider tests pass.
- `translation-repair-highlight-red.log`: ordinary heading with a background/color keyframe remains
  native (unsupported) while its neighboring prose translates. This is a real rendering-boundary
  defect, distinct from moving text.
- `translation-repair-toolbar-red.log`: floating toolbar + text selection + two manual refreshes
  pass on the unchanged build. This hypothesis alone does not reproduce the earlier Wiki failure.
- `lens-translation-lark-wiki-readable-1789971689146`: unchanged-build live initial/manual refresh
  both settle (51/52 translated entries). This does not prove the intermittent Wiki problem fixed.

The before/after cleanup Wiki runs previously differed in selection/editor-toolbar state. Their
visual failure is retained in `translation-cleanup-validation-20260921.md`; cleanup causation has
not been established by a frozen pre-cleanup A/B run. The confirmed defects below were reproduced
against the retained pre-repair candidate; reviewing the cleanup diff alone is not a causal A/B
comparison, and no claim is made that the earlier repaint cleanup could never affect timing.

## Confirmed causes and bounded repairs

- The missing `3.1 模块划分` heading had a separate, background-color-only TOC highlight mask.
  Collection treated all keyframe animation as live, so a text-free color decoration blocked
  the ordinary heading. `lens-translation-lark-wiki-readable-1789972088142` preserves animation
  metadata; `translation-repair-mask-red.log` reproduces the same generic failure. Only color-only
  properties are now exempt; movement and opacity remain deferred.
- Selection/manual refresh is a separate geometry defect. In
  `lens-translation-lark-wiki-readable-1789973578352`, the model completed all requests, but render
  rejected a 30-member document flow against the editing toolbar's old animation position.
  The native boundary still started at y=427.976 while its current foreground cutout started at
  y=418.835. The stale strip was mistaken for unsafe overlap. Temporary bounded diagnostics are
  retained in that ignored evidence file, not in production. `translation-repair-stale-toolbar-red.log`
  and its screenshot/trace directory reproduce a toolbar settling while a response is pending.
  The renderer now remeasures known native elements before comparing collisions, without adding
  a page walk, recovery loop, new model request or site rule.
- QQ's compact utility row mixes plain labels, links, nested labels, icon-only cells and badges.
  Anchor-only classification missed that structure. The generic compact flex-row rule now keeps
  text labels single-line at native font size, preserving icons/badges outside text-only ellipsis.
  A fixture measurement bug also counted ellipsized glyphs outside the text wrapper itself; the
  helper now includes that wrapper in the clipping chain, without changing the expected spacing.
  The first repaired live run (`lens-translation-qq-readable-1789974847857`) still exposed crowded
  labels before manual refresh: an animated download cell split its neighbors into separate
  islands, bypassing the shared row constraint. `translation-repair-native-toolbar-red.log`
  reproduces that remaining failure. Detached compact nowrap flex labels now keep their source
  slots with text-only ellipsis; the animated cell remains native. The first full browser run also
  caught the existing nested-inline-anchor contract being bypassed (182 pass / 1 fail). The shared
  label constraint now retains that block/ellipsis contract; no assertion was weakened.
- Provider `error` events may place retryable codes under `error.code`. The translator previously
  accepted only top-level `code`. Nested overload/rate-limit tests failed before the bounded parser
  repair; both shapes now reuse the existing safe classification. Explicit Alt/Option+R retries;
  external stream termination/overload is not claimed to be eliminated.

## Results

Candidate 1: 1,723 unit tests passed; 55 targeted browser tests passed, but the full browser suite
had the one anchor regression above and the live QQ initial view remained crowded. It is not an
all-passing candidate. On real Wiki, initial and selected-text manual refresh both kept 54
translated entries, including the heading, body and table; six HTTP 200 requests completed.
Evidence: `lens-translation-lark-wiki-readable-1789974452820`.

Candidate 2: the animated-toolbar and nested-anchor corrections pass their three targeted tests
(`translation-repair-candidate2-targeted.log`). All 1,723 unit tests in 139 files and all 184 browser
tests passed. The full browser run includes typecheck and the production build. The five-site
live matrix completed on that frozen build, but visual review found the hao123 defect below.

Frozen bundles:

- `dist/assets/page-content.iife.ts-DrQrLWag.js`:
  `dc086432dbd5bd8259c435cbc959c4e48ae8444e0404d516b13d02bfdad60cc9`
- `dist/assets/background.ts-DW_uUSIH.js`:
  `00645cf1d65e2fd5d9135f16bf62a536fbe20b9b17dd9ba8021bd06db8914f92`

Candidate 2 deterministic evidence:

- `translation-repair-candidate2-unit.log`: `npm run test:run -- --maxWorkers=2`, 1,723 passed.
- `translation-repair-candidate2-browser.log`: `env -u NO_COLOR npm run test:e2e -- --output
e2e/.runtime/translation-repair-candidate2-browser`, 184 passed.
- Format, lint, bundle audit, sandbox check, catalog validation and the environment doctor passed.
  The optional shell-token `check:codex` check was not run because the shell had no token; no
  authentication was extracted. The native checks use the canonical authenticated Profile.

Candidate 2 native diagnostics (not WorkSession benchmark passes):

- QQ, `lens-translation-qq-readable-1789975609487`: 14/14 stages settled and 10/10 requests finished
  with HTTP 200. Initial top-row labels now stay separated and ellipsize in their own slots at the
  source font size; icons remain visible. The animated download label stays native until manual
  refresh. The continuous-scroll probe matched 13/13 groups over 32 scroll events with no measured
  offset/replacement. Five source text changes were observed on this dynamic page; that observation
  alone cannot attribute source writes to either the site or the extension. Readonly behavior is
  independently asserted by deterministic source-DOM checks. No global no-flicker or full-page
  coverage guarantee is inferred from this single run.
- Lark Wiki, `lens-translation-lark-wiki-readable-1789976031826`: 14/14 stages settled and 10/10
  HTTP 200 requests completed. `initial.png`, `manual-refresh.png` and `scroll-down.png` were
  inspected: `3.1 Module Breakdown`, surrounding prose and table cells remain translated even
  with the selection/editor toolbar open; initial and manual refresh both retain 52 translated
  entries. The closing screenshot shows the native Chinese document. The 125% browser-zoom stage
  with a small moved lens fell back to native text (0 translated entries); after zoom restoration,
  explicit Alt+R recovered 15 entries and a ready state. This is recorded as a manual-recovery
  limitation, **not** an automatic-zoom-recovery pass or proof that all zoom combinations work.
  Only 2/3 groups matched the continuous-scroll probe; no offset was measured in the two matched
  groups, so no statement is made about the unmatched group. 8 disconnected nodes and 11 source
  text changes were observed and do not by themselves establish mutation attribution.
- Lark Docx, `lens-translation-lark-readable-1789976342784`: 14/14 stages settled and 9/9 HTTP 200
  requests completed. Initial/manual screenshots preserve readable body, headings and table
  columns with naturally growing rows; there is no table-wide fallback. The continuous-scroll
  probe matched 2/2 groups with no measured offset/replacement. The narrow moved lens retained
  translated text through 125% zoom, restoration and manual refresh. Source-DOM observation also
  recorded native page updates (1 disconnected node, 19 text changes), not a zero-mutation claim.
- Baidu, `lens-translation-baidu-readable-1789976589666`: 14/14 stages settled and 5/5 HTTP 200
  requests completed. Navigation and hot-list screenshots retain readable fonts, separated rows,
  native icons and single-line ellipsis. Input content and image lettering stay native by design.
  The sampled 152 source entries had no observed text/style/disconnection changes. This page did
  not actually scroll (0 scroll events), so its matching probe is not scrolling-stability evidence.
- hao123, `lens-translation-random-hao123-1789976812416`: 14/14 stages settled and 15/15 HTTP 200
  requests completed. Many grid/news entries were readable, but the ordinary news-link row stayed
  Chinese even after explicit refresh. This is a **coverage failure**, not an accepted dynamic
  region. Some other native grid cells are actual iframes. The small moved-lens zoom stages also
  fell back to native; explicit refresh recovered 18 entries. The scroll probe matched 56/57
  groups with no measured offset/replacement in those matched groups; no claim covers the unmatched
  group. Source observations recorded three style changes, not a zero-mutation result.

## Candidate 3: visible native boundaries

- Source-only inspection, `lens-translation-random-hao123-1789977119313`, showed that all 14 ordinary
  news links initially fit the same row. The padded/inline-row fixture passed unchanged
  (`translation-repair-padded-menu-red.log`, `translation-repair-padded-wrapper-red.log`), so
  wrapping was not established as the cause and no menu-specific layout fix was added.
- `lens-translation-random-hao123-1789977724152` adds bounded ID/character-count attribution:
  `hao123推荐` was requested twice, returned with 22 characters and zero Han characters both times,
  and was absent from the painted text. This locates the failure after the model response.
- Temporary layout tracing in `lens-translation-random-hao123-1789977983043` identifies the false
  collision. The source and translated menu both occupy y=221..251, with no growth or peer
  collision. A native animated DIV occupies y=83..253.13, but its parent actually clips it to the
  short news-ticker port above the menu. The collision rule incorrectly protected the invisible
  part too. The temporary production trace was removed after preserving that evidence.
- The synthetic clipped animated-track and clipped-iframe cases fail before the repair
  (`translation-repair-clipped-native-red2.log`: 2 failed / 2 passed). Truly overlapping native
  media and unsupported clipping shapes remain protected. The first fixture run also had an
  incorrectly sized unknown-clip guard; its evidence is retained, and the guard was corrected to
  actually overlap the menu before rerunning the unchanged candidate.
- The renderer now reuses its existing ancestor-clipping helper to intersect current native bounds
  with supported visible scrollports. Unknown shapes keep conservative bounds. No site branch,
  model request, new layout mode or automatic dynamic retry was added.
- Candidate 3 passed 1,723 unit tests and 76 targeted browser tests. The frozen full browser run
  was interrupted after additional native-positioning guards exposed the regression below; it is
  not recorded as a complete pass. Format/lint (after removing a diagnostic non-null assertion),
  bundle audit, sandbox, catalog and doctor checks passed.
- Native hao123, `lens-translation-random-hao123-1789978570289`: all 14 stages settled. The ordinary
  news-link row is now translated in the inspected initial screenshot, at the original font size
  with separate ellipsized labels. The small moved-lens zoom limitation still requires manual
  refresh. These observations do not establish that candidate 3 is safe for all native controls.

## Candidate 4: preserve escaped positioned controls

- Review added two deterministic guards for visible absolute/fixed native media escaping a static
  overflow ancestor. Both original assertions failed on candidate 3
  (`translation-repair-positioned-native-guard.log`), but this does not establish two rendering
  defects: the absolute case exposed native pixels being covered, while the fixed case already
  retained a foreground cutout. Requiring an unsupported status and no mounted translation was
  too implementation-specific for the fixed case. The absolute case is a newly introduced
  regression, not a pre-existing page failure. The candidate 3 full run was stopped explicitly
  and its evidence retained.
- [CSS overflow rules](https://www.w3.org/TR/CSS22/visufx.html#overflow-clipping) distinguish the
  containing block from an arbitrary ancestor. Instead of adding a second containing-block engine,
  native bounds are now conservative above any out-of-flow ancestor: supported normal-flow clips
  below that boundary still apply, but an unproven clip cannot remove protection from live media.
  Existing strict clipping callers keep their earlier policy. This closes the proven regression
  without adding site-specific behavior; unusual out-of-flow cases may retain a native fallback.
- Candidate 4 passed 1,723 unit tests. Its targeted run had 57 passes and the one fixed-case
  assertion failure above. The two native-positioning guards now compare the protected region's
  actual before/after screenshot pixels instead of requiring a particular internal fallback;
  both pass (`translation-repair-positioned-native-pixel-green.log`). No candidate 3 result is
  relabeled as a pass for this build. Candidate 4 has not completed a fresh full browser suite or
  the live cross-site matrix.

## Consolidation checkpoint

The user requested common-cause repair rather than further case-by-case patches. Product edits and
the remaining candidate validation are paused for a rendering-core design review; existing changes
and failed evidence are retained. The confirmed shared issues are inconsistent visible/native
geometry, animation-versus-content classification, stale geometry across asynchronous results, and
layout constraints that interact across independently copied islands. A successful request or a
settled lens is not evidence of translated coverage, and internal fallback status alone is not
evidence that native pixels are protected. The next design must preserve the text-only readonly
lens and explicit dynamic refresh, with no site-specific layout branches.

## Review and remaining boundaries

- Reviewed the production diff against `translation-repair-baseline.tar`, alongside the affected
  deterministic tests and renderer/provider ownership. No subagent was used. The fixes remain
  in the existing animation, layout and provider owners; no dependency, site selector, OCR path,
  polling/retry loop or protocol change was added.
- The generic rules preserve native moving content, live media and writable inputs. Explicit
  refresh remains the recovery mechanism for deferred content; model-service availability is
  external and the new error classification does not promise that requests can never fail.
- Earlier failed runs and candidate 1 are retained. The first unconstrained unit run experienced
  local worker contention and was stopped; the bounded-worker reruns passed. A diagnostic browser
  launch failure before sample execution was retained and environment doctor/verification rerun.
  These are not counted as product passes. Independent disposable-profile browser tests overlapped
  initial native correctness runs; no latency/performance comparison is claimed.
- Changes are uncommitted and unpushed. The build needs an unpacked-extension reload and existing
  page refresh in the user's browser; the diagnostic Profile is separate from that browser.
