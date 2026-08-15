# ChatBrowserX Codex and Tavily Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the single approved Codex Access Token Provider, bounded tool planning, resilient streaming/retry behavior, and Tavily search/extract/crawl without leaking Provider details into task or browser modules.

**Architecture:** Provider-neutral contracts expose normalized stream events and errors. A fixed Codex adapter decodes the ChatGPT account ID from the supplied Access Token, calls the fixed Codex Responses endpoint, and translates SSE events; a separate Tavily adapter normalizes bounded web results. The Agent Planner builds context from persisted checkpoints and emits only typed, supported browser/Tavily calls.

**Tech Stack:** TypeScript, Fetch API, ReadableStream/SSE parsing, Zod, Vitest, Codex Access Token protocol, Tavily HTTP API.

**Spec:** Read `docs/superpowers/specs/browser-agent-project-spec.md` first; its approved normative body is `docs/superpowers/specs/2026-08-15-chatbrowserx-clean-rebuild-design.md`.

## Global Constraints

- Complete the foundation and browser-core plans first.
- Do not add an OpenAI-compatible abstraction, custom Base URL, API Key mode, OAuth flow, or Codex CLI credential reader.
- Keep `https://chatgpt.com/backend-api/codex/responses` fixed inside the Codex adapter.
- Never log, persist in IndexedDB, return through runtime messages, or include Access Token/Tavily Key in errors.
- Preserve completed browser results when restarting an interrupted model turn.
- Normalize Provider errors before they reach task/UI code.
- Stream persistence must batch at 1 second or 8 KiB, whichever occurs first.
- Do not commit or push.

---

### Task 1: Provider Contracts, Error Taxonomy, and SSE Decoder

**Files:**

- Create: `src/providers/provider-types.ts`
- Create: `src/providers/provider-errors.ts`
- Create: `src/providers/stream-events.ts`
- Create: `src/providers/sse-decoder.ts`
- Create: `tests/providers/sse-decoder.test.ts`
- Create: `tests/providers/provider-errors.test.ts`

**Interfaces:**

- Consumes: `AbortSignal`.
- Produces: `ModelProvider.stream(request, signal): AsyncIterable<ModelStreamEvent>`, `ProviderError`, `decodeSseStream`.

- [ ] **Step 1: Write failing fragmented-SSE tests**

Feed the decoder bytes split inside UTF-8 characters, field names, JSON values, and event boundaries. Cover comments, multiple `data:` lines, CRLF/LF, `[DONE]`, EOF without a final blank line, invalid JSON, and an upstream error event.

```ts
const events = await collect(
  decodeSseStream(
    streamFromChunks([
      'event: response.output_text.delta\ndata: {"delta":"你',
      '好"}\n\nevent: response.completed\ndata: {"response":{"id":"r1"}}\n\n',
    ]),
  ),
);
expect(events).toEqual([
  { event: 'response.output_text.delta', data: { delta: '你好' } },
  { event: 'response.completed', data: { response: { id: 'r1' } } },
]);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run `npm run test:run -- tests/providers/sse-decoder.test.ts tests/providers/provider-errors.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Define normalized request, event, and error types**

```ts
export interface ModelRequest {
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  systemPrompt: string;
  input: ModelInputItem[];
  tools: ModelToolDefinition[];
}

export type ModelStreamEvent =
  | { type: 'response.started'; responseId: string }
  | { type: 'text.delta'; delta: string }
  | { type: 'tool.started'; callId: string; name: string }
  | { type: 'tool.arguments.delta'; callId: string; delta: string }
  | { type: 'tool.completed'; callId: string; name: string; argumentsJson: string }
  | { type: 'response.completed'; responseId: string; usage: ModelUsage | null };

export type ProviderErrorCode =
  'AUTH' | 'RATE_LIMIT' | 'TRANSIENT' | 'INVALID_RESPONSE' | 'ABORTED';
```

`ProviderError` stores code, retryable, status, retryAfterMs, and a sanitized message. Its constructor must not accept request headers or credential values.

- [ ] **Step 4: Implement the streaming SSE decoder**

Use one `TextDecoder` with `{ stream: true }`, retain incomplete lines, join repeated `data:` lines with newline, and emit only on blank-line termination or EOF. Limit one event to 1 MiB and fail with `INVALID_RESPONSE` when exceeded.

- [ ] **Step 5: Verify Provider primitives**

Run:

```bash
npm run test:run -- tests/providers/sse-decoder.test.ts tests/providers/provider-errors.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Confirm fixtures contain no usable credential. Run `git diff --check`. Do not commit.

---

### Task 2: Fixed Codex Token and Request Adapter

**Files:**

- Create: `src/providers/codex/codex-constants.ts`
- Create: `src/providers/codex/access-token.ts`
- Create: `src/providers/codex/codex-request.ts`
- Create: `src/providers/codex/codex-event-translator.ts`
- Create: `src/providers/codex/codex-provider.ts`
- Create: `tests/providers/codex/access-token.test.ts`
- Create: `tests/providers/codex/codex-request.test.ts`
- Create: `tests/providers/codex/codex-provider.test.ts`
- Create: `scripts/check-codex-contract.ts`

**Interfaces:**

- Consumes: `CredentialStore`, `ModelRequest`, `fetch` dependency.
- Produces: `extractChatGptAccountId(token): string`, `buildCodexRequest`, `CodexProvider implements ModelProvider`.

- [ ] **Step 1: Write failing token-decoding tests with synthetic JWTs**

Build unsigned test JWT strings from synthetic payloads. Support the current nested claim and a top-level compatibility claim:

```ts
expect(
  extractChatGptAccountId(
    jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' },
    }),
  ),
).toBe('acct_123');
expect(() => extractChatGptAccountId('not-a-jwt')).toThrow(/valid codex access token/i);
```

Assert thrown errors never include the supplied token.

- [ ] **Step 2: Write the exact request-builder test**

Assert the adapter uses only this URL and header contract:

```ts
expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
expect(request.headers).toMatchObject({
  Authorization: 'Bearer token-value',
  'ChatGPT-Account-ID': 'acct_123',
  'Content-Type': 'application/json',
  Accept: 'text/event-stream',
});
expect(request.body).toMatchObject({
  model: 'gpt-5.6-terra',
  stream: true,
  store: false,
  parallel_tool_calls: false,
  reasoning: { effort: 'medium', summary: 'auto' },
});
```

- [ ] **Step 3: Run Codex tests and confirm failure**

Run `npm run test:run -- tests/providers/codex`.

Expected: FAIL.

- [ ] **Step 4: Implement token parsing and request construction**

Decode base64url locally without verifying signature because the server remains the authority. Validate the payload with Zod and accept account ID from `payload['https://api.openai.com/auth'].chatgpt_account_id` or `payload.chatgpt_account_id`; reject blank/missing IDs.

Map internal input to Responses-style items: `input_text`, `input_image` data URLs, prior assistant output, `function_call`, and `function_call_output`. Set instructions, tools, `tool_choice: 'auto'`, `parallel_tool_calls: false`, `store: false`, and `stream: true`.

- [ ] **Step 5: Implement Codex streaming and error normalization**

Translate `response.created`, `response.output_text.delta`, `response.output_item.added`, `response.function_call_arguments.delta`, `response.function_call_arguments.done`, `response.output_item.done`, `response.completed`, `response.failed`, and `error`. The normal HTTP Responses request must not add the WebSocket-only `OpenAI-Beta` header. For non-2xx responses, read at most 8 KiB, discard HTML, and map `401/403` to `AUTH`, `429` to `RATE_LIMIT`, `5xx` to `TRANSIENT`, and other status codes to `INVALID_RESPONSE`.

Abort must cancel the reader and produce `ABORTED`, not a generic network error.

- [ ] **Step 6: Add an opt-in live contract check**

`scripts/check-codex-contract.ts` reads `CHATBROWSERX_CODEX_ACCESS_TOKEN` from the process environment, constructs the same Provider, sends the text “Reply with exactly OK.” with no tools, stops after completion, and exits nonzero unless normalized output is `OK`. It must print only status, response ID prefix, and elapsed milliseconds; never print the token or response headers.

Run without a token:

```bash
npx tsx scripts/check-codex-contract.ts
```

Expected: exit 2 with `CHATBROWSERX_CODEX_ACCESS_TOKEN is required`; no network request.

- [ ] **Step 7: Verify Codex adapter**

Run:

```bash
npm run test:run -- tests/providers/codex
npm run typecheck
```

Expected: PASS. Run the live check only when the user provides a disposable test token through the environment.

- [ ] **Step 8: Review checkpoint**

Run `rg -n "backend-api|Authorization|ChatGPT-Account-ID" src`. Confirm URL/header construction exists only under `providers/codex`. Do not commit.

---

### Task 3: Bounded Tool Schema and Checkpoint-Based Agent Planner

**Files:**

- Create: `src/agent/tools/browser-tool-schema.ts`
- Create: `src/agent/tools/tavily-tool-schema.ts`
- Create: `src/agent/tools/tool-parser.ts`
- Create: `src/agent/context/agent-context.ts`
- Create: `src/agent/context/observation-formatter.ts`
- Create: `src/agent/context/context-budget.ts`
- Create: `src/agent/codex-agent-planner.ts`
- Create: `src/agent/stream-persistence-buffer.ts`
- Create: `tests/agent/tools/tool-parser.test.ts`
- Create: `tests/agent/context/agent-context.test.ts`
- Create: `tests/agent/stream-persistence-buffer.test.ts`

**Interfaces:**

- Consumes: `CodexProvider`, `ConversationRepository`, `AttachmentRepository`, persisted task/checkpoint/messages, page observation.
- Produces: roadmap `AgentPlanner`, `parseToolCall`, `buildAgentContext`, `StreamPersistenceBuffer`.

- [ ] **Step 1: Write failing strict tool-schema tests**

Browser calls accept only the ten approved actions, structured target, expected condition, and risk hint. Reject unknown fields, JavaScript source, raw selectors as the only target, more than one action per call, and unknown tools.

```ts
expect(parseToolCall({ name: 'browser.act', argumentsJson: JSON.stringify(validAction) })).toEqual(
  validAction,
);
expect(() =>
  parseToolCall({ name: 'browser.eval', argumentsJson: '{"code":"document.cookie"}' }),
).toThrow(/unsupported tool/i);
```

- [ ] **Step 2: Write failing context and stream-buffer tests**

Assert context contains the goal, latest checkpoint, completed tool outputs, current bounded observation, and resolved approved image inputs but not old redundant observations. Fake timers must prove 100 tiny text deltas cause one `ConversationRepository.updateMessage` call at 1 second; 8 KiB causes an immediate update; normal completion forces a final flush; interruption marks the message `interrupted` without discarding its text.

- [ ] **Step 3: Run agent tests and confirm failure**

Run `npm run test:run -- tests/agent/tools tests/agent/context tests/agent/stream-persistence-buffer.test.ts`.

Expected: FAIL.

- [ ] **Step 4: Implement exact model tools**

Expose only:

```ts
export const MODEL_TOOL_NAMES = [
  'browser.act',
  'tavily.search',
  'tavily.extract',
  'tavily.crawl',
] as const;
```

The browser observation is supplied by the executor as context, not requested through an unconstrained model loop. Browser action schema requires `expected` and allows at most one action. Tavily schemas enforce result/URL limits defined in Task 4.

- [ ] **Step 5: Implement bounded context and planner streaming**

Build context in this order: system policy, user goal, risk policy, budget remaining, completed step summary, unresolved intent, current page observation, recent conversation, tool outputs, attachments. Limit formatted page observation to 24,000 characters and recent conversation to 32,000 characters; drop oldest ordinary chat before task evidence. Resolve only attachment IDs referenced by the current/recent messages, verify their approved image MIME/size again, and convert those Blobs to Provider `input_image` data URLs inside the trusted extension context. Never expose the data URLs through task events or runtime snapshots.

The planner emits normalized text/tool events, persists batched text through `StreamPersistenceBuffer` into the current assistant `MessageRecord`, and validates a completed tool call before yielding it to the coordinator. Invalid tool arguments consume one replan, not one browser action.

- [ ] **Step 6: Verify planner behavior**

Run:

```bash
npm run test:run -- tests/agent
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Review checkpoint**

Inspect the model tool list and confirm there is no eval, screenshot-every-step, PDF, audio, network recording, or plugin tool. Do not commit.

---

### Task 4: Bounded Tavily Adapter

**Files:**

- Create: `src/providers/tavily/tavily-types.ts`
- Create: `src/providers/tavily/tavily-client.ts`
- Create: `src/providers/tavily/tavily-errors.ts`
- Create: `tests/providers/tavily/tavily-client.test.ts`

**Interfaces:**

- Consumes: `CredentialStore`, injected `fetch`.
- Produces: `TavilyClient.search`, `TavilyClient.extract`, `TavilyClient.crawl`.

- [ ] **Step 1: Write failing URL, limit, and error tests**

Test fixed `https://api.tavily.com` endpoints, missing key, abort, `401`, `429`, `5xx`, invalid JSON, source normalization, and result truncation. Send the key only through the current official `Authorization: Bearer ...` header; never place it in the request body, mocks, results, or errors.

- [ ] **Step 2: Run Tavily tests and confirm failure**

Run `npm run test:run -- tests/providers/tavily`.

Expected: FAIL.

- [ ] **Step 3: Implement explicit limits**

Use these limits:

```ts
export const TAVILY_LIMITS = {
  searchResults: 8,
  extractUrls: 5,
  crawlDepth: 2,
  crawlBreadth: 10,
  resultTextCharacters: 12_000,
  totalCharacters: 40_000,
} as const;
```

Validate URLs as `http:` or `https:` only. Normalize each result to title, URL, bounded content, score when present, and operation source. Abort the entire operation when total normalized content reaches 40,000 characters.

- [ ] **Step 4: Verify Tavily behavior**

Run:

```bash
npm run test:run -- tests/providers/tavily
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Review checkpoint**

Confirm the Tavily key never appears in model-visible tool output or error text. Do not commit.

---

### Task 5: Provider Retry Policy and Task Coordinator Integration

**Files:**

- Create: `src/providers/provider-retry.ts`
- Create: `src/agent/agent-run-loop.ts`
- Modify: `src/tasks/task-coordinator.ts`
- Modify: `src/platform/chrome/register-background.ts`
- Create: `tests/providers/provider-retry.test.ts`
- Create: `tests/agent/agent-run-loop.test.ts`
- Modify: `tests/tasks/task-coordinator.test.ts`

**Interfaces:**

- Consumes: `AgentPlanner`, `BrowserExecutor`, `TavilyClient`, task repository.
- Produces: `AgentRunLoop.run(taskId, signal)`, Provider-aware resume behavior.

- [ ] **Step 1: Write failing retry and interrupted-turn tests**

Use fake timers to assert delays of 1 s, 2 s, and 4 s for transient network/5xx failures, a server `Retry-After` delay capped at 30 s for `429`, immediate `waiting_for_auth` for `401/403`, and no retry for invalid responses. Interrupt after one verified browser action and prove the restarted model turn includes that result and does not call the browser action again.

- [ ] **Step 2: Run retry/integration tests and confirm failure**

Run `npm run test:run -- tests/providers/provider-retry.test.ts tests/agent/agent-run-loop.test.ts tests/tasks/task-coordinator.test.ts`.

Expected: FAIL.

- [ ] **Step 3: Implement bounded Provider retry**

Allow at most three transient attempts per incomplete model turn. Use injected clock/random; jitter each backoff by ±20%. Abort cancels pending delay. `AUTH` never retries automatically. `RATE_LIMIT` uses parsed `Retry-After` or backoff and pauses after the third failure.

- [ ] **Step 4: Implement the agent loop**

For each turn: observe, checkpoint, request one plan/tool call, execute Tavily or one browser action, verify/checkpoint, then request the next turn. Completion requires a final verification-aware assistant response. Text-only ordinary chat may complete without browser actions.

When the Service Worker restarts during streaming, reconstruct input from the last checkpoint and restart only that turn. Keep the existing partial text marked `interrupted` until replacement output completes; never concatenate two competing attempts as one message.

- [ ] **Step 5: Verify all Provider and Agent integration**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:run
npm run build
git diff --check
```

Expected: all pass. Do not run live Codex requests without an explicitly supplied test token. Do not commit.
