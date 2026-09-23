# Translation Renderer Contracts Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans in this session, without subagents or commits. Track steps with checkboxes. The user requested direct execution after the written design, so do not stop for another plan confirmation.

**Goal:** 修复共同的结构丢失、布局冲突及覆盖盲点，保持镜框只读文字翻译，并通过规定的实站和回归验证。

**Architecture:** 保留协议、请求、源身份和一个结构渲染器。文字绑定保留源结构，约束模块成为唯一布局适配入口，DOM 所有者负责有界发现及结果归因。使用当前分支的完整未提交候选，不用 HEAD 替代基线。

**Tech Stack:** Existing TypeScript, DOM/CSS Typed OM, Vitest, Playwright and canonical live diagnostics. No new dependency or permission.

**Spec:** [Renderer contracts](../docs/superpowers/specs/2026-09-21-translation-renderer-contracts-design.md).

## Global Constraints

- 保留镜框、源 DOM 只读、原字号、自然重排和现有模型协议；不改成阅读器。
- 图片/OCR 不恢复，静态媒体与原生控件像素必须保留；飞书草稿、水印保护保留。
- 动态源内容仅手动 Alt/Option+R；上下文总上限 6,000，2 并发，32 块/16,000 字符批次，120 秒超时。
- 不增加站点布局分支、依赖、权限、全页扫描、第二套状态机或新旧长期双路径。
- 不启动子代理、不提交、不推送。用户已要求直接实施，不再暂停请求流程确认。
- 所有 E2E 文件和证据遵守 e2e/AGENTS.md、RUNBOOK.md、EVALUATION_STANDARD.md。
- 验收按 [固定契约](translation-renderer-contracts-acceptance-20260921.md)，失败记录不覆盖。

## Review Focus

Continuation ruling (2026-09-22, user: “没完成继续搞啊”): close the two retained acceptance
gaps, without another architecture or protocol. A completed, valid response envelope may retain
individually validated blocks; malformed known blocks are omitted and marked failed by their
missing source IDs. Unknown/duplicate identities, malformed envelopes, interrupted streams and
zero valid blocks remain failures. Explicit Retry requests only failed blocks; Alt/Option+R
remains a full current-region refresh. No automatic retry or repaired model markup. Reproduce
the Wiki source-cell change in a no-lens control or capture attributable source mutation evidence;
do not waive it because later attempts pass. Rebuild/freeze and rerun final gates and live matrix.

1. 共享导航有足够空间时短译文完整显示；原本固定截断的长标题仍受保护。
2. 嵌套链接/行内代码标记重排不重复 padding、不丢背景；非 pre 预格式化缩进不抹掉。
3. 共享白底覆盖不能遮住静态图片，也不能让原文露出；动态媒体保留原生像素。
4. 变短译文暴露新内容后的补充发现必须结束且不漏目标，不进入无限重绘。
5. 刷新/缩放/滚动与延迟模型响应交错时，不重新使用失效绑定、几何或旧代次译文。

## Task 1: Freeze baseline and pin common defects

**Files:** create `e2e/tests/browser/translation-renderer-contracts.spec.ts`; reuse `e2e/tests/browser/helpers/translation-fixture.ts`; evidence in `e2e/.runtime/renderer-contracts-20260921-AG6WCY/`.

**Interfaces:** use `setupTranslationFixture(session, html, translations)` returning `page`, `panel`, `tabId`, `toggle`, `read`, `requests`. Native mirror inspection uses the existing extension `chrome.dom.openOrClosedShadowRoot`, only in tests.

- [x] Save inherited translation source/tests and bundle, git diff/status, and source hashes. Baseline path is the current dirty feature branch; do not erase existing changes or copy credentials.
- [x] Write a generic width-preserving control test:

```ts
const f = await setupTranslationFixture(
  session,
  '<main><button style="width:100%;height:48px;text-align:left">搜索文档</button></main>',
  { 搜索文档: 'Search documentation' },
);
const before = await f.page.locator('button').boundingBox();
await f.toggle();
await expect.poll(async () => (await f.read()).length).toBe(1);
// Read the copied button rectangle through the fixture's existing shadow access.
// The copied button must retain the source width within 1 CSS pixel, not shrink to its text.
```

- [x] Add source-derived fixtures for compact inline navigation with spare parent width, inline code background/padding, and non-pre pre-wrap text with a literal indentation prefix. Assert visible text, original font, and source immutability, not only textContent.
- [x] Run new tests on baseline with `npm run build` then `./node_modules/.bin/playwright test --config e2e/playwright.config.ts translation-renderer-contracts.spec.ts`. Expected: product assertions fail on sizing/style/whitespace; harness errors are not valid RED evidence.
- [x] Run `./node_modules/.bin/vitest run tests/translation --maxWorkers=2` and preserve current baseline. Expected: existing tests pass; unrelated failures are recorded, not hidden.

## Task 2: Make layout adaptation single-owner

**Files:** modify `src/page/translation/translation-text-constraints.ts`, `src/page/translation/translation-structure-layout.ts`; test the Task 1 fixtures plus existing structure/layout/relative-budget/portal/clamp tests.

**Interfaces:** retain `readTranslationTextConstraints(...)` and `applyTranslationTextConstraints(plan, copies, translated)`. Extend the internal plan to carry needed source adaptations; style copying only copies source declarations and inertness. No new public API.

- [x] Attribute RED to unconditional button sizing and duplicated compact-label rules; inspect source and copied widths before changing the policy.
- [x] Move translation-specific adaptation out of `style()`. Preserve declared width/flex relationships for controls; remove unconditional `width = 'fit-content'` for all buttons. Retain genuinely needed adaptations inside the existing plan/apply owner, backed by tests.
- [x] Resolve shared row space using source parent relationships and browser intrinsic widths, not original Chinese label width proportions. Preserve fixed cell/explicit ellipsis/native-neighbor limits. Apply adaptations once, then validate collisions without another layout heuristic.

```ts
// Common baseline remains the page's declared layout, not a tag-specific reset.
// Only the constraint owner may adapt widths/white-space/flex for translation.
const copy = copies.get(budget.source);
if (!(copy instanceof HTMLElement)) continue;
// Explicit constraints and measurable neighboring boundaries decide adaptation.
```

- [x] Run Task 1 width cases GREEN and existing layout tests; expected: original-size controls, readable short navigation, preserved bounded titles/icons and natural prose. Any lost protection gets its own reproducer before correction.

## Task 3: Preserve inline structure and whitespace

**Files:** modify `src/page/translation/translation-text-layout.ts`, `translation-dom.ts`, `translation-structure-layout.ts`; if needed create `translation-text-binding.ts` only for the stable shared binding operation. Tests: Task 1 browser cases and `tests/translation/translation-dom.test.ts`, existing inline/structure/readable cases.

**Interfaces:** `TranslationTextSource` retains `key/owner/nodes/text/plain/markers/lines`; add local optional binding metadata only where required. Existing `<mN>` protocol and validation remain unchanged. `group.copies` continues mapping source nodes to the live translated counterpart for revealed text.

- [x] Add RED assertions for nested inline background/border/padding with model marker reorder, neighboring links and explicit BR. Model inputs are deterministic responses at the existing provider boundary; never mock the renderer.
- [x] Preserve safe source inline shells while substituting text, including structural paths necessary for decoration. Do not flatten to typography-only spans or duplicate shared decorations. Link URLs remain source-owned; never interpret model HTML.
- [x] Separate normalized cache comparison from raw display whitespace. Preserve literal indentation/newlines under whitespace-preserving CSS through source-owned boundaries; keep existing pre exclusion and allow ordinary pre-wrap prose.

```ts
// Existing safe creation/style-copy machinery supplies shells and links.
// Validate before touching the live reading surface.
validateTranslationMarkup(entry.text, value);
const segments = translationSegments(value);
// Bind segments to source structure; text is assigned as textContent/Text nodes only.
```

- [x] Run RED cases GREEN, source-privacy/markup tests and related browser tests. Expected: correct semantic text/link/style relationships, no writable content, no doubled spaces/indent loss, unchanged source.

## Task 4: Explicit discovery, outcomes and safe composition

**Files:** modify `translation-dom.ts`, `translation-structure-layout.ts`, `mount-translation-lens.ts`; tests: followup/reopen/refresh/streaming/paint/native-visibility plus new generic media and coverage cases; extend `e2e/diagnostics/translation-lens.ts` only for necessary bounded attribution.

**Interfaces:** layout reports `errors/rejections` and revealed candidates; DOM owns their reconciliation and source identity. Reuse existing generation/deferred/cache state. No network telemetry or private source text in diagnostic counters.

- [x] Reproduce the Sina white-photo failure using source/copy/native ownership inspection, then add a generic fixture with the actual responsible composition relationship. Expected RED: media pixels differ while source still exists.
- [x] Correct the demonstrated ownership error: every painted static graphic is retained in its safe copy or protected as native; backing cannot silently cover unowned pixels. Keep source-glyph erasure, watermarks and real native foreground protection.
- [x] Add a shorter-translation reveal test and delayed refresh/scroll case. Assert all independently named expected static targets appear and that requests settle without repeats. Add missing/budget/rejection attribution assertions that cannot pass solely from ready state.
- [x] Move target registration out of `paint()` into the existing DOM reconciliation owner. Carry distinct target outcomes and traversal boundary reasons; prevent no-progress rediscovery and stale source/copy references.

```ts
// Layout returns facts; DOM consumes them under the same bounded observation.
// Newly revealed nodes go through existing collect/register/privacy checks.
const newlyVisible = this.layout.revealed(area, known);
// Only new eligible identities may enter visible/request sets; no recursive render loop.
```

- [x] Run relevant deterministic tests GREEN. Expected: no static omissions masked by successful requests, no stale preview/backing, unchanged dynamic/manual-refresh boundary and original pixels.

## Task 5: Full validation, live correction and self-review

**Files:** update `src/translation/README.md`; create `e2e/translation-renderer-contracts-validation-20260921.md`; retain plan ledger with rulings and command evidence.

**Interfaces:** consume final production build and fixed acceptance matrix, reuse canonical verify/diagnostic flow and Profile. No alternate authentication or product-only test hook.

- [x] Run narrow formatting, then `npm run format:check`, `npm run lint`, `npm run test:run -- --maxWorkers=2`, `npm run test:e2e`, `npm run audit:bundle`, `npm run check:sandbox`, `npm run e2e:catalog:validate`, `git diff --check`. Expected: all required checks pass without newly introduced warnings/errors.
- [x] Run doctor and standalone verification according to RUNBOOK, freeze source/bundle hashes, and pass the 13-page serial matrix. V20's 13 first rounds pass separate image review: 195 stages / 140 requests. All 216 snapshot source/dist hashes and 199 root source hashes match. V19 remains a retained failed candidate: its separate QQ repeat review found static links clipped in fixed-height wrapping rows. The earlier first-round review missed them; the V20 generic correction and actual-page preflights close that defect. See validation record for boundaries and proof.
- [x] Classify and preserve any material live failure, reproduce in a generic RED test, fix the owner, rebuild and repeat relevant frozen scenarios. Do not add site-specific layout rules or discard earlier failures.
- [x] After the first full matrix passes, repeat the five core pages exactly as the acceptance contract specifies. All five repeats and both code/README supplements complete, with screenshot review: final total 20 rounds / 275 stages / 201 requests. Three completed rounds need one explicit format Retry each; four additional failed attempts remain separately classified. Review source-to-copy coverage and real scroll samples, not only request counts.
- [x] Perform a separate whole-change self-review (subagents prohibited), inspect Review Focus, remove only replaced responsibilities, update README and validation record. Same-agent review is not independent review. Leave changes uncommitted and retain ledger/evidence because no commit history represents them.

Final V20 closure and preserved failures are in the [validation report](translation-renderer-contracts-validation-20260921.md).
The continuations below are chronological evidence, not the current task status. They must not be
combined with V20 to claim a larger successful matrix.

V17 continuation: V16 gates pass (1,758 units / 268 browser cases), but horizontal-back drops Wiki
static translations through an oversized transparent native descendant box. Temporary geometry-only
instrumentation identifies the existing foreground owner; removed/restored before the generic RED
test. Independent native footprints within pinned owners pass 17 related browser regressions.
The separate upstream overload remains a failed attempt. The first preflight still fails after
complete footprint scans: the settled native geometry is never observed after CSS animation ends.
A second generic RED case confirms this; existing lifecycle listeners now reconcile end/cancel
without clearing the dynamic boundary or re-requesting it. Final validation follows; Task 5 is open.
The next preflight identifies a separate cutout condition introduced by footprint extension:
pinned descendants must protect source structural overflow even outside the main flow box.
A sliced wide-table plus native-surface case RED reproduces it; the absolute-media overlap guard
is now restricted to absolute media, preserving existing pinned protection. No gate is waived.

V16 continuation: V15 gates pass (1,758 units / 262 browser cases) but initial Wiki drops static
translations after an animated tooltip is removed. Four generic RED cases reproduce the shared
parent boundary error; the corrected owner transfers only replacement branches and allows visible
content inside zero-height portals to refresh. Focused browser regression passes 26/26 and narrow
units 220/220. The equivalent split-mutation guard adds two RED/GREEN cases; all six boundary
cases pass. Final gates/matrix are running.
The V15 queue stopped after five completed pages, with evidence preserved; Task 5 remains open.

V15 continuation: the V14 repeat exposes native dropdown paint-through, and the README recovery
exposes a tsx browser-action serialization failure. Both have preserved RED cases and focused
GREEN regressions. The live open-popup preflight passes; final gates/matrix/repeats will be rerun
on the corrected candidate. Task 5 remains open.

V14 historical continuation: 1,757 unit / 260 browser cases and required gates pass. All 13 fresh first rounds
complete on the frozen V14 candidate: 194 stages / 136 completed text-only requests, no format
retry; screenshots reviewed. Source-cell attribution is closed by the exact-cell no-lens scroll
round trip and default-world DOM mutation evidence. The repeat/supplement failures above prevent
completion; their evidence is not discarded.

Historical V13 checkpoint (2026-09-22): doctor/standalone setup, all 13 full rounds, the five repeat rounds, two
content supplements and self-review have been executed on the unchanged V13 source/build.
The unchecked acceptance items remain intentionally open, rather than implying unrun scripts:
two retained model-marker failures expose batch-wide failure propagation, and one Wiki source-cell
change is not reproduced by the no-lens hydration control. The latest architecture question is
answered from those results; valid-output rendering passes do not establish all-attempt reliability
or resolve that source-safety observation. See the validation report's current assessment.

## Self-review

All spec responsibilities map to Tasks 2–4; original safety and flow preservation map to every task plus Task 5. Spec acceptance is not satisfied by merely implementing these tasks. Interface changes stay internal, and no task may remove a safety boundary to manufacture a visual pass.
