# ChatBrowserX Conversation-First Side Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved native Side Panel experience with page context, conversation, embedded durable task progress, image/screenshot composer, history, recovery, settings, permissions, localization, and accessible light/dark layouts.

**Architecture:** A small Side Panel client store receives a full snapshot and versioned incremental events from the Service Worker. React components render domain view models and send commands; they do not orchestrate model/tool loops or access Provider credentials directly.

**Tech Stack:** React 19, CSS with component-scoped class naming and `light-dark()`, Lucide React, Testing Library, runtime protocol and page/attachment services from earlier plans.

**Spec:** Read `docs/superpowers/specs/browser-agent-project-spec.md` first; its approved normative body is `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`.

## Global Constraints

- Implement the selected “专注对话” layout, not the rejected workspace or compact-rail variants.
- Keep task state embedded in the conversation; do not add a permanent dashboard.
- Keep full UI inside Chrome Side Panel; page UI remains limited to screenshot/selection/transient hints.
- Never read credentials from content scripts or expose raw tokens in React state snapshots.
- Use native semantic controls and keyboard behavior.
- Support widths from 320 px upward, light/dark mode, Chinese/English/Japanese/system language.
- Do not add voice, audio, PDF/print, OpenAI-compatible, or generic Provider UI.
- Do not commit or push.

---

### Task 1: Side Panel Client Store and Snapshot/Event Synchronization

**Files:**

- Create: `src/side-panel/state/panel-state.ts`
- Create: `src/side-panel/state/panel-view-model.ts`
- Create: `src/side-panel/state/panel-client.ts`
- Create: `src/side-panel/state/use-panel-store.ts`
- Modify: `src/shared/protocol/message-types.ts`
- Modify: `src/shared/protocol/message-schema.ts`
- Modify: `src/platform/chrome/message-router.ts`
- Create: `tests/side-panel/state/panel-client.test.ts`
- Create: `tests/side-panel/state/panel-view-model.test.ts`

**Interfaces:**

- Consumes: task/conversation/message/attachment repositories, runtime port.
- Produces: `PanelClient.connect(tabId)`, `PanelStore.subscribe/getSnapshot/send`, sanitized `PanelViewModel`.

- [ ] **Step 1: Write failing snapshot/reconnect tests**

Test initial loading, snapshot sequence 10 followed by events 11/12, duplicate event 12, gap from 12 to 14 causing resync, port disconnect, reconnection, active tab change, and stale async response rejection.

```ts
client.receive(snapshot({ sequence: 10, taskStatus: 'acting' }));
client.receive(event({ sequence: 11, type: 'task.verifying' }));
client.receive(event({ sequence: 11, type: 'task.verifying' }));
expect(client.getSnapshot().sequence).toBe(11);
expect(requestSnapshot).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run state tests and confirm failure**

Run `npm run test:run -- tests/side-panel/state`.

Expected: FAIL.

- [ ] **Step 3: Add versioned panel snapshot/event protocol**

Add `panel.connect`, `panel.getSnapshot`, `panel.command`, `panel.snapshot`, and `panel.event`. Each payload includes `tabId`, monotonically increasing `sequence`, and only sanitized view models. Credential settings use booleans `hasCodexToken` and `hasTavilyKey`; raw values are available only in an explicit settings-edit response to the trusted Side Panel request.

- [ ] **Step 4: Implement an external store without Redux**

Use an immutable state object and `useSyncExternalStore`. Keep one runtime port, reconnect with delays 250 ms, 500 ms, 1 s, and 2 s capped at 2 s, and request a fresh snapshot after every reconnect or sequence gap. Dispose timers/listeners on unmount.

- [ ] **Step 5: Verify synchronization**

Run:

```bash
npm run test:run -- tests/side-panel/state
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Inspect the view model types and confirm no Token/Key value is present outside the explicit trusted settings editor call. Do not commit.

---

### Task 2: Product Shell, Page Context, and Visual Tokens

**Files:**

- Create: `src/side-panel/components/AppShell.tsx`
- Create: `src/side-panel/components/TopBar.tsx`
- Create: `src/side-panel/components/PageContext.tsx`
- Create: `src/side-panel/components/IconButton.tsx`
- Create: `src/side-panel/styles/tokens.css`
- Create: `src/side-panel/styles/base.css`
- Create: `src/side-panel/styles/shell.css`
- Modify: `src/side-panel/App.tsx`
- Modify: `src/entries/side-panel/main.tsx`
- Delete after migration: `src/side-panel/app.css`
- Create: `tests/side-panel/components/AppShell.test.tsx`
- Create: `tests/side-panel/components/PageContext.test.tsx`

**Interfaces:**

- Consumes: `PanelViewModel` and command callbacks.
- Produces: approved shell regions and navigation to conversation/history/settings.

- [ ] **Step 1: Write failing shell tests**

Assert one `main`, one top bar, product name, New Task/History/Settings accessible buttons, current page title/domain, permission state, Debugger connection state, and unsupported-page message. At 320 px equivalent container width, controls must remain in DOM without a horizontal-scroll class.

- [ ] **Step 2: Run component tests and confirm failure**

Run `npm run test:run -- tests/side-panel/components/AppShell.test.tsx tests/side-panel/components/PageContext.test.tsx`.

Expected: FAIL.

- [ ] **Step 3: Implement restrained theme-aware tokens**

Define product-scoped variables for panel/background/raised surfaces, text/muted text, divider, blue accent, success/warning/danger, 8/12 px radii, and spacing from 4–20 px. Use system font stack and only weights 400/500. Use `color-scheme: light dark` and `light-dark()`; do not hard-code a white-only shell or use gradients.

- [ ] **Step 4: Implement the shell matching approved layout A**

Top bar stays compact and contains logo/name plus labeled tooltips for New Task, History, and Settings. Page context is one quiet row with globe icon, ellipsized title/domain, permission dot, and optional `Debugger 已连接` text. Main content and composer use grid rows `auto minmax(0, 1fr) auto`; only the message region scrolls.

- [ ] **Step 5: Verify shell components**

Run:

```bash
npm run test:run -- tests/side-panel/components/AppShell.test.tsx tests/side-panel/components/PageContext.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Render at 320, 360, and 480 px in the browser during Plan 6; for now inspect CSS for fixed outer widths, viewport height, and horizontal overflow. None may exist. Do not commit.

---

### Task 3: Conversation, Streaming Messages, and Embedded Task Card

**Files:**

- Create: `src/side-panel/chat/ConversationView.tsx`
- Create: `src/side-panel/chat/MessageList.tsx`
- Create: `src/side-panel/chat/MessageItem.tsx`
- Create: `src/side-panel/chat/MessageActions.tsx`
- Create: `src/side-panel/tasks/TaskProgressCard.tsx`
- Create: `src/side-panel/tasks/TaskAttemptDetails.tsx`
- Create: `src/side-panel/tasks/TaskStatusLabel.tsx`
- Create: `src/side-panel/styles/conversation.css`
- Create: `src/side-panel/styles/task-card.css`
- Create: `tests/side-panel/chat/ConversationView.test.tsx`
- Create: `tests/side-panel/chat/MessageItem.test.tsx`
- Create: `tests/side-panel/tasks/TaskProgressCard.test.tsx`

**Interfaces:**

- Consumes: sanitized messages, task/step/attempt view models.
- Produces: streaming conversation UI, copy/retry actions, expandable progress evidence.

- [ ] **Step 1: Write failing conversation-state tests**

Cover empty state, user/assistant/system/error messages, streaming text, interrupted text, completed text, copy, retry, task states, latest step, attempt expansion, and autoscroll only when the user is already near the bottom.

```tsx
render(<TaskProgressCard task={runningTask} />);
expect(screen.getByText('正在操作当前页面')).toBeVisible();
expect(screen.getByText('设置注册时间')).toBeVisible();
await user.click(screen.getByRole('button', { name: '查看执行详情' }));
expect(screen.getByText(/DOM 动作未产生变化/)).toBeVisible();
```

- [ ] **Step 2: Run conversation tests and confirm failure**

Run `npm run test:run -- tests/side-panel/chat tests/side-panel/tasks`.

Expected: FAIL.

- [ ] **Step 3: Implement message rendering and bounded markdown**

Render plain text and a restricted markdown subset: paragraphs, lists, inline code, fenced code, links with `rel="noreferrer noopener"`, and no raw HTML. Add copy and retry buttons on completed/interrupted assistant messages. Keep partial and replacement model attempts visually distinct until replacement completes.

- [ ] **Step 4: Implement the embedded task card**

Collapsed state shows status dot, current step, completed/total count, last activity, and pause/continue/cancel control. Expanded state lists steps and attempts with driver, verification result, elapsed time, and normalized failure reason; it never displays raw page HTML, token values, or full model payloads.

- [ ] **Step 5: Implement stable scroll behavior**

Use a bottom sentinel. Auto-follow new content only when the sentinel was intersecting before the update. When the user has scrolled upward, show a `跳到最新` button rather than forcing scroll.

- [ ] **Step 6: Verify conversation and task UI**

Run:

```bash
npm run test:run -- tests/side-panel/chat tests/side-panel/tasks
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Confirm ordinary chat with no task does not render an empty task dashboard. Do not commit.

---

### Task 4: Composer, Image/Screenshot Controls, and Send/Stop Semantics

**Files:**

- Create: `src/side-panel/chat/ChatComposer.tsx`
- Create: `src/side-panel/chat/use-chat-draft.ts`
- Create: `src/side-panel/chat/ComposerToolbar.tsx`
- Create: `src/side-panel/styles/composer.css`
- Modify: `src/side-panel/chat/ImageAttachmentStrip.tsx`
- Modify: `src/side-panel/chat/ImagePreviewDialog.tsx`
- Create: `tests/side-panel/chat/ChatComposer.test.tsx`
- Create: `tests/side-panel/chat/ComposerToolbar.test.tsx`

**Interfaces:**

- Consumes: image draft hook, screenshot controller commands, panel commands.
- Produces: message/task creation, stop command, keyboard behavior.

- [ ] **Step 1: Write failing composer behavior tests**

Test text-only send, image-only send, mixed send, pasted images, file selection, region/viewport screenshot commands, multiple previews, disabled state, stop while running, Cmd/Ctrl+Enter send, plain Enter newline, Backspace image removal when text is empty, and draft preservation after a failed send.

- [ ] **Step 2: Run composer tests and confirm failure**

Run `npm run test:run -- tests/side-panel/chat/ChatComposer.test.tsx tests/side-panel/chat/ComposerToolbar.test.tsx`.

Expected: FAIL.

- [ ] **Step 3: Implement the approved composer layout**

Place the attachment strip above a growing textarea. Below it, show visibly labeled `图片` and `截图` secondary controls and a right-aligned primary `发送` or `停止` button. The screenshot button opens a two-item menu: `区域截图` and `当前视口`.

Textarea grows from one to ten lines, then scrolls internally. File input is visually hidden but has label `添加图片` and `accept="image/png,image/jpeg,image/webp,image/gif"` with `multiple`.

- [ ] **Step 4: Implement send/stop consistency**

Create one client command containing text and attachment IDs. Clear the draft only after the background acknowledges task/message creation. While a task is running, keep text editable for the next message but make the primary action `停止`; stop maps to task cancellation and does not delete the current draft.

- [ ] **Step 5: Verify composer UI**

Run:

```bash
npm run test:run -- tests/side-panel/chat/ChatComposer.test.tsx tests/side-panel/chat/ComposerToolbar.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Confirm screenshot/image controls remain visible at 320 px and speech/PDF controls do not exist. Do not commit.

---

### Task 5: History, Recovery, Confirmation, Permissions, and Settings

**Files:**

- Create: `src/side-panel/history/HistoryView.tsx`
- Create: `src/side-panel/history/HistoryItem.tsx`
- Create: `src/side-panel/recovery/RecoveryCard.tsx`
- Create: `src/side-panel/recovery/ConfirmationCard.tsx`
- Create: `src/side-panel/permissions/OriginPermissionCard.tsx`
- Create: `src/side-panel/settings/SettingsView.tsx`
- Create: `src/side-panel/settings/SecretField.tsx`
- Create: `src/side-panel/settings/settings-schema.ts`
- Create: `src/side-panel/styles/forms.css`
- Create: `tests/side-panel/history/HistoryView.test.tsx`
- Create: `tests/side-panel/recovery/RecoveryCard.test.tsx`
- Create: `tests/side-panel/recovery/ConfirmationCard.test.tsx`
- Create: `tests/side-panel/permissions/OriginPermissionCard.test.tsx`
- Create: `tests/side-panel/settings/SettingsView.test.tsx`

**Interfaces:**

- Consumes: panel commands, `ConversationRepository`, `AttachmentRepository`, and trusted settings API.
- Produces: per-tab history selection/clear/rebind, restart resume, action confirmation, origin grant, Codex/Tavily settings.

- [ ] **Step 1: Write failing history and recovery tests**

Test per-tab grouping, completed/paused/failed labels, selecting an old conversation, creating a new conversation, clearing one terminal conversation after confirmation, rejecting clear while its task is running, missing-tab rebind, safe browser/worker restart auto-recovery, expired-auth settings link, and high-risk confirmation showing exact target/action summary. After clear, assert message/task records are gone and only now-unreferenced attachments older than the garbage-collection grace period are deleted.

- [ ] **Step 2: Write failing settings and permission tests**

Test Codex Access Token, model, effort (`low`, `medium`, `high`, `xhigh`), system prompt, Tavily Key, language, masked secret reveal, save, validation, auth-error preservation, and current-origin permission grant/denial. Assert there are no Base URL, API Key, voice, PDF, or print fields.

- [ ] **Step 3: Run tests and confirm failure**

Run `npm run test:run -- tests/side-panel/history tests/side-panel/recovery tests/side-panel/permissions tests/side-panel/settings`.

Expected: FAIL.

- [ ] **Step 4: Implement history and recovery cards**

History is a replacement view reached from the top bar, not a permanent third column. `新建任务` creates a fresh conversation bound to the active tab. One conversation may have at most one non-terminal task: the background rejects a second submit before appending its message, and the composer retains but cannot send a draft until the current task is continued, confirmed, cancelled, or terminal. `清空对话` requires confirmation, is disabled until its active task is cancelled, calls the transactional conversation clear command, then runs attachment garbage collection with a 24-hour grace period so unsent drafts are not raced. Recovery card actions are `继续`, `取消`, and when needed `绑定当前标签页`. Confirmation card hashes action content in the command and offers `确认执行` and `取消这一步`; editing the planned target invalidates the confirmation.

- [ ] **Step 5: Implement origin permission UX**

Explain the exact origin before calling `chrome.permissions.request` from the click handler. Show separate text for page access and the permanently declared Debugger permission. Denial leaves chat available but pauses browser tasks with `PermissionDenied`.

- [ ] **Step 6: Implement settings without generic Provider UI**

Secrets load masked and are updated only when changed. Save validates nonblank Access Token, a nonblank model, effort enum, system prompt max 20,000 characters, and optional nonblank Tavily Key. Restore-default resets model/effort/system prompt/language but never deletes credentials without a separate confirmation.

- [ ] **Step 7: Verify history/recovery/settings**

Run:

```bash
npm run test:run -- tests/side-panel/history tests/side-panel/recovery tests/side-panel/permissions tests/side-panel/settings
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Search visible copy for OpenAI-compatible, Base URL, voice, speech, print, and PDF. None may be present. Do not commit.

---

### Task 6: Localization, Accessibility, and Side Panel Integration

**Files:**

- Create: `src/shared/i18n/locales.ts`
- Create: `src/shared/i18n/messages.zh-CN.ts`
- Create: `src/shared/i18n/messages.en.ts`
- Create: `src/shared/i18n/messages.ja.ts`
- Create: `src/shared/i18n/i18n.ts`
- Create: `src/side-panel/accessibility/focus-manager.ts`
- Modify: all Side Panel and page feature components to use message keys
- Modify: `src/side-panel/App.tsx`
- Create: `tests/shared/i18n/i18n.test.ts`
- Create: `tests/side-panel/App.test.tsx`

**Interfaces:**

- Consumes: language setting and every approved component.
- Produces: `translate(key, params?)`, complete localized UI, focus restoration.

- [ ] **Step 1: Write failing locale parity and focus tests**

Assert all three catalogs have identical keys, missing keys throw in tests, system language mapping handles `zh-*`, `en-*`, `ja-*`, unknown languages fall back to English, and opening/closing history/settings/dialogs moves and restores focus correctly.

- [ ] **Step 2: Run tests and confirm failure**

Run `npm run test:run -- tests/shared/i18n tests/side-panel/App.test.tsx`.

Expected: FAIL.

- [ ] **Step 3: Implement typed message catalogs**

Export the Chinese catalog `as const`, derive `MessageKey = keyof typeof zhCN`, and declare English/Japanese with `satisfies Record<MessageKey, string>`. Interpolate only named string/number parameters and HTML-escape nothing because React renders returned strings as text.

- [ ] **Step 4: Complete keyboard and screen-reader behavior**

Use native buttons/inputs/dialog semantics, visible focus rings, `aria-live="polite"` for status and streaming completion, `aria-live="assertive"` only for blocking errors, Escape for dismissible overlays, and no positive `tabIndex`. Respect `prefers-reduced-motion`.

- [ ] **Step 5: Verify the complete Side Panel plan**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
git diff --check
```

Expected: all pass; all visible UI is localized, and the extension builds one native Side Panel rather than an injected full sidebar. Do not commit.
