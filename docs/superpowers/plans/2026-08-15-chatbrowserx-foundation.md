# ChatBrowserX Foundation and Durable Task Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a loadable Chrome MV3 extension with strict tooling, an empty conversation-first Side Panel, typed runtime messages, durable task state, IndexedDB repositories, trusted credential storage, leases, and restart recovery scanning.

**Architecture:** CRXJS builds a Side Panel page and an MV3 Service Worker. Pure task transitions live outside Chrome and storage code; idb-backed repositories implement the domain interfaces, while the Service Worker only wires messages, alarms, and recovery triggers.

**Tech Stack:** Node.js 24.18.0 LTS, npm 11, TypeScript 6.0.3, React 19.2.8, Vite 7.3.6, CRXJS 2.7.1, Zod 4.4.3, idb 8.0.3, Vitest 4.1.10, jsdom 30.0.1.

**Spec:** Read `docs/superpowers/specs/browser-agent-project-spec.md` first; its approved normative body is `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`.

## Global Constraints

- Read the spec and `docs/superpowers/plans/2026-08-15-chatbrowserx-rebuild-roadmap.md` before editing.
- Do not copy old implementation code or import old storage keys.
- Do not create commits or push; finish each task with the review checkpoint shown below.
- Keep entrypoints free of business logic.
- Use pure transitions and dependency injection for time, IDs, repositories, and Chrome APIs.
- Keep credentials out of IndexedDB, content scripts, events, and errors.
- The extension must build without OpenAI-compatible, speech, audio, PDF, printing, or offscreen-document entries.

---

### Task 1: Strict Toolchain and Loadable MV3 Shell

**Files:**

- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `.prettierignore`
- Create: `.prettierrc.json`
- Create: `package.json`
- Create: `package-lock.json` through `npm install`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `manifest.config.ts`
- Create: `src/vite-env.d.ts`
- Create: `src/entries/background.ts`
- Create: `src/entries/side-panel/index.html`
- Create: `src/entries/side-panel/main.tsx`
- Create: `src/side-panel/App.tsx`
- Create: `src/side-panel/app.css`
- Create: `tests/setup.ts`
- Create: `tests/manifest.test.ts`

**Interfaces:**

- Consumes: none.
- Produces: named `manifest` export; Chrome build in `dist/`; React `App`; scripts used by all later plans.

- [x] **Step 1: Add the pinned package and compiler configuration**

Create `.nvmrc` containing `24.18.0`. Create `package.json` with these exact scripts and dependency floors:

```json
{
  "name": "chatbrowserx",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.18.0 <25" },
  "scripts": {
    "dev": "vite",
    "build": "npm run typecheck && vite build",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint . --max-warnings=0",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:run": "vitest run",
    "test:e2e": "playwright test",
    "check:codex": "tsx scripts/check-codex-contract.ts"
  },
  "dependencies": {
    "idb": "8.0.3",
    "lucide-react": "1.31.0",
    "react": "19.2.8",
    "react-dom": "19.2.8",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "2.7.1",
    "@eslint/js": "10.0.1",
    "@playwright/test": "1.62.1",
    "@testing-library/jest-dom": "7.0.1",
    "@testing-library/react": "16.3.2",
    "@testing-library/user-event": "14.6.4",
    "@types/chrome": "0.2.6",
    "@types/node": "24.13.3",
    "@types/react": "19.2.18",
    "@types/react-dom": "19.2.4",
    "@vitejs/plugin-react": "5.2.0",
    "eslint": "10.8.1",
    "fake-indexeddb": "6.2.5",
    "globals": "17.11.0",
    "jsdom": "30.0.1",
    "prettier": "3.9.6",
    "tsx": "4.23.12",
    "typescript": "6.0.3",
    "typescript-eslint": "8.67.0",
    "vite": "7.3.6",
    "vitest": "4.1.10"
  }
}
```

Use `ES2023`, `moduleResolution: "Bundler"`, `jsx: "react-jsx"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`, `useUnknownInCatchVariables: true`, and types `chrome`, `vite/client`, `vitest/globals`, and `@testing-library/jest-dom` in `tsconfig.json`.

Run:

```bash
npm install
```

Expected: `package-lock.json` is generated with no engine mismatch under Node 24.18.0.

- [x] **Step 2: Write the manifest test before the manifest exists**

Create `tests/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { manifest } from '../manifest.config';

describe('extension manifest', () => {
  it('declares only the approved MV3 permissions and entries', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('125');
    expect(manifest.permissions).toEqual([
      'activeTab',
      'alarms',
      'debugger',
      'scripting',
      'sidePanel',
      'storage',
      'tabs',
    ]);
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(JSON.stringify(manifest)).not.toMatch(/offscreen|tabCapture|audio|speech|pdf/i);
  });
});
```

- [x] **Step 3: Run the focused test and confirm the red state**

Run:

```bash
npm run test:run -- tests/manifest.test.ts
```

Expected: FAIL because `manifest.config.ts` does not exist.

- [x] **Step 4: Implement the manifest, build config, entrypoints, and minimal Side Panel**

Export a named plain object before passing it to `defineManifest`:

```ts
import { defineManifest } from '@crxjs/vite-plugin';

export const manifest = {
  manifest_version: 3,
  minimum_chrome_version: '125',
  name: 'ChatBrowserX',
  description: 'A durable browser agent in Chrome Side Panel.',
  version: '0.1.0',
  permissions: ['activeTab', 'alarms', 'debugger', 'scripting', 'sidePanel', 'storage', 'tabs'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  host_permissions: ['https://chatgpt.com/*', 'https://api.tavily.com/*'],
  background: { service_worker: 'src/entries/background.ts', type: 'module' },
  side_panel: { default_path: 'src/entries/side-panel/index.html' },
  action: { default_title: 'Open ChatBrowserX' },
} as const;

export default defineManifest(manifest);
```

Configure Vite with `react()` and `crx({ manifest })`. In `background.ts`, set `openPanelOnActionClick: true` inside an `onInstalled` listener. Render this exact accessible shell in `App.tsx`:

```tsx
export function App() {
  return (
    <main className="app-shell">
      <header className="top-bar">
        <span className="brand-mark" aria-hidden="true">
          ✦
        </span>
        <strong>ChatBrowserX</strong>
      </header>
      <section className="empty-state" aria-labelledby="empty-title">
        <h1 id="empty-title">今天要在这个页面完成什么？</h1>
        <p>任务、恢复状态和浏览器操作会显示在这里。</p>
      </section>
    </main>
  );
}
```

- [x] **Step 5: Verify the shell**

Run:

```bash
npm run format
npm run lint
npm run typecheck
npm run test:run -- tests/manifest.test.ts
npm run build
```

Expected: all commands pass; `dist/manifest.json` references a Service Worker and Side Panel and contains no static content script.

- [x] **Step 6: Review checkpoint**

Run `git diff --check` and `git status --short`. Confirm only Task 1 files and generated lockfile are present. Do not commit.

---

### Task 2: Versioned Runtime Message Protocol

**Files:**

- Create: `src/shared/protocol/message-types.ts`
- Create: `src/shared/protocol/message-schema.ts`
- Create: `src/shared/protocol/parse-message.ts`
- Create: `src/shared/protocol/index.ts`
- Create: `tests/shared/protocol/parse-message.test.ts`

**Interfaces:**

- Consumes: Zod.
- Produces: `ExtensionMessage`, `ExtensionResponse`, `parseExtensionMessage(value: unknown): ExtensionMessage`, `PROTOCOL_VERSION = 1`.

- [x] **Step 1: Write failing boundary-validation tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseExtensionMessage } from '../../../src/shared/protocol/parse-message';

describe('parseExtensionMessage', () => {
  it('accepts a versioned task snapshot request', () => {
    expect(
      parseExtensionMessage({
        version: 1,
        requestId: 'req_1',
        type: 'task.getSnapshot',
        payload: { taskId: 'task_1' },
      }),
    ).toMatchObject({ type: 'task.getSnapshot' });
  });

  it('rejects unknown versions and extra credential fields', () => {
    expect(() =>
      parseExtensionMessage({
        version: 2,
        requestId: 'req_1',
        type: 'task.getSnapshot',
        payload: { taskId: 'task_1', accessToken: 'secret' },
      }),
    ).toThrow(/invalid extension message/i);
  });
});
```

- [x] **Step 2: Run the test and confirm failure**

Run `npm run test:run -- tests/shared/protocol/parse-message.test.ts`.

Expected: FAIL because the parser is missing.

- [x] **Step 3: Implement strict message schemas**

Define `PROTOCOL_VERSION = 1` and a `z.discriminatedUnion('type', ...)` covering these first messages:

```ts
export type ExtensionMessage =
  | Message<'system.ping', Record<string, never>>
  | Message<'task.create', { tabId: number; conversationId: string; goal: string }>
  | Message<'task.getSnapshot', { taskId: string }>
  | Message<'task.pause', { taskId: string }>
  | Message<'task.resume', { taskId: string; tabId?: number }>
  | Message<'task.confirm', { taskId: string; actionDigest: string }>
  | Message<'task.cancel', { taskId: string }>;

export interface Message<TType extends string, TPayload> {
  version: 1;
  requestId: string;
  type: TType;
  payload: TPayload;
}
```

Every Zod object must use `.strict()`. Implement `parseExtensionMessage` so it throws `Error('Invalid extension message: ...')` without including full input payloads.

- [x] **Step 4: Verify protocol behavior**

Run:

```bash
npm run test:run -- tests/shared/protocol/parse-message.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Review checkpoint**

Run `git diff --check` and inspect the new protocol files. Confirm no token/key field exists in content-script-addressable messages. Do not commit.

---

### Task 3: Pure Task Domain and Transition Policy

**Files:**

- Create: `src/shared/ids.ts`
- Create: `src/shared/time.ts`
- Create: `src/tasks/conversation-types.ts`
- Create: `src/tasks/message-types.ts`
- Create: `src/tasks/checkpoint-types.ts`
- Create: `src/tasks/task-types.ts`
- Create: `src/tasks/task-errors.ts`
- Create: `src/tasks/task-transition.ts`
- Create: `src/tasks/task-factory.ts`
- Create: `src/tasks/task-budget.ts`
- Create: `tests/tasks/task-transition.test.ts`
- Create: `tests/tasks/task-budget.test.ts`
- Create: `tests/tasks/task-records.test.ts`

**Interfaces:**

- Consumes: `Clock`, `IdGenerator`.
- Produces: `Conversation`, `MessageRecord`, `TaskRun`, `Checkpoint`, `TaskStatus`, `TaskEvent`, `transitionTask`, `createTask`, `DEFAULT_TASK_BUDGET`, `consumeBrowserAction`.

- [x] **Step 1: Write failing transition and budget tests**

```ts
import { describe, expect, it } from 'vitest';
import { createTask } from '../../src/tasks/task-factory';
import { transitionTask } from '../../src/tasks/task-transition';
import { consumeBrowserAction, DEFAULT_TASK_BUDGET } from '../../src/tasks/task-budget';

const clock = { now: () => 1_000 };
const ids = { create: (prefix: string) => `${prefix}_1` };

describe('task domain', () => {
  it('creates a queued per-tab task and enters observing', () => {
    const task = createTask(
      { conversationId: 'conv_1', tabId: 7, goal: 'Fill the form' },
      { clock, ids },
    );
    expect(task.status).toBe('queued');
    expect(transitionTask(task, { type: 'observation.started', at: 1_001 }).status).toBe(
      'observing',
    );
  });

  it('rejects transitions out of terminal states', () => {
    const task = {
      ...createTask({ conversationId: 'conv_1', tabId: 7, goal: 'x' }, { clock, ids }),
      status: 'completed' as const,
    };
    expect(() => transitionTask(task, { type: 'observation.started', at: 1_001 })).toThrow(
      /illegal task transition/i,
    );
  });

  it('pauses when the 50-action budget is exhausted', () => {
    expect(consumeBrowserAction({ ...DEFAULT_TASK_BUDGET, browserActionsUsed: 49 })).toMatchObject({
      browserActionsUsed: 50,
      exhausted: true,
    });
  });
});
```

In `task-records.test.ts`, validate that message roles/statuses are closed unions, attachment IDs are references rather than Blob/data URLs, checkpoints point to one task, checkpoint action digests are immutable, and every event has an increasing integer sequence.

- [x] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npm run test:run -- tests/tasks/task-transition.test.ts tests/tasks/task-budget.test.ts
```

Expected: FAIL because domain modules do not exist.

- [x] **Step 3: Implement immutable task types and the transition table**

Define the durable record boundaries before implementing transitions:

```ts
export interface Conversation {
  id: ConversationId;
  tabId: number | null;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRecord {
  id: MessageId;
  conversationId: ConversationId;
  taskId: TaskId | null;
  role: 'user' | 'assistant' | 'system';
  status: 'complete' | 'streaming' | 'interrupted' | 'error';
  text: string;
  attachmentIds: AttachmentId[];
  createdAt: number;
  updatedAt: number;
}
```

`Checkpoint` stores completed tool results, latest bounded observation reference, pending action intent/evidence, Provider turn state, and timestamp. `TaskEvent` stores task ID, integer sequence, discriminated event payload, reason, and timestamp. Current UI progress is derived from these events; the schema does not reserve unused step/attempt records. None of these records may contain credential values, raw page HTML, screenshot bytes, or an unbounded model response.

Use the exact statuses from the roadmap. `TaskRun` must include:

```ts
export interface TaskRun {
  id: TaskId;
  conversationId: ConversationId;
  tabId: number | null;
  goal: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  checkpointId: string | null;
  lease: TaskLease | null;
  budget: TaskBudget;
  lastError: TaskError | null;
}
```

Implement an explicit `Record<TaskStatus, ReadonlySet<TaskEvent['type']>>` allowlist. `transitionTask` returns a new object and never mutates input. Terminal states accept no new events. Map missing tab, auth failure, uncertain high-risk action, pause, completion, failure, and cancellation to their dedicated states.

- [x] **Step 4: Implement exact budget defaults**

```ts
export const DEFAULT_TASK_BUDGET: TaskBudget = {
  browserActionsLimit: 50,
  browserActionsUsed: 0,
  actionAttemptsLimit: 3,
  replansLimit: 2,
  replansUsed: 0,
  wallClockLimitMs: 20 * 60 * 1_000,
};
```

Return `{ ...budget, browserActionsUsed, exhausted }` from `consumeBrowserAction` and equivalent immutable results from `consumeReplan`.

- [x] **Step 5: Verify the task domain**

Run:

```bash
npm run test:run -- tests/tasks
npm run typecheck
```

Expected: PASS.

- [x] **Step 6: Review checkpoint**

Inspect the transition table against every status in the spec. Run `git diff --check`. Do not commit.

---

### Task 4: IndexedDB Repositories, Blob Attachments, and Trusted Credentials

**Files:**

- Create: `src/persistence/database-schema.ts`
- Create: `src/persistence/open-database.ts`
- Create: `src/attachments/attachment-types.ts`
- Create: `src/persistence/task-repository.ts`
- Create: `src/persistence/conversation-repository.ts`
- Create: `src/persistence/attachment-repository.ts`
- Create: `src/persistence/storage-area.ts`
- Create: `src/persistence/settings-store.ts`
- Create: `src/persistence/credential-store.ts`
- Create: `src/persistence/index.ts`
- Create: `tests/persistence/task-repository.test.ts`
- Create: `tests/persistence/conversation-repository.test.ts`
- Create: `tests/persistence/attachment-repository.test.ts`
- Create: `tests/persistence/settings-store.test.ts`
- Create: `tests/persistence/credential-store.test.ts`

**Interfaces:**

- Consumes: durable task/conversation/message records, `AttachmentId`, `Clock`.
- Produces: roadmap `TaskRepository`, `ConversationRepository`, `AttachmentRepository`, and `SettingsStore`; `CredentialStore`; `openChatBrowserDatabase(name?: string)`.

- [x] **Step 1: Write failing transactional recovery and attachment tests**

Use `fake-indexeddb/auto` in persistence tests. Test that `saveTransition` updates the task, appends the event, stores optional step/attempt records, and stores a checkpoint in one operation; close and reopen the database before asserting recovery. Test conversation ordering per tab, streaming message replacement, full conversation clearing, settings defaults/validation, idempotent attachment references, and that a 3-byte PNG Blob is retrieved byte-for-byte and removed only when unreferenced.

`createInitial` must atomically insert one `queued` task and its sequence-zero checkpoint before the task can be scheduled. Lease tests must prove acquisition returns the persisted generation, same-owner renewal extends expiry without changing generation, takeover increments it only after expiry, and a stale owner/generation pair cannot release a newer lease. `listUnfinished` includes every non-terminal status; `listRecoverable(now)` includes only automatic-recovery states whose lease is absent or expired.

```ts
it('recovers a transitioned task after reopening IndexedDB', async () => {
  const db = await openChatBrowserDatabase('task-recovery-test');
  const repository = new IndexedDbTaskRepository(db);
  await repository.create(queuedTask);
  await repository.saveTransition({ task: observingTask, event, checkpoint });
  db.close();

  const reopened = await openChatBrowserDatabase('task-recovery-test');
  const recovered = await new IndexedDbTaskRepository(reopened).get(queuedTask.id);
  expect(recovered).toMatchObject({ status: 'observing', checkpointId: checkpoint.id });
});
```

- [x] **Step 2: Run persistence tests and confirm failure**

Run `npm run test:run -- tests/persistence`.

Expected: FAIL because repository modules are missing.

- [x] **Step 3: Implement version-1 IndexedDB schema and repositories**

Create stores with these names and keys:

```ts
export const STORE_NAMES = {
  conversations: 'conversations',
  messages: 'messages',
  tasks: 'tasks',
  taskEvents: 'task-events',
  checkpoints: 'checkpoints',
  attachments: 'attachments',
  attachmentReferences: 'attachment-references',
} as const;
```

Add indexes `conversations.by-tab-updated-at`, `tasks.by-status`, `tasks.by-updated-at`, `tasks.by-conversation`, `task-events.by-task-sequence`, `messages.by-conversation-created-at`, `attachment-references.by-attachment`, `attachment-references.by-reference`, and `attachments.by-created-at`. Use one read-write transaction in `saveTransition`; await `transaction.done` before returning.

`ConversationRepository.clearConversation` must use one transaction to remove the conversation, messages, tasks, events, checkpoints, and message attachment-reference rows for that conversation. It must reject clearing a conversation with a non-terminal task until the coordinator has cancelled it. Blob deletion remains a separate `deleteUnreferenced` garbage-collection step after the transaction.

`ConversationRepository.appendMessage` must verify every referenced attachment exists and atomically add reference rows named `message:<messageId>` with the message. `updateMessage` may change text/status, but an attachment-list change must atomically diff reference rows so a message can never point at a collectible Blob.

Attachment references use a unique compound key `[attachmentId, referenceId]`. Adding the same reference twice is a no-op; removing an absent reference is a no-op; an attachment is collectible only when no reference row exists and its `createdAt` is older than the supplied cutoff.

- [x] **Step 4: Implement validated settings and credential storage without leaking secrets**

Define `AppSettings` with model default `gpt-5.6-terra`, Reasoning Effort default `medium`, empty system prompt, and language default `system`. `SettingsStore.save` validates the model as nonblank, effort as `low | medium | high | xhigh`, system prompt at no more than 20,000 characters, and language as `system | zh-CN | en | ja`. Store settings under `settings.app` in `chrome.storage.local`; `reset` restores defaults without changing credentials.

Define:

```ts
export interface CredentialStore {
  initialize(): Promise<void>;
  getCodexAccessToken(): Promise<string | undefined>;
  setCodexAccessToken(value: string): Promise<void>;
  getTavilyKey(): Promise<string | undefined>;
  setTavilyKey(value: string): Promise<void>;
}
```

`initialize()` must call:

```ts
await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
```

Store credentials under new keys `credentials.codexAccessToken` and `credentials.tavilyKey`. Reject blank values. Errors may name the key but must never include its value.

- [x] **Step 5: Verify persistence and secret boundaries**

Run:

```bash
npm run test:run -- tests/persistence
npm run typecheck
```

Expected: PASS; tests assert repository cascades/reference counting, settings round trips, and credential values never appear in thrown error messages.

- [x] **Step 6: Review checkpoint**

Search with `rg -n "accessToken|tavilyKey" src` and verify only Provider/credential boundaries reference values. Run `git diff --check`. Do not commit.

---

### Task 5: Lease-Based Recovery Scheduler and Message Router

**Files:**

- Create: `src/tasks/task-lease.ts`
- Create: `src/tasks/task-command-service.ts`
- Create: `src/tasks/recovery-scanner.ts`
- Create: `src/platform/chrome/runtime-port.ts`
- Create: `src/platform/chrome/message-router.ts`
- Create: `src/platform/chrome/register-background.ts`
- Modify: `src/entries/background.ts`
- Modify: `src/side-panel/App.tsx`
- Create: `tests/tasks/task-lease.test.ts`
- Create: `tests/tasks/task-command-service.test.ts`
- Create: `tests/tasks/recovery-scanner.test.ts`
- Create: `tests/platform/chrome/message-router.test.ts`
- Create: `tests/platform/chrome/register-background.test.ts`
- Create: `tests/side-panel/App.test.tsx`

**Interfaces:**

- Consumes: `TaskRepository`, `CredentialStore`, runtime messages, `Clock`, `IdGenerator`.
- Produces: `TaskLeaseManager`, `TaskCommandService`, `RecoveryScanner`, `createMessageRouter(dependencies)`, `registerBackground(dependencies)`.

- [x] **Step 1: Write failing lease and recovery tests**

```ts
it('allows takeover only after a lease expires', async () => {
  expect(await manager.acquire('task_1', 'runner_a', 1_000)).toBe(true);
  expect(await manager.acquire('task_1', 'runner_b', 1_001)).toBe(false);
  expect(await manager.acquire('task_1', 'runner_b', 31_001)).toBe(true);
});

it('returns recoverable tasks without executing them twice', async () => {
  repository.listRecoverable.mockResolvedValue([observingTask, pausedTask]);
  await scanner.scan();
  expect(startTask).toHaveBeenCalledWith(observingTask.id);
  expect(startTask).not.toHaveBeenCalledWith(pausedTask.id);
});
```

Test the command service and router with malformed input, `system.ping`, `task.create`, pause, resume with optional replacement `tabId`, digest-bound confirmation, cancel, and snapshot messages. The command service owns durable state transitions; the router only validates, delegates, and maps stable response envelopes. Malformed input must return `{ ok: false, error: { code: 'INVALID_MESSAGE' } }` without throwing through Chrome. Test that an alarm/Side Panel wake-up after an ordinary Service Worker stop automatically resumes a safe recoverable task, while `runtime.onStartup` marks it `paused` with reason `browser_restart` and does not execute until the user sends `task.resume`.

- [x] **Step 2: Run focused tests and confirm failure**

Run:

```bash
npm run test:run -- tests/tasks/task-lease.test.ts tests/tasks/task-command-service.test.ts tests/tasks/recovery-scanner.test.ts tests/platform/chrome/message-router.test.ts tests/platform/chrome/register-background.test.ts tests/side-panel/App.test.tsx
```

Expected: FAIL because scheduler/router modules are missing.

- [x] **Step 3: Implement a 30-second renewable lease**

Define `LEASE_DURATION_MS = 30_000` and persist `ownerId`, `acquiredAt`, `expiresAt`, and integer `generation`. Lease acquisition must be an IndexedDB transaction that compares the persisted expiry to the injected clock. Release only when `ownerId` and generation still match.

- [x] **Step 4: Implement recovery triggers and the message router**

`registerBackground` must:

```ts
chrome.runtime.onInstalled.addListener(handleInstalled);
chrome.runtime.onStartup.addListener(handleBrowserStartup);
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.runtime.onMessage.addListener(handleMessage);
chrome.tabs.onRemoved.addListener(handleTabRemoved);
chrome.tabs.onUpdated.addListener(handleTabUpdated);
```

Create alarm `task-recovery-scan` with `periodInMinutes: 1`. `requestRecoveryScan` may coalesce concurrent calls but must not hold global mutable task state. `handleBrowserStartup` scans unfinished tasks and transactionally pauses them with reason `browser_restart`; it must not call the runner. Alarm, Side Panel connection, and tab events use the ordinary recovery scan, which may automatically resume safe tasks after an MV3 worker stop. A `task.create` message persists a queued task and schedules its ID; this plan stops before browser execution and leaves it queued.

- [x] **Step 5: Connect the Side Panel shell through the protocol**

On mount, send `system.ping`. Show `扩展已连接` on success and `后台暂不可用` on failure. Do not add task UI yet.

- [x] **Step 6: Verify the complete foundation**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
git diff --check
```

Expected: all pass. Inspect `dist/manifest.json`; it has no audio, offscreen, PDF, printing, or static all-site content script. Do not commit.
