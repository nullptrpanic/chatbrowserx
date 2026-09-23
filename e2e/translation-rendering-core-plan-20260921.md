# Translation Rendering Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute natively in the current session; the user's AGENTS.md does not authorize subagents or commits.

**Goal:** 用共同的可见性、排版预算与更新规则修复镜框文字漏翻、错排和滚动残影，删除被完整替代的重复补丁。

**Architecture:** 保留一个只读结构渲染器、已有源身份/译文缓存和请求调度。增加局部几何读取模块，统一页面事实；将重复的紧凑文字约束收敛为一个源布局预算模块。DOM、上下文和结构渲染消费共同事实，但分别保留隐私筛选、参考上下文和原生保护策略。

**Tech Stack:** Existing TypeScript, Chromium DOM/CSS Typed OM, Vitest, Playwright and the current extension/live-diagnostic harness; no new dependencies.

**Spec:** [2026-09-21-translation-rendering-core-design.md](../docs/superpowers/specs/2026-09-21-translation-rendering-core-design.md)

**Status:** 本轮共性修复和冻结版本验证已完成；hao123 原生/动态页头的保留原文边界未算作零遗漏通过，详见 [验证记录](translation-rendering-core-validation-20260921.md)。因包含可复用 E2E 测试与执行说明，依仓库要求存放于根 `e2e/`。

## Global Constraints

- 保留可移动、缩放的镜框，只在框内显示译文；框外与原文不被修改或隐藏。
- 仅翻译 DOM 文字。图片、OCR、白板像素、截图翻译、Debugger 与共享授权路径不恢复。
- 正文、列表、表格可在框内自然重排，不要求框内外逐行对齐。紧凑标题和导航保留原字号，允许在既有行数预算内省略，不逐字符折行、不压缩字号来挤入原文槽位。
- 真正变化或移动的已观察文字保持原文，直到 Alt/Option+R；不恢复自动动态重试循环。
- 不修改输入值、草稿、飞书文档或协作状态。已有飞书只读识别和水印保护不作为冗余删除。
- 保留上下文预算、模型协议、标记校验、并发、超时、缓存、取消、Esc 与重开行为。
- 不增加依赖、权限、站点排版适配、第二套渲染器或新配置项。不提交或推送本轮改动。
- 每次删除旧分支须给出新责任归属和对应回归。保留原有测试和失败证据，不通过增大扫描/请求预算满足验收。
- 串行执行共享认证 Profile 的真实页面检查；冻结产品构建后不边测试边改产品或重建。环境与认证遵守 [RUNBOOK.md](RUNBOOK.md)，结果判断遵守 [EVALUATION_STANDARD.md](EVALUATION_STANDARD.md)。

## Review Focus

1. **正常裁剪与 absolute/fixed 逃逸的组合**：隐藏轨道不挡静态字，真正可见的控件像素不能被覆盖。由 Task 1/2 的几何与原生媒体测试固定。
2. **零尺寸包装与部分可见表格**：overflow-visible 的零高壳仍可有可见后代；空裁剪才完全不可见；横向平移后的表格不失去首列。由 Task 1/2 固定。
3. **高亮、脚本位置变化和浏览器缩放的组合**：颜色变化不漏翻；真正移动仍需手动刷新；只缩放不能把静态正文永久判成动态。由 Task 4 固定。
4. **模型延迟期间工具条移动及重复刷新**：使用当前几何，旧代次结果不显示；原文已变时旧译文不回填。由 Task 2/4 固定。
5. **紧凑行混合图标、嵌套链接、普通标签与正文**：文字预算一致，但正文不被误压成单行；动态项分离后静态项不借用相邻槽位。由 Task 3 固定。

---

## Files and Ownership

| File                                                           | Responsibility after replacement                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/page/translation/translation-geometry.ts` (new)           | 一次同步批次的源事实、裁剪关系与明确的可见/隐藏/不确定结果；没有模型、会话或 DOM 写入 |
| `src/page/translation/translation-clipping.ts`                 | 保留已有矩形裁剪声明解析，供统一几何使用；不重复祖先遍历                              |
| `src/page/translation/translation-dom.ts`                      | 目标采集、源身份、缓存、延后区域、文字结果；消费几何而不再自建裁剪链                  |
| `src/page/translation/translation-context.ts`                  | 有界、源定位的参考上下文；消费基础隐藏事实，保留语义与隐私过滤                        |
| `src/page/translation/translation-text-constraints.ts` (new)   | 源布局预算及统一文字约束应用；从结构布局中迁移并收敛已有重复逻辑                      |
| `src/page/translation/translation-structure-layout.ts`         | 安全布局组、惰性副本、原生重排、前景保护、原子提交；几何与文字预算由共同模块提供      |
| `src/page/translation/translation-animation.ts`                | CSS 动画及脚本属性变化的统一分类，不持有第二套动态集合                                |
| `src/page/translation/mount-translation-lens.ts`               | 继续持有调度、刷新代次和取消；仅按新的失效分类协调，不重写协议                        |
| `e2e/tests/browser/translation-*.spec.ts` and existing fixture | 通用行为测试；单独证明实际绘制、原生像素保护及只读性                                  |
| `e2e/diagnostics/translation-lens.ts`                          | 复用现有实站检查，新增脱敏归因字段，不复制认证或另建运行路径                          |

## Task 1: Batch-local Geometry and Explicit Clipping Results

**Files:**

- Create: `src/page/translation/translation-geometry.ts`
- Create: `tests/translation/translation-geometry.test.ts`
- Modify: `src/page/translation/translation-clipping.ts` only if a measured-box argument is needed to prevent rereading geometry
- Test: `tests/translation/translation-clipping.test.ts`

**Interfaces:**

Consumes `TranslationRect`, `intersectRegions` and `translationClipBox`. Produces the internal types and batch factory below; the factory is called anew for every synchronous source-read/render/reposition batch, never retained across requests or `await`:

```ts
export type TranslationClipResult =
  | { kind: 'visible'; rect: TranslationRect }
  | { kind: 'hidden'; reason: 'style' | 'empty-clip' }
  | {
      kind: 'uncertain';
      rect: TranslationRect;
      reason: 'clip-shape' | 'clip-relationship';
    };

export interface TranslationElementFacts {
  box: TranslationRect;
  contentBox: TranslationRect;
  zoom: number;
  display: string;
  position: string;
  visibility: string;
  opacity: string;
  contentVisibility: string;
  overflowX: string;
  overflowY: string;
  contain: string;
  transform: string;
  filter: string;
  clip: TranslationClipResult | undefined;
}

export interface TranslationGeometry {
  facts(element: Element): Readonly<TranslationElementFacts>;
  clip(
    rect: TranslationRect,
    node: Node,
    options?: { boundary?: Element | null; includeSelf?: boolean },
  ): TranslationClipResult;
}

export function createTranslationGeometry(view: Window): TranslationGeometry;
```

`contentBox` is the overflow scrollport's client rectangle in viewport CSS pixels, not a text layout budget. Text budgets subtract their own CSS padding/borders in Task 3. `undefined` in `facts.clip` means no local clipping declaration; the ambiguous raw `null` parser result is converted to `uncertain` at this boundary.

- [x] **1. Preserve the exact pre-implementation state.** Record `git status --short`, relevant source hashes and narrow/full test results in a new runtime evidence directory. Do not reset, stash or commit the inherited worktree. The previous candidate's incomplete live matrix is not this change's passing baseline.
- [x] **2. Add the batch freshness test before implementation.** Use this complete contract test with the imports shown:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { createTranslationGeometry } from '../../src/page/translation/translation-geometry';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('keeps fractional source facts within a batch and refreshes the next batch', () => {
  const el = document.createElement('div');
  document.body.append(el);
  let x = 10.25;
  vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(x, 20.5, 99.75, 30.25),
  );
  const first = createTranslationGeometry(window);
  expect(first.facts(el).box.x).toBe(10.25);
  x = 40.75;
  expect(first.facts(el).box.x).toBe(10.25);
  expect(createTranslationGeometry(window).facts(el).box.x).toBe(40.75);
});
```

- [x] **3. Run the new test and preserve RED.** Command: `./node_modules/.bin/vitest run tests/translation/translation-geometry.test.ts --maxWorkers=2`. Expected first failure is the missing factory/module, not environment or syntax errors.
- [x] **4. Implement the facts reader with detached primitive values.** Cache `TranslationElementFacts` per element within the factory closure, copy `x/y/width/height`, strings and `currentCSSZoom` into the record, and derive the client rectangle from client offsets/sizes with zoom once. Do not cache a live `CSSStyleDeclaration` as a snapshot. Keep semantic exclusions and editor/privacy decisions outside the reader.
- [x] **5. Implement explicit clip-result reduction.** Use a supported rectangle intersection to return `hidden/empty-clip`; propagate `uncertain` while preserving the conservative remaining rectangle. A later proven empty intersection dominates an earlier unknown shape. Do not equate unsupported geometry with an invisible surface. Resolve normal-flow clipping from the actual ancestor chain; for out-of-flow relationships, apply only proven containing-block clips and preserve uncertainty for unproven relationships. Do not use `offsetParent` alone as proof for all transformed/fixed cases.
- [x] **6. Add table-driven unit cases for the result contract.** Include no clip, fractional negative inset, local unknown shape, unknown shape plus a proven empty ancestor, zero-height overflow-visible wrapper, and zero-height overflow-hidden wrapper. Reuse `translation-clipping.test.ts` values for the parser rather than implementing another CSS parser. Browser-specific containing-block facts are tested with Chromium in Task 2, not invented JSDOM layout.
- [x] **7. Run and review the owner tests.** Command: `./node_modules/.bin/vitest run tests/translation/translation-geometry.test.ts tests/translation/translation-clipping.test.ts tests/translation/translation-regions.test.ts --maxWorkers=2`. Check that callers can distinguish uncertainty without a second `conservativeNative` boolean.

## Task 2: One Geometry Contract for Discovery, Context and Paint

**Files:**

- Modify: `src/page/translation/translation-dom.ts` (`collect`, `paint`)
- Modify: `src/page/translation/translation-context.ts` (`visible`)
- Modify: `src/page/translation/translation-structure-layout.ts` (`render`, `revealed`, `clipToParents`, `hidden`, `position`)
- Modify: `e2e/tests/browser/translation-native-visibility.spec.ts`
- Modify: `e2e/tests/browser/translation-portal-regressions.spec.ts`
- Modify: `e2e/tests/browser/translation-document-flow.spec.ts`
- Test: `tests/translation/translation-context.test.ts`, `tests/translation/translation-dom.test.ts`

**Interfaces:**

Consumes `TranslationGeometry` from Task 1. Retains `TranslationDom.update/accept/refresh`, the existing `render/reposition/revealed` external signatures and the public translation protocol. Native protection uses both `visible.rect` and `uncertain.rect`; hidden surfaces contribute no obstacle. Target paint requires supported visibility; uncertainty is kept as an attributable layout limitation, not a fake model error.

- [x] **1. Freeze the existing paired protection tests.** Retain both `absolute` and `fixed` cases in `translation-native-visibility.spec.ts`, with actual screenshot pixel equality, and the clipped animated-track/clipped-iframe cases in `translation-portal-regressions.spec.ts`. Do not replace their assertions with `data-status` checks.
- [x] **2. Add the following cross-boundary coverage test.** It combines fractional clipping, a tall native media element and nearby static text. Keep the existing native-overlap tests as its converse:

```ts
import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'does not let clipped native geometry reject nearby static text',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
      .port{position:absolute;left:60.25px;top:60px;width:590.75px;height:24.5px;overflow:hidden}
      iframe{display:block;width:100%;height:170px;border:0}
      main{position:absolute;left:60.25px;top:120px;margin:0!important;width:590.75px!important;font:14px/20px Arial}
    </style>
    <div class="port"><iframe title="Native media" srcdoc="Native controls"></iframe></div>
    <main><a href="#news">普通新闻</a></main>`,
      { 普通新闻: 'Ordinary news' },
    );
    const before = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Ordinary news');
    expect((await f.read()).find((r) => r.text === 'Ordinary news')?.font).toBe(14);
    expect(await f.page.locator('main').innerHTML()).toBe(before);
  },
);
```

- [x] **3. Run the targeted browser baseline before migration.** Build once, then run: `./node_modules/.bin/playwright test --config e2e/playwright.config.ts translation-native-visibility.spec.ts translation-portal-regressions.spec.ts translation-document-flow.spec.ts`. Preserve results. Existing candidate fixes may already make individual cases green; do not manufacture a regression to justify the consolidation. New unexplained failures must be reproduced and classified before editing their owner.
- [x] **4. Replace duplicated geometry loops.** At each synchronous collection/render/reposition boundary create a new facts batch. Route the DOM `clippingParents`, layout `clipToParents`, `revealed` range clipping and `position` overflow clipping through the same result contract. Source facts may be shared within the current pass; copied nodes changed by `apply` must be measured only after those changes. Do not reuse source or copy geometry across model waits.

The native-boundary caller's entire result policy is kept explicit; uncertainty protects the remaining rectangle instead of being interpreted as hidden:

```ts
const geometry = createTranslationGeometry(this.view);
const native = nativeSources.flatMap((surface) => {
  if (!surface.element) return [surface];
  const el = surface.element;
  if (!el.isConnected) return [];
  const result = geometry.clip(geometry.facts(el).box, el, { includeSelf: true });
  return result.kind === 'hidden' ? [] : [{ ...result.rect, element: el }];
});
```

- [x] **5. Preserve the mirror-versus-source distinction explicitly.** A normal-flow auto-height float-clearing shell can grow in a copy, while a real source scrollport remains a clipping boundary. Represent that as an explicit layout constraint owned by the renderer; do not delete the existing float-clear behavior or embed a second ancestor parser in `position`. Background/watermark reconstruction still uses the source ancestry but consumes shared geometry results.
- [x] **6. Replace basic context visibility without making it viewport-limited.** Keep context's semantic exclusions and editable/privacy boundary. Add a test to `translation-context.test.ts` with a target and a following paragraph whose mocked rectangle is below the viewport: the following normal paragraph remains in context; hidden menus, drafts and zero clips remain absent. Reuse the existing 6,000-character budget tests unchanged.
- [x] **7. Complete the combined geometry checks.** Extend the native tests with a transformed containing block and an unsupported clipping shape. Preserve an actually visible protected pixel region in each case; verify safe static text elsewhere still translates. In document-flow tests, retain a horizontally panned table with fractional/negative insets and a zero-height overflow-visible wrapper. The expected outcome is readable table cells with preserved original columns, not a generic ready status.
- [x] **8. Delete the replaced loops and rerun owners.** No independent `clippingParents` or private `clipToParents` implementation remains. Run `./node_modules/.bin/vitest run tests/translation --maxWorkers=2`, rebuild, then rerun the same three browser files and `translation-source-boundaries.spec.ts`. Review source-DOM immutability and native-pixel evidence before accepting this task.

## Task 3: One Source-derived Text Budget

**Files:**

- Create: `src/page/translation/translation-text-constraints.ts`
- Modify: `src/page/translation/translation-structure-layout.ts` (`constrainCompactText`, `constrainLabelText`, `constrainLinkRows`, `constrainFloatColumns`, `render`)
- Modify: `e2e/tests/browser/translation-structure.spec.ts`
- Modify: `e2e/tests/browser/translation-motion.spec.ts`
- Test: `e2e/tests/browser/translation-layout.spec.ts`, `translation-readable.spec.ts`, `translation-portal-regressions.spec.ts`

**Interfaces:**

Consumes Task 1 facts, existing source-to-copy maps and existing translated span elements. Produces one constraint plan before applying translations, and one application path. It does not depend on `TranslationDom`, model requests or private `Group` fields:

```ts
export interface TranslationLabelBudget {
  source: Element;
  inlineSize: number;
  lineLimit: number;
  reason: 'source-ellipsis' | 'fixed-cell' | 'independent-neighbor';
}

export interface TranslationRowBudget {
  source: Element;
  cells: readonly Element[];
  direction: 'row' | 'row-reverse';
  gap: number;
}

export interface TranslationTextConstraints {
  labels: readonly TranslationLabelBudget[];
  rows: readonly TranslationRowBudget[];
  columns: readonly { source: Element; inlineSize: number }[];
}

export function readTranslationTextConstraints(
  root: Element,
  children: readonly Element[] | undefined,
  protectedRegions: readonly TranslationRect[],
  geometry: TranslationGeometry,
): TranslationTextConstraints;

export function applyTranslationTextConstraints(
  plan: TranslationTextConstraints,
  copies: ReadonlyMap<Node, Node>,
  translated: readonly HTMLElement[],
): void;
```

`inlineSize` is a local CSS-pixel content budget, not a rounded viewport width. The plan's source elements map directly to existing copy nodes. No constraint is added for ordinary flow prose merely because it contains links.

- [x] **1. Add a structural-equivalence fixture before changing the constraints.** Parameterize a one-line toolbar label over `a`, `span` and `div`, each with an icon and nested label. Use the same original font, width and long translation. Assert the same visible label budget, native font and separate icon pixels for each tag; additionally place linked prose below and assert that it wraps as prose. Repeat with a moving sibling that separates static labels into individual groups. Use `setupTranslationFixture` and existing `f.read()` fields, not tag-specific assertions in production.
- [x] **2. Run and retain the baseline for all layout owners.** Command after building: `./node_modules/.bin/playwright test --config e2e/playwright.config.ts translation-structure.spec.ts translation-motion.spec.ts translation-layout.spec.ts translation-readable.spec.ts translation-portal-regressions.spec.ts`. Existing passing behaviors become preservation constraints; a new failure must have a visible overlap, font or coverage assertion.
- [x] **3. Move source measurement into the budget reader.** Read original text lines, explicit ellipsis/line-clamp, local content dimensions, flex/float/inline row relationships and independent protected neighbors once. Reuse existing icon/badge detection and the proven one-text-line calculation. Keep multi-row menus multi-row and let flow content grow. An independently clipped fixed-height carousel cell remains bounded to its cell, even when its translated string is longer.
- [x] **4. Apply one label path.** The complete shared operation for a single-line translated span is:

```ts
Object.assign(span.style, {
  display: 'block',
  minWidth: '0',
  maxWidth: '100%',
  flexShrink: '1',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});
```

Carry shrinkability through necessary nested wrappers without clipping a whole cell's icon/badge paint. Row and column budgets preserve their source formatting relationships; compact text never changes `fontSize` or `zoom`. Reflow stays browser-native. The copied original declarations remain authoritative for existing multi-line clamp contracts.

- [x] **5. Replace the repeated constraint passes in `render`.** Read the plan from source facts, create/update copies, apply that same plan, then measure and validate collisions. Remove the second `retainLineBudget` interpretation on collision. Keep a single bounded split/cutout fallback for real conflicts; preserve the existing ability to cut only empty backing. Do not solve a failure by silently assigning compact constraints to all text.
- [x] **6. Delete superseded calculation branches.** Remove the four old constraint methods once their source-measurement and application responsibilities are represented in the module. Keep no old/new feature switch. For every removed branch, record the regression that preserves its behavior, especially nested inline ellipsis, mixed toolbars, detached labels, icon padding and float column widths.
- [x] **7. Run the identical layout set and inspect screenshots.** All original size/spacing, source-readonly, native-media and long-prose assertions must remain. New snapshot references must not be accepted without verifying the glyph and icon geometry that changed. Report any retained separate rule and its distinct responsibility; no line-count target overrides correctness.

## Task 4: Unified Invalidation and Bounded Outcome Attribution

**Files:**

- Modify: `src/page/translation/translation-animation.ts`
- Modify: `src/page/translation/translation-dom.ts` (`mutate`, `motion`, `scroll`, `refresh`, `paint`)
- Modify: `src/page/translation/mount-translation-lens.ts` (`invalidate`, preview/final acceptance and status aggregation)
- Modify: `src/page/translation/translation-structure-layout.ts` (layout result reasons)
- Modify: `e2e/tests/browser/translation-motion.spec.ts`, `translation-refresh.spec.ts`, `translation-streaming.spec.ts`, `translation-paint.spec.ts`
- Modify: `e2e/diagnostics/translation-lens.ts`
- Test: `tests/translation/translation-lens.test.ts`, `translation-text-scheduling.test.ts`, `translation-text-streaming.test.ts`

**Interfaces:**

Keep `hasLiveTranslationAnimation`, `translationMotionRoot` and `isTranslationTextTrack` as the single animation owners; add the following script-style classifier to the same module and consume it from `TranslationDom.mutate`:

```ts
export type TranslationStyleChange = 'none' | 'appearance' | 'layout' | 'motion';
export function classifyTranslationStyleChange(
  before: CSSStyleDeclaration,
  after: CSSStyleDeclaration,
): TranslationStyleChange;

export type TranslationLayoutRejection =
  'geometry-uncertain' | 'native-overlap' | 'peer-overlap' | 'layout-budget' | 'unsafe-copy';
```

Style classification gives motion precedence over layout and appearance. CSS keyframes and transitions continue to inspect every property, including pending/running animations; unknown animation effects are not automatically safe. A geometry change caused only by resize/zoom/scroll is not a source-style motion event.

The layout result adds `reasons: ReadonlyMap<string, TranslationLayoutRejection>` alongside current `errors`/`unsupported`; it replaces duplicate unsupported bookkeeping as callers migrate. Keep transient copied-group reason metadata inside the closed overlay for the existing local diagnostic to inspect; no public message or provider schema changes. Diagnostic output contains per-run opaque source IDs, safe reason codes and counts only, not source text/URLs or model responses.

- [x] **1. Pin mixed style changes.** Add a unit test table: background-color alone → appearance; font-size → layout; transform/top/left/translate with or without color → motion; unchanged style → none. Include removal of a positional property as motion. Animation tests must also retain the current separate TOC-color-mask case and a simultaneous color+transform case that remains native.
- [x] **2. Pin delayed-response lifecycle.** Reuse the existing deferred-response approach in `translation-refresh.spec.ts`: move a floating toolbar before release, then assert the completed ordinary text/table paints against the new toolbar position. During another deferred response change the source text and trigger two manual refreshes; release responses out of order and assert only current source/refresh IDs appear. Keep request count bounded to explicit refreshes.
- [x] **3. Add a layout-only change assertion.** After successful translation, resize a narrow lens/viewport, change a static typography property and restore it. Assert the same source translation becomes readable without Alt+R or another model call. Combine that with an actual moving track nearby and assert that track still requires explicit refresh after it stops. Preserve the native origin of browser zoom and source scroll positions.
- [x] **4. Wire the classifier into the existing owners.** `TranslationDom` remains the only deferred set and source identity owner. `mount-translation-lens` retains generation checks, cancellation ordering and the current preview coalescing. Source-style motion is classified once; equivalent hydration does not erase a source identity; unrelated hidden mutation does not dirty all copied groups. Use Task 1 batches on each new layout pass, never restore request-time geometry.

The style classifier operates on the union of declared names, so removing a property is also observed; use this implementation with the same appearance-property predicate as the animation classifier:

```ts
export function classifyTranslationStyleChange(
  before: CSSStyleDeclaration,
  after: CSSStyleDeclaration,
): TranslationStyleChange {
  const names = new Set([...Array.from(before), ...Array.from(after)]);
  const changed = [...names].filter(
    (name) =>
      before.getPropertyValue(name) !== after.getPropertyValue(name) ||
      before.getPropertyPriority(name) !== after.getPropertyPriority(name),
  );
  if (!changed.length) return 'none';
  if (changed.some((name) => /^(left|right|top|bottom|transform|translate)$/.test(name)))
    return 'motion';
  return changed.every((name) =>
    /^(color|background-color|border(?:-(?:top|right|bottom|left))?-color|outline-color|text-decoration-color)$/.test(
      name,
    ),
  )
    ? 'appearance'
    : 'layout';
}
```

- [x] **5. Record a reason at each existing rejection boundary.** Budget exhaustion, unsafe copy, uncertain geometry, protected native collision and peer collision must each set the corresponding enum value. A successful later render replaces the old reason; refreshing/closing does not leave stale reason metadata. Never put model-service errors into this layout map. Aggregate UI notices continue to use the existing user-facing strings.
- [x] **6. Extend the local diagnostic conservatively.** Add per-stage counts of safe rejection codes and correlate existing request IDs to painted/rejected IDs when available. Keep normal native media separate from failed translation targets. Uncollected text coverage still requires source-versus-render fixture/live inspection; do not invent an ID for a node that was never observed or claim a perfect denominator.
- [x] **7. Run all lifecycle owners.** Command: `./node_modules/.bin/vitest run tests/translation/translation-lens.test.ts tests/translation/translation-text-scheduling.test.ts tests/translation/translation-text-streaming.test.ts e2e/tests/runner/translation-request.test.ts --maxWorkers=2`. Rebuild then run: `./node_modules/.bin/playwright test --config e2e/playwright.config.ts translation-motion.spec.ts translation-refresh.spec.ts translation-streaming.spec.ts translation-paint.spec.ts translation-reopen.spec.ts`. Inspect screenshots and safe reason output alongside assertions.

## Task 5: Frozen Full Validation, Deletion Audit and Handoff

**Files:**

- Modify: `src/translation/README.md`
- Create: `e2e/translation-rendering-core-validation-20260921.md`
- Review: all changed production/test files against the preserved pre-implementation worktree, not merely HEAD

**Interfaces:**

Consumes the completed Tasks 1–4 build, existing browser fixtures, canonical live Profile and existing sample IDs. Produces an evidence-backed acceptance record with passed/failed/unverified states, safe rejection attribution and actual deleted responsibilities. No additional production execution path is introduced by verification.

- [x] **1. Run the required local gates on the final candidate.** Preserve each command's exit status and output independently:

```bash
npm run format:check
npm run lint
npm run test:run -- --maxWorkers=2
npm run test:e2e
npm run audit:bundle
npm run check:sandbox
npm run e2e:catalog:validate
git diff --check
```

`test:e2e` builds and typechecks. Run the environment doctor as prescribed before live verification. Freeze the resulting bundle hashes; no product edits or rebuilds during the serial live matrix. Only run `check:codex` if the shell already has its legitimate token; never extract credentials.

- [x] **2. Verify canonical access for each existing live sample.** Use `./node_modules/.bin/tsx e2e/runner/verify.ts` with `translation-lark-wiki-readable`, `translation-lark-readable`, `translation-baidu-readable`, `translation-qq-readable` and `translation-random-hao123`, one at a time. If setup/authentication is unavailable, use the RUNBOOK setup flow; do not substitute a copied Profile or a new credential path.
- [x] **3. Run the existing native-feature diagnostic serially on the frozen build.** These are translation feature checks, not WorkSession benchmark passes:

```bash
CHATBROWSERX_LENS_SELECT_BEFORE_REFRESH=1 ./node_modules/.bin/tsx e2e/diagnostics/translation-lens.ts translation-lark-wiki-readable en '模块划分' 1440 '3.1 模块划分'
./node_modules/.bin/tsx e2e/diagnostics/translation-lens.ts translation-lark-readable en
./node_modules/.bin/tsx e2e/diagnostics/translation-lens.ts translation-baidu-readable en
./node_modules/.bin/tsx e2e/diagnostics/translation-lens.ts translation-qq-readable en
./node_modules/.bin/tsx e2e/diagnostics/translation-lens.ts translation-random-hao123 en
```

Do not execute all commands blindly after a material failure: preserve and classify the first failure, correct only its demonstrated owner, rebuild and rerun the frozen scenario. Actual benchmark attempts, if required by a sample, use the shared benchmark runner and remain under `samples/<id>/benchmark/`; native diagnostic evidence remains in its existing runtime location.

- [x] **4. Inspect the complete feature matrix.** For each site record initial translation, manual refresh, scroll, lens movement/resize, browser zoom/restoration and reopen. Inspect actual heading/body/table/nav text and typography. A ready/unsupported status, completed HTTP request or a count of translated entries alone is not a pass. If a small lens plus zoom loses ordinary static text, record a failure even when Alt+R later recovers it.
- [x] **5. Audit deletion against responsibilities.** Confirm the duplicate clipping loops, late alternate compact pass and repeated dynamic classification are removed. Keep safe copy sanitization, watermark handling, empty-backing cutouts, source links, media pixels and privacy tests. Record any remaining distinct special rule by CSS behavior and evidence, never by a site's hostname or title. Do not delete unrelated inherited worktree changes.
- [x] **6. Self-review the whole candidate and update documentation.** Update README to describe the new responsibility boundaries and remove documentation of replaced algorithms. Link every claimed fix to preserved regression/live evidence in the validation record. Keep failures and limits explicit; no subagent is authorized for this review.
- [x] **7. Handoff without committing or pushing.** Summarize changed behavior, removed redundancy, necessary retained protections, commands/results, unresolved issues and extension reload needs. Do not declare complete if ordinary static text still fails in the required sites, native pixels are covered, source content is modified, gates fail or the required live verification is unavailable.

## Self-review Before Execution

- [x] Every spec section has an owning task: geometry → 1/2; changes → 4; layout → 3; deletion → 2/3/4/5; attribution → 4; verification and boundaries → 5.
- [x] Types and function names in consumers match the Interfaces sections; they are internal helpers, not public protocol additions.
- [x] Each Review Focus item has both coverage and protection assertions. Existing test pass counts do not replace fresh final-candidate evidence.
- [x] This plan is reviewed before product edits. Execution remains native in this session, without subagents, commits or pushes.
