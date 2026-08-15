# ChatBrowserX Browser Execution Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the semantic observation, durable targeting, DOM/CDP action drivers, verification, retry budgets, tab tracking, and resumable browser executor that determine real task success.

**Architecture:** A dynamically injected isolated content script provides low-cost DOM observation and actions; a Chrome Debugger transport provides accessibility-tree, frame, navigation, and real-input capabilities. A pure resolver and evidence-driven router select a driver per action, while the executor persists intent and verification boundaries through the task repository.

**Tech Stack:** TypeScript, Chrome Scripting API, Chrome Debugger/CDP 1.3, Zod runtime messages, Vitest/jsdom, existing durable task core.

**Spec:** Read `docs/superpowers/specs/browser-agent-project-spec.md` first; its approved normative body is `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`.

## Global Constraints

- Complete the foundation plan first.
- Never persist an ephemeral element ID, CSS selector, XPath, coordinate, or CDP `backendNodeId` as the sole target locator.
- Do not automatically scroll the whole page during observation.
- Do not expose arbitrary JavaScript evaluation as a model tool.
- Persist action intent before execution and evidence/checkpoint after verification.
- Route by demonstrated capability/success; do not hard-code DOM-always-first or CDP-always-first.
- Stop after 3 action attempts, 2 replans, 50 actions, or 20 minutes unless the user extends the task.
- Do not commit or push.

---

### Task 1: Browser Contracts and Bounded Semantic DOM Observation

**Files:**

- Create: `src/browser/contracts/observation.ts`
- Create: `src/browser/contracts/target.ts`
- Create: `src/browser/contracts/action.ts`
- Create: `src/browser/contracts/evidence.ts`
- Create: `src/browser/observe/dom-observer.ts`
- Create: `src/browser/observe/dom-semantics.ts`
- Create: `src/browser/observe/visibility.ts`
- Create: `src/browser/observe/observation-limits.ts`
- Create: `src/page/browser-command-handler.ts`
- Create: `src/entries/page-content.iife.ts`
- Create: `src/platform/chrome/content-script-installer.ts`
- Modify: `src/shared/protocol/message-types.ts`
- Modify: `src/shared/protocol/message-schema.ts`
- Modify: `src/shared/protocol/parse-message.ts`
- Modify: `src/shared/protocol/index.ts`
- Create: `tests/browser/observe/dom-observer.test.ts`
- Create: `tests/platform/chrome/content-script-installer.test.ts`
- Create: `tests/page/browser-command-handler.test.ts`
- Modify: `tests/shared/protocol/parse-message.test.ts`

**Interfaces:**

- Consumes: optional host permissions, Chrome Scripting API, runtime protocol.
- Produces: `PageObservation`, `ObservedElement`, `ElementTarget`, `observeDocument(document, options)`, `ContentScriptInstaller.ensureInstalled(tabId, origin)`.

Content-script commands use a separate strict `PageCommand` union with `page.ping` and `page.observe`; task/UI messages remain in `ExtensionMessage`, so page contexts can never address credential or repository operations.

- [x] **Step 1: Write failing semantic observation tests**

Create a jsdom fixture with a labeled input, hidden button, disabled button, dialog, open Shadow Root, and same-origin iframe document. Assert that observation includes role/name/value/state/frame/shadow metadata, excludes hidden nodes, retains disabled state, and never calls `scrollTo`.

```ts
const observation = observeDocument(document, {
  url: 'https://example.test/form',
  viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
});

expect(observation.elements).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ role: 'textbox', name: 'Email', value: 'a@example.test' }),
    expect.objectContaining({ role: 'button', name: 'Save', disabled: true }),
  ]),
);
expect(observation.elements.some((item) => item.name === 'Hidden')).toBe(false);
expect(window.scrollTo).not.toHaveBeenCalled();
```

- [x] **Step 2: Run the tests and confirm failure**

Run `npm run test:run -- tests/browser/observe/dom-observer.test.ts tests/platform/chrome/content-script-installer.test.ts`.

Expected: FAIL because observation and installer modules are missing.

- [x] **Step 3: Define exact observation and target contracts**

Use these core shapes:

```ts
export interface PageObservation {
  id: string;
  capturedAt: number;
  tabId: number;
  url: string;
  title: string;
  viewport: ViewportState;
  textRegions: TextRegion[];
  elements: ObservedElement[];
  frames: ObservedFrame[];
  truncated: boolean;
}

export interface ObservedElement {
  observationRef: string;
  framePath: FrameSegment[];
  shadowPath: ShadowSegment[];
  role: string;
  name: string;
  label: string | null;
  text: string | null;
  value: string | null;
  stableAttributes: Record<string, string>;
  state: {
    disabled: boolean;
    checked: boolean | null;
    selected: boolean | null;
    expanded: boolean | null;
  };
  rect: Rect;
  visible: boolean;
  obscured: boolean;
  backendNodeId: number | null;
  cdpSessionId: string | null;
}

export interface ElementTarget {
  framePath: FrameSegment[];
  shadowPath: ShadowSegment[];
  role: string | null;
  name: string | null;
  label: string | null;
  text: string | null;
  stableAttributes: Record<string, string>;
  ancestorHint: string | null;
  lastKnownRect: Rect | null;
}
```

Set hard observation limits to 400 interactive elements, 120 text regions, 20,000 normalized text characters, and depth 40. Mark `truncated: true` instead of silently dropping the fact that limits were reached.

- [x] **Step 4: Implement DOM traversal without page mutation**

Traverse document order, open Shadow Roots, and accessible same-origin frame documents. Derive name in this order: `aria-label`, associated `<label>`, `aria-labelledby`, button/link text, `alt`, `title`, placeholder. Keep `data-testid`, `name`, `id`, `autocomplete`, and input `type` as stable attributes; reject style/class hashes and React-generated IDs.

Use computed style, client rects, viewport intersection, and `elementFromPoint` to set visibility/obscured flags. Do not click, focus, scroll, or mutate while observing.

- [x] **Step 5: Implement on-demand content script bundling and installation**

Import the standalone bundle path using CRXJS:

```ts
import pageContentScript from '../../entries/page-content.iife.ts?script';
```

`ContentScriptInstaller.ensureInstalled(tabId, origin)` must first call `chrome.permissions.contains({ origins: [`${origin}/*`] })`, return `permission_required` when absent, ping an existing content script, and only then use `chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: [pageContentScript] })`. The top-frame observer traverses accessible same-origin iframe documents itself, avoiding nondeterministic replies from multiple content-script frames. A user-gesture method separately performs `chrome.permissions.request`.

- [x] **Step 6: Verify observation and dynamic injection**

Run:

```bash
npm run test:run -- tests/browser/observe tests/platform/chrome/content-script-installer.test.ts
npm run typecheck
npm run build
```

Expected: PASS; built manifest still has no static all-site content script.

- [x] **Step 7: Review checkpoint**

Search for `scrollTo`, `eval`, and raw token names in page/browser files. Only test fixtures may use `scrollTo`; no `eval` or credential field may exist. Do not commit.

---

### Task 2: Chrome Debugger Transport and CDP Observation

**Files:**

- Create: `src/platform/chrome/debugger-transport.ts`
- Create: `src/platform/chrome/debugger-events.ts`
- Create: `src/browser/observe/cdp-observer.ts`
- Create: `src/browser/observe/merge-observations.ts`
- Create: `tests/platform/chrome/debugger-transport.test.ts`
- Create: `tests/browser/observe/cdp-observer.test.ts`
- Create: `tests/browser/observe/merge-observations.test.ts`

**Interfaces:**

- Consumes: `chrome.debugger`, `PageObservation`.
- Produces: `DebuggerTransport`, `ChromeDebuggerTransport`, `CdpObserver`, `mergeObservations(dom, cdp)`.

- [x] **Step 1: Write failing transport lifecycle tests**

Test idempotent attach, reference-counted use by one task, detach on final release, external detach notification, and command routing with `sessionId` for child targets.

```ts
await transport.acquire(7, 'task_1');
await transport.acquire(7, 'task_1');
expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
await transport.release(7, 'task_1');
expect(chrome.debugger.detach).not.toHaveBeenCalled();
await transport.release(7, 'task_1');
expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
```

- [x] **Step 2: Run focused tests and confirm failure**

Run `npm run test:run -- tests/platform/chrome/debugger-transport.test.ts tests/browser/observe/cdp-observer.test.ts`.

Expected: FAIL.

- [x] **Step 3: Implement the transport with CDP protocol 1.3**

Define:

```ts
export interface DebuggerTransport {
  acquire(tabId: number, ownerId: string): Promise<void>;
  release(tabId: number, ownerId: string): Promise<void>;
  send<TResult>(
    tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<TResult>;
  subscribe(listener: DebuggerEventListener): () => void;
  listSessions(tabId: number): Promise<readonly DebuggerSessionDescriptor[]>;
  isAttached(tabId: number): boolean;
}
```

Attach with `chrome.debugger.attach({ tabId }, '1.3')`. Immediately enable `Page`, `DOM`, `Runtime`, and `Accessibility`, then call `Target.setAutoAttach` with `{ autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] }`. Track `Target.attachedToTarget` and `Target.detachedFromTarget`; enable the same domains and recursive auto-attach on every child iframe session before exposing it through `listSessions`. Convert protocol failures and external `onDetach` reasons into typed transport errors.

- [x] **Step 4: Implement accessibility/CDP observation**

Use `Accessibility.getFullAXTree`, `DOM.getDocument`, and `DOMSnapshot.captureSnapshot` on the root and every initialized child iframe session to build semantic elements and frame metadata. Map an OOPIF target ID to the owner node's frame ID, merge recursively captured paths, and retain `cdpSessionId` only with the same observation-time lifetime as `backendNodeId`. Never expose `Runtime.evaluate` as a public Browser Controller capability.

Normalize CDP nodes into the same `ObservedElement` shape. Merge DOM and CDP candidates using frame path, role/name, stable attributes, and overlapping rectangles; prefer DOM values for live form state and CDP data for inaccessible frames and backend IDs.

- [x] **Step 5: Verify CDP observation and detach behavior**

Run:

```bash
npm run test:run -- tests/platform/chrome/debugger-transport.test.ts tests/browser/observe/cdp-observer.test.ts tests/browser/observe/merge-observations.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 6: Review checkpoint**

Confirm every attach has release coverage and all detach/error paths clear in-memory session data. Do not commit.

---

### Task 3: Durable Target Resolver and Ambiguity Detection

**Files:**

- Create: `src/browser/locate/target-score.ts`
- Create: `src/browser/locate/target-resolver.ts`
- Create: `src/browser/locate/target-resolution.ts`
- Create: `tests/browser/locate/target-resolver.test.ts`

**Interfaces:**

- Consumes: `PageObservation`, `ElementTarget`.
- Produces: `resolveTarget(observation, target): TargetResolution` where result is `resolved`, `ambiguous`, or `not_found`.

- [x] **Step 1: Write failing unique, stale, and ambiguous target tests**

Cover an exact role/name match after DOM reorder, label match after generated ID changes, two identical “Save” buttons under different ancestor hints, a disabled candidate, and a target that disappeared.

```ts
expect(resolveTarget(reorderedObservation, savedTarget)).toMatchObject({
  kind: 'resolved',
  element: { role: 'button', name: 'Save' },
});
expect(resolveTarget(duplicateButtons, targetWithoutAncestor)).toMatchObject({ kind: 'ambiguous' });
```

- [x] **Step 2: Run the resolver test and confirm failure**

Run `npm run test:run -- tests/browser/locate/target-resolver.test.ts`.

Expected: FAIL.

- [x] **Step 3: Implement deterministic scoring**

Use these weights, documented beside the constants:

```ts
export const TARGET_WEIGHTS = {
  framePath: 50,
  shadowPath: 40,
  roleAndName: 40,
  label: 30,
  stableAttribute: 25,
  exactText: 20,
  ancestorHint: 15,
  geometryOverlap: 5,
  invisiblePenalty: -100,
  disabledPenalty: -100,
} as const;
```

A result is resolved only when the best score is at least 60 and exceeds the second candidate by at least 15. Otherwise return `ambiguous` with at most five sanitized candidate summaries. Never pick the first DOM match to break a tie.

- [x] **Step 4: Verify resolver determinism**

Run `npm run test:run -- tests/browser/locate/target-resolver.test.ts` ten times with `--repeat=10` or an equivalent loop.

Expected: identical PASS results and candidate ordering.

- [x] **Step 5: Review checkpoint**

Confirm no persisted target factory stores `observationRef`, raw selector, or backend ID without semantic fields. Do not commit.

---

### Task 4: DOM and CDP Action Drivers

**Files:**

- Create: `src/browser/act/action-driver.ts`
- Create: `src/browser/act/dom-action-driver.ts`
- Create: `src/browser/act/cdp-action-driver.ts`
- Create: `src/browser/act/action-errors.ts`
- Create: `src/browser/act/page-action-message.ts`
- Create: `src/page/dom-action-handler.ts`
- Modify: `src/page/browser-command-handler.ts`
- Create: `tests/browser/act/dom-action-driver.test.ts`
- Create: `tests/browser/act/cdp-action-driver.test.ts`
- Modify: `tests/page/browser-command-handler.test.ts`

**Interfaces:**

- Consumes: resolved target, Debugger transport, page command channel.
- Produces: `ActionDriver.execute(request): Promise<BrowserActionEvidence>` for all ten approved actions.

- [x] **Step 1: Write failing action contract tests**

Test click, type with native value setter and input/change events, clear, select, check, hover, key press, scroll, drag sequence, and conditional wait. Verify the DOM driver refuses obscured targets and the CDP driver emits real mouse/key commands.

```ts
await driver.execute({
  actionId: 'a1',
  type: 'type',
  target,
  text: 'hello',
  expected: expectedValue,
});
expect(input).toHaveValue('hello');
expect(events).toEqual(['input', 'change']);
```

- [x] **Step 2: Run action tests and confirm failure**

Run `npm run test:run -- tests/browser/act`.

Expected: FAIL.

- [x] **Step 3: Implement the DOM driver without framework-specific hooks**

Resolve targets immediately before action. Use native property descriptors for input/textarea value, dispatch `InputEvent` and `Event('change')`, and call element methods only after visibility/obscuration checks. Implement select/check through native properties and events. Implement drag with pointer/mouse/drag event sequence but report `unsupported` when the page ignores synthetic events so routing can escalate to CDP. Resolve DOM semantics and construct events through each element's own document realm so same-origin iframe controls remain operable.

- [x] **Step 4: Implement the CDP real-input driver**

Use `Input.dispatchKeyEvent` with the platform-independent `SelectAll` editor command for replacement and clearing. For an exact native select value, use only an internal constant `Runtime.callFunctionOn` function plus argument values; no model or caller can supply JavaScript source. Use a real mouse move/press/move/release sequence for drag, and reject source/destination targets that belong to different CDP sessions.

For click and hover, obtain the live box model and use its center with `Input.dispatchMouseEvent`. For text, focus the node, select existing content when requested, and use `Input.insertText`; keys use paired `keyDown`/`keyUp`. Scroll uses `Input.dispatchMouseEvent` with `type: 'mouseWheel'`; drag uses `Input.dispatchDragEvent` with `dragEnter`, `dragOver`, and `drop`.

Every evidence record includes action ID, driver, started/finished timestamps, resolved semantic summary, before/after URL, and command result. It excludes raw page HTML and credentials.

- [x] **Step 5: Verify action drivers**

Run:

```bash
npm run test:run -- tests/browser/act
npm run typecheck
```

Expected: PASS.

- [x] **Step 6: Review checkpoint**

Search for `Runtime.evaluate`; only private CDP observation/target-resolution code may use constrained evaluation, and no exported action accepts JavaScript source. Do not commit.

---

### Task 5: Condition-Based Verification and Waits

**Files:**

- Create: `src/browser/verify/expected-condition.ts`
- Create: `src/browser/verify/verification-engine.ts`
- Create: `src/browser/verify/dom-condition-waiter.ts`
- Create: `src/browser/verify/navigation-waiter.ts`
- Create: `tests/browser/verify/verification-engine.test.ts`
- Create: `tests/browser/verify/dom-condition-waiter.test.ts`
- Create: `tests/browser/verify/navigation-waiter.test.ts`

**Interfaces:**

- Consumes: action evidence, fresh observations, DOM mutation events, CDP page lifecycle events.
- Produces: `VerificationEngine.verify(request): Promise<VerificationResult>` and `ExpectedCondition` union.

- [x] **Step 1: Write failing verification tests**

Cover URL change, target value, visible/hidden, checked, text contains, element count change, new tab, and page-stable conditions. Test timeout and abort signal behavior with fake timers.

```ts
const result = await verifier.verify({
  tabId: 7,
  condition: { type: 'element.value', target, equals: 'hello' },
  timeoutMs: 5_000,
  signal,
});
expect(result).toMatchObject({ satisfied: true, evidence: { kind: 'element.value' } });
```

- [x] **Step 2: Run verification tests and confirm failure**

Run `npm run test:run -- tests/browser/verify`.

Expected: FAIL.

- [x] **Step 3: Implement the expected-condition union and event-driven waiters**

Define exact conditions:

```ts
export type ExpectedCondition =
  | { type: 'url.changed'; from: string }
  | { type: 'url.matches'; pattern: string }
  | { type: 'element.value'; target: ElementTarget; equals: string }
  | { type: 'element.visible'; target: ElementTarget; visible: boolean }
  | { type: 'element.checked'; target: ElementTarget; checked: boolean }
  | { type: 'text.contains'; text: string }
  | { type: 'element.count'; target: ElementTarget; operator: 'eq' | 'gt' | 'lt'; value: number }
  | { type: 'tab.opened'; openerTabId: number }
  | { type: 'page.stable'; quietMs: number };
```

Use MutationObserver and browser navigation events to wake checks. Poll at 250 ms only while no relevant event is available. Clamp verification timeout to 15 seconds and page-stable quiet time to 300–2,000 ms.

- [x] **Step 4: Verify timeout, abort, and cleanup**

Run `npm run test:run -- tests/browser/verify --coverage=false` with fake timers restored after every test.

Expected: PASS with no dangling timer warnings.

- [x] **Step 5: Review checkpoint**

Search for fixed delays over 250 ms in `src/browser`; only bounded verification polling may remain. Do not commit.

---

### Task 6: Evidence-Driven Driver Routing and Browser Controller

**Files:**

- Create: `src/browser/route/driver-capabilities.ts`
- Create: `src/browser/route/driver-outcomes.ts`
- Create: `src/browser/route/driver-router.ts`
- Create: `src/browser/browser-controller.ts`
- Create: `src/platform/chrome/page-observation-source.ts`
- Create: `tests/browser/route/driver-router.test.ts`
- Create: `tests/browser/browser-controller.test.ts`
- Create: `tests/platform/chrome/page-observation-source.test.ts`

**Interfaces:**

- Consumes: observers, resolver, both drivers, verifier.
- Produces: roadmap `BrowserController`, `DriverRouter.select(input)`, `DriverOutcomeRepository`.

- [x] **Step 1: Write failing routing tests**

Test that cross-origin frame and real-input requirements select CDP, a prior DOM no-effect failure lowers DOM confidence, a prior CDP detach lowers CDP confidence, and equal proven success chooses DOM. Do not assert a global default independent of capability.

- [x] **Step 2: Run routing tests and confirm failure**

Run `npm run test:run -- tests/browser/route tests/browser/browser-controller.test.ts`.

Expected: FAIL.

- [x] **Step 3: Implement capability gates and rolling outcomes**

Capabilities include `semantic_dom`, `cross_origin_frame`, `real_pointer`, `real_keyboard`, `navigation_lifecycle`, `synthetic_drag`, and `cdp_drag`. Persist per-origin/action driver outcomes as success, no-effect, target failure, transport failure, and duration samples; retain at most the latest 100 outcomes per key. Samples use a stable per-attempt ID and repositories upsert that ID so Service Worker recovery cannot duplicate evidence.

Routing order is: eliminate incapable drivers, blend the scenario prior with verified outcomes from the first sample onward using a two-sample prior weight, then choose DOM only when expected success differs by less than 2 percentage points. This lets a bounded low-risk retry explore the other capable driver immediately after one explicit transport or target failure.

- [x] **Step 4: Implement `BrowserController` orchestration**

`observe` merges available DOM and CDP data and reacquires CDP after an external detach. `execute` resolves every target, including a drag destination, forces CDP for child-session targets, selects a capable driver, and returns typed evidence without counting a successful dispatch as a successful outcome. `verify` delegates to the verification engine and honors bounded `waitFor.timeoutMs`; `recordVerification` writes success only after the expected effect is satisfied. Outcome persistence is best-effort and cannot turn a verified browser effect into a failed task. `release` detaches CDP and clears transient page channels.

- [x] **Step 5: Verify controller behavior**

Run:

```bash
npm run test:run -- tests/browser
npm run typecheck
```

Expected: PASS.

- [x] **Step 6: Review checkpoint**

Confirm routing decisions include a machine-readable reason for diagnostics and benchmark reports. Do not commit.

---

### Task 7: Resumable Browser Executor, Risk Gate, and Tab Tracking

**Files:**

- Create: `src/agent/execution-types.ts`
- Create: `src/agent/action-digest.ts`
- Create: `src/agent/browser-executor.ts`
- Create: `src/agent/action-risk.ts`
- Create: `src/agent/retry-policy.ts`
- Create: `src/platform/chrome/tab-tracker.ts`
- Create: `src/tasks/task-coordinator.ts`
- Modify: `src/tasks/recovery-scanner.ts`
- Modify: `src/platform/chrome/register-background.ts`
- Create: `tests/agent/browser-executor.test.ts`
- Create: `tests/agent/action-risk.test.ts`
- Create: `tests/agent/retry-policy.test.ts`
- Create: `tests/platform/chrome/tab-tracker.test.ts`
- Create: `tests/tasks/task-coordinator.test.ts`
- Modify: `src/tasks/checkpoint-types.ts`
- Modify: `src/tasks/task-types.ts`
- Modify: `src/tasks/task-transition.ts`
- Modify: `src/tasks/task-command-service.ts`
- Modify: `src/shared/protocol/message-types.ts`
- Modify: `src/shared/protocol/message-schema.ts`
- Modify: `src/platform/chrome/message-router.ts`

**Interfaces:**

- Consumes: `TaskRepository`, `BrowserController`, future `AgentPlanner`, `Clock`, `TabTracker`.
- Produces: `BrowserExecutor.run(taskId, signal)`, `classifyActionRisk`, `TaskCoordinator.start/resume/pause/cancel`.

- [x] **Step 1: Write failing effect-boundary recovery tests**

Use an in-memory repository and fake Browser Controller. Cover termination before intent, after intent but before evidence, after browser effect but before checkpoint, and after checkpoint. For an unknown click result, re-observe and verify before deciding to retry. For submit/delete/send/payment, enter `waiting_for_confirmation` instead of retrying.

```ts
expect(repository.events).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ type: 'action.intent-recorded', actionId: 'action_1' }),
    expect.objectContaining({ type: 'action.verified', actionId: 'action_1' }),
  ]),
);
expect(browser.execute).toHaveBeenCalledTimes(1);
```

- [x] **Step 2: Run executor tests and confirm failure**

Run `npm run test:run -- tests/agent tests/tasks/task-coordinator.test.ts tests/platform/chrome/tab-tracker.test.ts`.

Expected: FAIL.

- [x] **Step 3: Implement risk classification and retry policy**

Mark actions as high risk when their target/action semantics include submit, send, publish, delete, remove, purchase, pay, transfer, confirm order, or account/security changes in the supported English, Simplified Chinese, and Japanese page languages. A planner may raise risk but cannot lower a policy classification. High-risk actions require a stored confirmation bound to the action digest.

Use canonical JSON with recursively sorted object keys and SHA-256 for the action digest. Bind confirmation to both that digest and the exact next attempt number so one confirmation cannot authorize a later replay.

Retry target resolution/driver execution at most three times, re-observe/replan at most twice, and never auto-retry an uncertain high-risk effect.

- [x] **Step 4: Implement intent/evidence/checkpoint execution**

Before every effect, transactionally store `action.intent-recorded` with action digest and expected condition. After execution, store evidence. After verification, atomically store `action.verified`, increment budget, and write the new checkpoint. On restart, inspect the latest intent and evidence and verify page state before any replay.

The pending checkpoint retains the normalized action, structured expected condition, intent timestamp, attempt count, effect state, bounded evidence, outcome, and optional digest/attempt-bound confirmation. Use `action.evidence-recorded` for the execution result and `action.verification-failed` before a replan.

- [x] **Step 5: Implement tab binding and new-tab adoption**

Track `tabs.onCreated`, `tabs.onUpdated`, `tabs.onRemoved`, and opener relationships. Adopt a new tab only when it was created after the action intent, has `openerTabId` equal to the bound tab, and satisfies the expected `tab.opened` condition. A missing bound tab transitions to `waiting_for_tab`; never silently choose the current active tab.

Only an explicit `task.resume` carrying a replacement `tabId` may rebind a missing-tab task. High-risk continuation uses the separate `task.confirm` command with the stored action digest.

- [x] **Step 6: Verify browser core**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
git diff --check
```

Expected: all pass. The queued foundation task can now advance through browser execution when supplied a fake planner. Do not commit.
