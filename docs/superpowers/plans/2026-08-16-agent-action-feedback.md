# Agent Action Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Subagents are not permitted for this repository task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transient on-page Agent cursor with click ripples and drag motion for supported DOM/CDP pointer actions.

**Architecture:** A top-frame content-script overlay owns all visual state inside a closed Shadow Root and registers with the existing screenshot overlay registry. DOM actions notify it locally with live element geometry; root-session CDP actions notify it through a strict, credential-free page command. Feedback remains best-effort and never influences action evidence or verification.

**Tech Stack:** TypeScript 6, Chrome MV3 content scripts and `tabs.sendMessage`, CDP `DOM.getBoxModel`/`Input.dispatchMouseEvent`, Zod, jsdom, Vitest.

## Global Constraints

- Keep the implementation dependency-free and compatible with Chrome 125+.
- Do not move browser execution or verification into the UI layer.
- Do not expose task data, page content, target text, credentials, or executable code through feedback messages.
- Feedback must use `pointer-events: none`, closed Shadow DOM, and the existing overlay registry.
- Feedback failure must not fail or delay the browser action.
- Skip CDP child-session feedback until frame-to-top coordinate projection is deterministic.
- Update the normative design and architecture documentation when the page command/UI surface changes.
- Leave all work uncommitted; replace commit steps with review checkpoints.

---

### Task 1: Strict Feedback Protocol and Page Overlay

**Files:**

- Modify: `src/shared/protocol/message-types.ts`
- Modify: `src/shared/protocol/message-schema.ts`
- Create: `src/page/action-feedback/action-feedback-overlay.ts`
- Modify: `src/entries/page-content.iife.ts`
- Test: `tests/shared/protocol/parse-message.test.ts`
- Create: `tests/page/action-feedback/action-feedback-overlay.test.ts`

**Interfaces:**

- Produces `PageActionFeedback` with `move`, `click`, `drag`, and `hide` variants.
- Produces `ActionFeedbackOverlay` with `show(feedback)`, `hide()`, and `dispose()`.
- Produces `mountActionFeedbackOverlay(options)` and `getActionFeedbackOverlay(document)`.

- [x] **Step 1: Add failing protocol tests**

Add acceptance tests for all four variants and rejection tests for `NaN`, `Infinity`, unknown kinds, and extra fields:

```ts
expect(
  parsePageCommand({
    version: 1,
    requestId: "feedback_click",
    type: "page.actionFeedback",
    payload: { kind: "click", x: 30, y: 40 },
  }),
).toMatchObject({
  type: "page.actionFeedback",
  payload: { kind: "click", x: 30, y: 40 },
});

expect(() =>
  parsePageCommand({
    version: 1,
    requestId: "feedback_bad",
    type: "page.actionFeedback",
    payload: { kind: "move", x: Number.NaN, y: 10 },
  }),
).toThrow(/invalid page command/i);
```

- [x] **Step 2: Run the protocol test and confirm RED**

Run:

```bash
npm run test:run -- tests/shared/protocol/parse-message.test.ts
```

Expected: FAIL because `page.actionFeedback` is not part of `PageCommand`.

- [x] **Step 3: Add the strict protocol type and schema**

Define:

```ts
export type PageActionFeedback =
  | { readonly kind: "move"; readonly x: number; readonly y: number }
  | { readonly kind: "click"; readonly x: number; readonly y: number }
  | {
      readonly kind: "drag";
      readonly fromX: number;
      readonly fromY: number;
      readonly toX: number;
      readonly toY: number;
    }
  | { readonly kind: "hide" };
```

Add `Message<'page.actionFeedback', PageActionFeedback>` to `PageCommand`. Use a strict Zod discriminated union whose coordinate fields are finite numbers.

- [x] **Step 4: Run the protocol test and confirm GREEN**

Run the Task 1 protocol command again. Expected: PASS.

- [x] **Step 5: Add failing overlay tests**

Cover:

```ts
const overlay = mountActionFeedbackOverlay({ document, view: window });
expect(mountActionFeedbackOverlay({ document, view: window })).toBe(overlay);

overlay.show({ kind: "click", x: 32, y: 48 });
expect(capturedShadow.querySelector(".cbx-agent-cursor")).toHaveClass(
  "is-visible",
);
expect(capturedShadow.querySelector(".cbx-agent-ripple")).not.toBeNull();

overlay.show({ kind: "move", x: -100, y: Number.MAX_SAFE_INTEGER });
expect(cursor.style.transform).toContain("translate3d(0px, 767px, 0)");

overlay.dispose();
expect(
  document.querySelector('[data-chatbrowserx-overlay="action-feedback"]'),
).toBeNull();
```

Also verify `hide`, drag destination movement after timers, automatic fade, reduced-motion duration, one host per document, and cleanup of pending timers.

- [x] **Step 6: Run the overlay test and confirm RED**

Run:

```bash
npm run test:run -- tests/page/action-feedback/action-feedback-overlay.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 7: Implement the minimal overlay controller**

Create one fixed, pointer-transparent host with a closed Shadow Root. Render a static cursor SVG and CSS ripple. Clamp points through:

```ts
function clampPoint(feedbackX: number, feedbackY: number, view: Window): Point {
  return {
    x: Math.min(Math.max(0, feedbackX), Math.max(0, view.innerWidth - 1)),
    y: Math.min(Math.max(0, feedbackY), Math.max(0, view.innerHeight - 1)),
  };
}
```

Keep the controller in a `WeakMap<Document, ActionFeedbackOverlay>`, register the host with `registerPageOverlayHost`, and mount it once from `page-content.iife.ts`. Use 140ms move, 420ms ripple, 260ms drag, 700–900ms fade timers, and reduced-motion fallbacks from the approved design.

- [x] **Step 8: Run Task 1 tests and confirm GREEN**

Run:

```bash
npm run test:run -- tests/shared/protocol/parse-message.test.ts tests/page/action-feedback/action-feedback-overlay.test.ts
```

Expected: PASS.

- [x] **Step 9: Review checkpoint**

Run `git diff --check` and inspect only Task 1 files. Do not commit.

---

### Task 2: Page Command and DOM Action Feedback

**Files:**

- Modify: `src/page/browser-command-handler.ts`
- Modify: `src/page/dom-action-handler.ts`
- Modify: `tests/page/browser-command-handler.test.ts`
- Modify: `tests/browser/act/dom-action-driver.test.ts`

**Interfaces:**

- Consumes `PageActionFeedback` and `getActionFeedbackOverlay(document)` from Task 1.
- Extends `PageCommandEnvironment` and `DomActionEnvironment` with an optional `{ show(feedback): void }` sink.

- [x] **Step 1: Add failing page-command tests**

Inject a feedback stub and assert a validated command reaches it:

```ts
const show = vi.fn();
const response = await handlePageCommand(
  {
    version: 1,
    requestId: "feedback_click",
    type: "page.actionFeedback",
    payload: { kind: "click", x: 30, y: 40 },
  },
  { document, window, feedback: { show } },
);
expect(show).toHaveBeenCalledWith({ kind: "click", x: 30, y: 40 });
expect(response).toMatchObject({ ok: true, data: { displayed: true } });
```

- [x] **Step 2: Add failing DOM feedback tests**

Pass a `show` spy into `executeDomAction` and assert:

- click emits the button's live center as `click`;
- hover emits `move`;
- changed check emits `click`, already-matching check emits nothing;
- drag emits exact source/destination centers;
- a throwing feedback sink does not change returned action evidence.

- [x] **Step 3: Run Task 2 tests and confirm RED**

Run:

```bash
npm run test:run -- tests/page/browser-command-handler.test.ts tests/browser/act/dom-action-driver.test.ts
```

Expected: FAIL because the environments do not accept or invoke feedback.

- [x] **Step 4: Route page commands to the overlay**

Before parsing `page.domAction`, handle `page.actionFeedback` by calling the injected sink or `getActionFeedbackOverlay(environment.document)`. Return `{ displayed: boolean }`; absence of an overlay is a successful no-op.

Pass the same sink into `executeDomAction` for DOM actions.

- [x] **Step 5: Emit best-effort DOM feedback from live rectangles**

Add a center helper and a no-throw notifier:

```ts
function notifyFeedback(
  environment: DomActionEnvironment,
  feedback: PageActionFeedback,
): void {
  try {
    environment.feedback?.show(feedback);
  } catch {
    // Visual feedback must never affect the browser action.
  }
}
```

Invoke it only for click, changed check, hover, and drag using the freshly resolved elements.

- [x] **Step 6: Run Task 2 tests and confirm GREEN**

Run the Task 2 command again. Expected: PASS.

- [x] **Step 7: Review checkpoint**

Run `git diff --check` and inspect Task 2 changes. Do not commit.

---

### Task 3: CDP Feedback Port and Driver Integration

**Files:**

- Modify: `src/browser/act/cdp-action-driver.ts`
- Create: `src/platform/chrome/action-feedback-port.ts`
- Modify: `src/entries/background.ts`
- Modify: `tests/browser/act/cdp-action-driver.test.ts`
- Create: `tests/platform/chrome/action-feedback-port.test.ts`

**Interfaces:**

- Produces `CdpActionFeedbackPort.notify(tabId, feedback): void` as an optional driver dependency.
- Produces `ChromeActionFeedbackPort`, which maps notifications to strict `page.actionFeedback` messages.

- [x] **Step 1: Add failing CDP driver tests**

Inject `{ notify: vi.fn() }` and assert:

```ts
expect(notify).toHaveBeenCalledWith(7, { kind: "click", x: 50, y: 20 });
expect(notify).toHaveBeenCalledWith(7, {
  kind: "drag",
  fromX: 50,
  fromY: 20,
  toX: 50,
  toY: 20,
});
```

Add separate cases proving hover emits `move`, a child `cdpSessionId` emits no feedback, and a synchronously throwing notifier does not alter CDP dispatch or evidence.

- [x] **Step 2: Add a failing Chrome adapter test**

Assert `notify` immediately sends a versioned, correlated `page.actionFeedback` command and safely consumes a rejected `sendMessage` promise.

- [x] **Step 3: Run Task 3 tests and confirm RED**

Run:

```bash
npm run test:run -- tests/browser/act/cdp-action-driver.test.ts tests/platform/chrome/action-feedback-port.test.ts
```

Expected: FAIL because the feedback port does not exist.

- [x] **Step 4: Implement the Chrome feedback adapter**

The adapter accepts an injectable tab message port and performs a fire-and-forget send:

```ts
notify(tabId: number, feedback: PageActionFeedback): void {
  const command: PageCommand = {
    version: PROTOCOL_VERSION,
    requestId: `action_feedback_${crypto.randomUUID()}`,
    type: 'page.actionFeedback',
    payload: feedback,
  };
  void this.messages.sendMessage(tabId, command).catch(() => undefined);
}
```

- [x] **Step 5: Add best-effort CDP notifications**

Add the optional feedback dependency. Notify only when `sessionId === undefined`; use the exact live `quadCenter` points already used by `Input.dispatchMouseEvent`. Emit click from the shared click helper, move from hover, and drag before the press/move/release sequence. Wrap notifier calls in `try/catch` without awaiting them.

- [x] **Step 6: Compose the adapter in the background entrypoint**

Construct one `ChromeActionFeedbackPort` and inject it into `CdpActionDriver` together with `systemClock` and a minimal `getUrl` tab port. Keep `background.ts` limited to dependency construction.

- [x] **Step 7: Run Task 3 tests and confirm GREEN**

Run the Task 3 command again. Expected: PASS.

- [x] **Step 8: Review checkpoint**

Run `git diff --check` and inspect Task 3 changes. Do not commit.

---

### Task 4: Normative Documentation Synchronization

**Files:**

- Modify: `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`
- Modify: `docs/superpowers/specs/2026-08-16-agent-action-feedback-design.md`
- Modify: `docs/architecture.md`
- Modify: `docs/user-guide.md`

**Interfaces:**

- Documents the new allowed page UI and strict page command without changing task/browser contracts.

- [x] **Step 1: Update the main design specification**

Add the Agent pointer/ripple overlay to section 4.2. State that it is transient, pointer-transparent, excluded from captures, and informational only. Add `page.actionFeedback` to the page-command list in the protocol section.

- [x] **Step 2: Update architecture and user documentation**

Describe the action feedback overlay beside selection/screenshot overlays, its registry-based capture hiding, DOM-local/CDP-message flows, and the child-session limitation. Add one user-facing sentence explaining that pointer actions briefly show a cursor and ripple.

- [x] **Step 3: Mark the incremental design implemented after tests pass**

Change its status from `已批准，待实现` to `已实现，待完整发布门槛验证` only after Tasks 1–3 are green.

- [x] **Step 4: Review checkpoint**

Run:

```bash
rg -n "page.actionFeedback|操作反馈|虚拟光标|水波纹" docs
git diff --check
```

Expected: the protocol and page UI changes are described consistently; no whitespace errors. Do not commit.

---

### Task 5: Focused and Full Verification

**Files:**

- No new production files.
- Format only files changed by this plan.

**Interfaces:**

- Verifies all feature contracts and records pre-existing repository gate failures separately.

- [x] **Step 1: Format touched files**

Run Prettier only on the exact files changed in Tasks 1–4. Do not run a repository-wide write.

- [x] **Step 2: Run focused tests**

Run:

```bash
npm run test:run -- \
  tests/shared/protocol/parse-message.test.ts \
  tests/page/action-feedback/action-feedback-overlay.test.ts \
  tests/page/browser-command-handler.test.ts \
  tests/browser/act/dom-action-driver.test.ts \
  tests/browser/act/cdp-action-driver.test.ts \
  tests/platform/chrome/action-feedback-port.test.ts
```

Expected: all focused tests pass.

- [x] **Step 3: Run deterministic repository checks under Node 24.18**

Run:

```bash
npx --yes --package=node@24.18.0 --package=npm@11.17.0 -c \
  'npm run lint && npm run typecheck && npm run test:run && npm run build && npm run audit:bundle'
```

Expected: all commands pass. Run `npm run format:check` separately and report the known repository-wide baseline if untouched files still fail.

- [x] **Step 4: Inspect final diff and status**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Confirm no credentials, generated build output, benchmark artifacts, commits, or unrelated refactors were introduced.
