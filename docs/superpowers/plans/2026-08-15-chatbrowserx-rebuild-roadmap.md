# ChatBrowserX Clean Rebuild Implementation Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this roadmap plan-by-plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new, maintainable Chrome MV3 browser agent with a conversation-first Side Panel, durable task recovery, verified browser actions, Codex Access Token integration, Tavily, screenshots, images, and selected-text actions.

**Architecture:** The extension is split into entrypoints/UI, durable task orchestration, browser observation/action/verification, Provider adapters, attachments, persistence, and Chrome platform adapters. The MV3 Service Worker may stop at any time, so every state transition and browser effect is checkpointed and recoverable instead of relying on keep-alive behavior.

**Tech Stack:** Node.js 24.18.0 LTS, npm 11, TypeScript 6.0.3 strict mode, React 19.2.8, Vite 7.3.6, CRXJS 2.7.1, Zod 4.4.3, idb 8.0.3, Vitest 4.1.10, Testing Library, Playwright 1.62.1, Chrome MV3 Side Panel and Debugger APIs.

**Spec:** Read `docs/superpowers/specs/browser-agent-project-spec.md` first; its approved normative body is `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`.

## Global Constraints

- Start from the empty `refactor/clean-rebuild` orphan branch; do not copy old source files.
- Do not create commits or push unless the user explicitly authorizes them in a later request. Every task ends with a diff and verification checkpoint instead of a commit.
- Target Chrome 125 or newer and Manifest V3; recursive OOPIF control relies on flat debugger sessions introduced in Chrome 125.
- Declare `debugger` as a required permission and show its active attachment state in the Side Panel.
- Keep webpage host access optional and request it per origin.
- Keep Codex and Tavily credentials in trusted extension storage only; never send them to content scripts or logs.
- Keep Codex endpoint/protocol fixed inside `providers/codex`; expose only Access Token, model, Reasoning Effort, and system prompt.
- Do not add OpenAI-compatible Providers, Base URL settings, speech/audio, subtitles, Volcengine, printing, PDF, arbitrary JavaScript execution, network recording, desktop control, or plugin infrastructure.
- Persist task state at effect boundaries; never write every streamed token independently.
- Verify every browser action and bound retries to the limits in the spec.
- Use test-first development for every behavior-bearing task.
- Use `kebab-case.ts` for non-component files and `PascalCase.tsx` for React components.
- Keep entrypoint files limited to dependency construction and registration.
- Give every function an English JSDoc comment describing its responsibility, observable behavior, and boundary; update the comment whenever behavior changes and do not narrate implementation line by line.
- Keep the approved design spec, roadmap, implementation plans, architecture documentation, runtime protocol, settings schema, and directory ownership synchronized in the same change whenever one of those contracts changes.

---

## Plan Sequence

The rebuild spans independent subsystems. Execute these plans in order; do not begin a later plan until the prior plan's exit checks pass.

当前进度：Foundation 与 Browser execution core 已完成全部验证；下一阶段为 Codex 与 Tavily providers。

1. [Foundation and durable task core](./2026-08-15-chatbrowserx-foundation.md)
   - Produces a loadable MV3 extension, strict toolchain, typed message protocol, IndexedDB repositories, credentials storage, task transitions, leases, and recovery scanning.
2. [Browser execution core](./2026-08-15-chatbrowserx-browser-core.md)
   - Produces semantic observation, durable targets, DOM/CDP drivers, verified actions, routing, budgets, tab tracking, and a resumable executor.
3. [Codex and Tavily providers](./2026-08-15-chatbrowserx-providers.md)
   - Produces fixed Codex Access Token streaming, tool-call translation, Provider retry/error handling, Tavily search/extract/crawl, and the bounded agent planner.
4. [Page features and attachments](./2026-08-15-chatbrowserx-page-features.md)
   - Produces Blob attachments, pasted/file images, viewport/region screenshots, previews, and the Translate/Ask AI selection bubble.
5. [Side Panel product experience](./2026-08-15-chatbrowserx-side-panel.md)
   - Produces the approved conversation-first interface, task cards, history, recovery, settings, permission prompts, i18n, and accessibility.
6. [End-to-end reliability and release readiness](./2026-08-15-chatbrowserx-reliability.md)
   - Produces real extension E2E coverage, multi-origin fixtures, restart/failure injection, the 20-task Codex benchmark, security/permission audits, and final documentation.

## Locked Cross-Plan Interfaces

Later plans must consume these names rather than creating parallel contracts:

```ts
export type TaskId = string;
export type ConversationId = string;
export type MessageId = string;
export type AttachmentId = string;
export type TaskStatus =
  | 'queued'
  | 'observing'
  | 'planning'
  | 'acting'
  | 'verifying'
  | 'checkpointed'
  | 'waiting_for_tab'
  | 'waiting_for_auth'
  | 'waiting_for_confirmation'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Clock {
  now(): number;
}

export interface IdGenerator {
  create(prefix: string): string;
}

export interface TaskRepository {
  create(task: TaskRun): Promise<void>;
  createInitial(task: TaskRun, checkpoint: Checkpoint): Promise<void>;
  get(taskId: TaskId): Promise<TaskRun | undefined>;
  listByConversation(conversationId: ConversationId): Promise<TaskRun[]>;
  listEvents(taskId: TaskId, afterSequence?: number): Promise<TaskEvent[]>;
  getCheckpoint(checkpointId: string): Promise<Checkpoint | undefined>;
  saveTransition(input: SaveTransitionInput): Promise<void>;
  listUnfinished(): Promise<TaskRun[]>;
  listRecoverable(now: number): Promise<TaskRun[]>;
  tryAcquireLease(input: AcquireLeaseInput): Promise<TaskLease | null>;
  releaseLease(taskId: TaskId, ownerId: string, generation: number): Promise<void>;
}

export interface ConversationRepository {
  create(conversation: Conversation): Promise<void>;
  get(conversationId: ConversationId): Promise<Conversation | undefined>;
  listByTab(tabId: number): Promise<Conversation[]>;
  listMessages(conversationId: ConversationId): Promise<MessageRecord[]>;
  appendMessage(message: MessageRecord): Promise<void>;
  updateMessage(message: MessageRecord): Promise<void>;
  clearConversation(conversationId: ConversationId): Promise<void>;
}

export interface BrowserController {
  observe(input: { tabId: number; ownerId: string }): Promise<PageObservation>;
  execute(input: { ownerId: string; action: BrowserActionRequest }): Promise<BrowserActionEvidence>;
  verify(input: VerificationRequest): Promise<VerificationResult>;
  release(tabId: number, ownerId: string): Promise<void>;
}

export interface AgentPlanner {
  plan(input: AgentPlanInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export interface AttachmentRepository {
  put(input: NewAttachment): Promise<AttachmentRecord>;
  get(id: AttachmentId): Promise<AttachmentRecord | undefined>;
  addReference(id: AttachmentId, referenceId: string): Promise<void>;
  removeReference(id: AttachmentId, referenceId: string): Promise<void>;
  deleteUnreferenced(before: number): Promise<number>;
}

export interface SettingsStore {
  get(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
  reset(): Promise<AppSettings>;
}
```

Any required interface change must update the design spec, this roadmap, the producing plan, and every consuming plan before implementation continues.

## Full Verification Gate

After every plan:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
git diff --check
git status --short
```

After Plan 6, also run:

```bash
npm run test:e2e
npm run benchmark:codex -- --runs=3
npm audit --audit-level=high
```

The rebuild is not complete until deterministic checks pass, the supported real-Codex benchmark reaches at least 90%, high-risk false execution is zero, and the manifest contains no scope-excluded permission or entrypoint.
