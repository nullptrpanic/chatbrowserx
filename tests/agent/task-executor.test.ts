// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { TaskExecutor } from '../../src/agent/task-executor';
import type { AgentEvent, AgentPlanInput } from '../../src/agent/execution-types';
import { parseBrowserToolCall } from '../../src/agent/tools/browser-tool-schema';
import { parseContextCommitToolCall } from '../../src/agent/tools/context-commit-tool-schema';
import { parseSandboxToolCall } from '../../src/agent/tools/sandbox-tool-schema';
import type { BrowserExecutionPort } from '../../src/browser/browser-execution-types';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import type { TavilyExecutionPort } from '../../src/providers/tavily/tavily-types';
import { SandboxClientError } from '../../src/sandbox/sandbox-client';
import type { SandboxExecutionPort } from '../../src/sandbox/sandbox-tool-executor';
import { TaskCommandService } from '../../src/tasks/task-command-service';
import type { MessageRecord } from '../../src/tasks/message-types';
import { createTestDatabaseName, seedConversation } from '../persistence/test-helpers';

function sources() {
  let now = 1_000;
  let id = 0;
  const messages: MessageRecord[] = [];
  return {
    clock: { now: () => ++now },
    ids: { create: (prefix: string) => `${prefix}_${String(++id)}` },
    conversations: {
      listMessages: vi.fn(async () => [...messages]),
      appendMessage: vi.fn(async (message: MessageRecord) => {
        messages.push(message);
      }),
      updateMessage: vi.fn(async (message: MessageRecord) => {
        const index = messages.findIndex(({ id }) => id === message.id);
        if (index < 0) throw new Error('Message does not exist.');
        messages[index] = message;
      }),
    },
  };
}

function tavilyPort(overrides: Partial<TavilyExecutionPort> = {}): TavilyExecutionPort {
  return {
    search: vi.fn(async () => ({ results: [], truncated: false })),
    extract: vi.fn(async () => ({ results: [], truncated: false })),
    crawl: vi.fn(async () => ({ results: [], truncated: false })),
    ...overrides,
  };
}

function browserPort(overrides: Partial<BrowserExecutionPort> = {}): BrowserExecutionPort {
  return {
    execute: vi.fn(async () => ({ output: '{"ok":true}', attachmentIds: [] })),
    resetObservationBaselines: vi.fn(),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

const SEARCH_ARGUMENTS: Extract<
  AgentEvent,
  { readonly type: 'tavily.call'; readonly operation: 'search' }
>['arguments'] = {
  query: 'browser reliability',
  searchDepth: 'basic',
  topic: 'general',
  timeRange: 'any',
  maxResults: 5,
  includeDomains: [],
  excludeDomains: [],
};

function searchCall(callId: string): AgentEvent {
  return {
    type: 'tavily.call',
    operation: 'search',
    callId,
    argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
    arguments: SEARCH_ARGUMENTS,
  };
}

function browserCall(callId: string, name: string, arguments_: unknown): AgentEvent {
  return {
    type: 'browser.call',
    call: parseBrowserToolCall({
      callId,
      name,
      argumentsJson: JSON.stringify(arguments_),
    }),
  };
}

function contextCommitCall(callId: string, state: string, throughCallId: string): AgentEvent {
  return {
    type: 'context.commit',
    call: parseContextCommitToolCall({
      callId,
      name: 'commit_context',
      argumentsJson: JSON.stringify({ state, throughCallId }),
    }),
  };
}

function sandboxCall(callId: string, name: string, arguments_: unknown): AgentEvent {
  return {
    type: 'sandbox.call',
    call: parseSandboxToolCall({
      callId,
      name,
      argumentsJson: JSON.stringify(arguments_),
    }),
  };
}

async function runBrowserProgressScenario(
  databaseName: string,
  calls: readonly AgentEvent[],
  execute: BrowserExecutionPort['execute'],
  configure?: (context: {
    readonly taskId: string;
    readonly appendMessage: (message: MessageRecord) => Promise<void>;
    readonly now: () => number;
  }) => void,
) {
  const database = await openChatBrowserDatabase(createTestDatabaseName(databaseName));
  const repository = new IndexedDbTaskRepository(database);
  const dependencies = sources();
  const commands = new TaskCommandService(
    repository,
    dependencies.clock,
    dependencies.ids,
    dependencies.conversations,
  );
  const created = await commands.create({
    conversationId: 'conversation_1',
    tabId: 7,
    goal: 'Complete browser work without repeating unchanged actions',
  });
  configure?.({
    taskId: created.task.id,
    appendMessage: dependencies.conversations.appendMessage,
    now: dependencies.clock.now,
  });
  let turn = 0;
  const planner = {
    plan: () =>
      (async function* () {
        const next = calls[turn++];
        if (next) {
          yield next;
          return;
        }
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        } as const;
      })(),
  };
  const executor = new TaskExecutor({
    repository,
    conversations: dependencies.conversations,
    planner,
    tavily: tavilyPort(),
    browser: browserPort({ execute }),
    clock: dependencies.clock,
    ids: dependencies.ids,
  });

  try {
    return await executor.run(created.task.id, new AbortController().signal);
  } finally {
    database.close();
  }
}

describe('TaskExecutor', () => {
  it('persists model telemetry and resumes a pending tool from the local checkpoint', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('local-pending-tool-resume'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Research with a recoverable local checkpoint',
    });
    let plannerTurn = 0;
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>((input) => {
      plannerTurn += 1;
      return (async function* () {
        if (plannerTurn === 1) {
          yield {
            ...searchCall('call_search'),
            modelOutputItems: [
              {
                type: 'reasoning',
                itemId: 'reasoning_search',
                encryptedContent: 'opaque-encrypted-content',
                summary: [{ type: 'summary_text', text: 'Search official sources.' }],
              },
            ],
            modelTurn: {
              responseId: 'resp_search',
              inputItemCount: 1,
              elapsedMs: 25,
              firstEventMs: 4,
              firstTextMs: 10,
              usage: {
                inputTokens: 120,
                outputTokens: 15,
                totalTokens: 135,
                cachedInputTokens: 80,
              },
            },
          };
          return;
        }
        expect(input.checkpoint.pendingToolCall).toBeNull();
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        };
      })();
    });
    let searchAttempts = 0;
    const tavily = tavilyPort({
      search: vi.fn(async () => {
        searchAttempts += 1;
        if (searchAttempts === 1) throw providerErrorFromCode('ABORTED');
        return { results: [], truncated: false };
      }),
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { code: 'ABORTED' },
    );
    const interrupted = await commands.getSnapshot(created.task.id);
    expect(interrupted.checkpoint.pendingToolCall).toMatchObject({
      callId: 'call_search',
      name: 'tavily_search',
    });
    expect(interrupted.checkpoint.continuationItems.at(-1)).toMatchObject({
      type: 'function_call',
      callId: 'call_search',
      modelOutputItems: [
        {
          type: 'reasoning',
          itemId: 'reasoning_search',
          encryptedContent: 'opaque-encrypted-content',
        },
      ],
    });
    expect(interrupted.checkpoint.lastModelInputTokens).toBe(120);
    expect(interrupted.events.at(-1)?.modelTurn).toEqual({
      inputItemCount: 1,
      elapsedMs: 25,
      firstEventMs: 4,
      firstTextMs: 10,
      inputTokens: 120,
      outputTokens: 15,
      totalTokens: 135,
      cachedInputTokens: 80,
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(recovered.task.status).toBe('completed');
    expect(recovered.events.map(({ type }) => type)).toEqual([
      'planning.started',
      'tool.call-recorded',
      'tool.result-recorded',
      'task.completed',
    ]);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(tavily.search).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('safely completes a legacy recorded pending context commit after executor restart', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('pending-context-commit-resume'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Resume a context commit',
      userMessageId: 'message_user',
    });
    const recordedAt = created.task.updatedAt;
    const planningCheckpoint = {
      ...created.checkpoint,
      id: 'checkpoint_planning_commit',
      sequence: 1,
      taskStatus: 'planning' as const,
      createdAt: recordedAt,
    };
    await repository.saveTransition({
      task: {
        ...created.task,
        status: 'planning',
        checkpointId: planningCheckpoint.id,
        updatedAt: recordedAt,
      },
      event: {
        id: 'event_planning_commit',
        taskId: created.task.id,
        sequence: 1,
        type: 'planning.started',
        reason: 'model_request_started',
        at: recordedAt,
        error: null,
      },
      checkpoint: planningCheckpoint,
    });
    const argumentsJson = JSON.stringify({
      state: 'Search completed. Next: answer.',
    });
    const pendingCheckpoint = {
      ...planningCheckpoint,
      id: 'checkpoint_pending_commit',
      sequence: 2,
      completedToolResults: [
        {
          callId: 'call_search',
          toolName: 'tavily_search',
          argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
          output: '{"ok":true,"results":[],"truncated":false}',
          resultRef: 'result_search',
          attachmentIds: [],
        },
      ],
      continuationItems: [
        { type: 'message_ref' as const, messageId: 'message_user' },
        {
          type: 'function_call' as const,
          callId: 'call_search',
          name: 'tavily_search',
          argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
        },
        {
          type: 'function_call_output' as const,
          callId: 'call_search',
          output: '{"ok":true,"results":[],"truncated":false}',
          resultRef: 'result_search',
          attachmentIds: [],
        },
        {
          type: 'function_call' as const,
          callId: 'call_commit',
          name: 'commit_context',
          argumentsJson,
        },
      ],
      pendingToolCall: {
        callId: 'call_commit',
        name: 'commit_context',
        argumentsJson,
        executionState: 'recorded' as const,
      },
      createdAt: recordedAt,
    };
    await repository.saveTransition({
      task: {
        ...created.task,
        status: 'planning',
        checkpointId: pendingCheckpoint.id,
        updatedAt: recordedAt,
      },
      event: {
        id: 'event_pending_commit',
        taskId: created.task.id,
        sequence: 2,
        type: 'tool.call-recorded',
        reason: 'commit_context_call_recorded',
        at: recordedAt,
        error: null,
      },
      checkpoint: pendingCheckpoint,
    });
    const plan = vi.fn(() =>
      (async function* () {
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        } as const;
      })(),
    );
    const tavily = tavilyPort();
    const browser = browserPort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser,
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(recovered.task.status).toBe('completed');
    expect(recovered.events.map(({ type }) => type)).toEqual([
      'planning.started',
      'tool.call-recorded',
      'tool.result-recorded',
      'task.completed',
    ]);
    expect(recovered.events).not.toContainEqual(
      expect.objectContaining({ type: 'tool.execution-started' }),
    );
    expect(recovered.checkpoint.completedToolResults.map(({ toolName }) => toolName)).toEqual([
      'tavily_search',
      'commit_context',
    ]);
    expect(plan).toHaveBeenCalledOnce();
    expect(tavily.search).not.toHaveBeenCalled();
    expect(browser.execute).not.toHaveBeenCalled();
    database.close();
  });

  it('does not redispatch the same failed browser type call without fresh page evidence', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('duplicate-browser-type-failure'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Fill the editor once',
    });
    let turn = 0;
    const typeArguments = {
      ref: 'page_4_12',
      text: 'int main() { return 0; }',
      replace: true,
      submit: false,
    };
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>(() =>
      (async function* () {
        turn += 1;
        if (turn <= 2) {
          yield browserCall(
            `call_type_${turn}`,
            'browser_type',
            turn === 1 ? typeArguments : { tabId: 0, ...typeArguments },
          );
          return;
        }
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        };
      })(),
    );
    const execute = vi.fn(async () => ({
      output: JSON.stringify({
        ok: false,
        code: 'TYPE_VERIFICATION_FAILED',
        message: 'The page did not retain the requested text. Inspect the editor and try again.',
        retryable: true,
        needsInspect: true,
      }),
      attachmentIds: [],
    }));
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
    expect(result.checkpoint.completedToolResults).toHaveLength(2);
    expect(JSON.parse(result.checkpoint.completedToolResults[1]?.output ?? '')).toEqual({
      ok: false,
      code: 'DUPLICATE_FAILED_ACTION',
      message:
        'The same editor input already failed on this page state. Inspect the page before trying again.',
      retryable: false,
      needsInspect: true,
    });
    database.close();
  });

  it('does not redispatch an immediately repeated verified submit', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('duplicate-browser-submit-success'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Send one message',
    });
    let turn = 0;
    const typeArguments = {
      ref: 'ref_editor',
      text: 'Hello',
      replace: true,
      submit: true,
    };
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>(() =>
      (async function* () {
        turn += 1;
        if (turn <= 2) {
          yield browserCall(`call_submit_${turn}`, 'browser_type', typeArguments);
          return;
        }
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        };
      })(),
    );
    const execute = vi.fn(async () => ({
      output: JSON.stringify({
        ok: true,
        tabId: 7,
        url: 'https://example.test/chat',
        data: {
          action: 'type',
          submitted: true,
          submissionVerified: true,
          verified: true,
        },
        observation: null,
      }),
      attachmentIds: [],
    }));
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
    expect(result.checkpoint.completedToolResults).toHaveLength(2);
    expect(JSON.parse(result.checkpoint.completedToolResults[1]?.output ?? '')).toMatchObject({
      ok: true,
      data: {
        action: 'type',
        submitted: true,
        submissionVerified: true,
        verified: true,
        replayed: true,
      },
    });
    database.close();
  });

  it('stops a repeated inspect and failed-action cycle before the hard tool limit', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('browser-no-progress'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Select an answer without looping',
    });
    const calls = [
      browserCall('call_inspect_1', 'browser_inspect', { mode: 'interactive' }),
      browserCall('call_select_1', 'browser_set_checked', {
        ref: 'e12345678a',
        checked: true,
      }),
      browserCall('call_inspect_2', 'browser_inspect', { mode: 'interactive' }),
      browserCall('call_select_2', 'browser_set_checked', {
        ref: 'e12345678a',
        checked: true,
      }),
      browserCall('call_inspect_3', 'browser_inspect', { mode: 'interactive' }),
    ];
    let turn = 0;
    const planner = {
      plan: () =>
        (async function* () {
          const next = calls[turn++];
          if (next) {
            yield next;
            return;
          }
          yield {
            type: 'task.completed',
            reason: 'model_response_completed',
            messageId: 'message_answer',
          } as const;
        })(),
    };
    let inspectCount = 0;
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (call) => ({
      output:
        call.operation === 'inspect'
          ? JSON.stringify({
              ok: true,
              tabId: 7,
              url: 'https://exam.test/',
              data: {
                mode: 'interactive',
                snapshot: inspectCount++ === 0 ? 's1111111111111111' : 's2222222222222222',
                elements: [
                  {
                    r: 'checkbox',
                    n: 'A',
                    ref: 'e12345678a',
                    s: ['checked=false'],
                  },
                ],
                truncated: false,
              },
            })
          : JSON.stringify({
              ok: false,
              code: 'ACTION_STATE_MISMATCH',
              message: 'The page did not retain the requested selection.',
              retryable: false,
              needsInspect: true,
            }),
      attachmentIds: [],
    }));
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      tavily: tavilyPort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledTimes(4);
    expect(JSON.parse(result.checkpoint.completedToolResults.at(-1)?.output ?? '')).toMatchObject({
      ok: false,
      code: 'NO_PROGRESS',
      needsInspect: false,
    });
    database.close();
  });

  it('blocks a third unchanged inspect even when snapshot and base IDs rotate', async () => {
    const calls = Array.from({ length: 3 }, (_, index) =>
      browserCall(`call_unchanged_inspect_${String(index + 1)}`, 'browser_inspect', {
        mode: 'interactive',
      }),
    );
    let inspect = 0;
    const execute = vi.fn<BrowserExecutionPort['execute']>(async () => {
      inspect += 1;
      return {
        output: JSON.stringify({
          ok: true,
          tabId: 7,
          url: 'https://example.test/form',
          data: {
            mode: 'interactive',
            snapshot: `snapshot_${String(inspect)}`,
            base: `snapshot_${String(inspect - 1)}`,
            unchanged: true,
          },
          observation: null,
        }),
        attachmentIds: [],
      };
    });

    const result = await runBrowserProgressScenario(
      'unchanged-inspect-rotating-snapshot',
      calls,
      execute,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.checkpoint.completedToolResults.at(-1)?.output ?? '')).toMatchObject({
      ok: false,
      code: 'NO_PROGRESS',
      retryable: false,
      needsInspect: false,
    });
  });

  it('blocks a repeated immobile scroll at the same position before redispatch', async () => {
    const calls = [
      browserCall('call_immobile_scroll_1', 'browser_scroll', {
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
      }),
      browserCall('call_inspect_after_immobile_scroll', 'browser_inspect', {
        mode: 'interactive',
        since: 'snapshot_before_scroll',
      }),
      browserCall('call_immobile_scroll_2', 'browser_scroll', {
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
      }),
    ];
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (call) => ({
      output: JSON.stringify({
        ok: true,
        tabId: 7,
        url: 'https://example.test/form',
        data:
          call.name === 'browser_inspect'
            ? {
                mode: 'interactive',
                snapshot: 'snapshot_after_scroll',
                base: 'snapshot_before_scroll',
                unchanged: true,
                elements: [],
              }
            : {
                action: 'scroll',
                dispatched: true,
                moved: false,
                actualDeltaX: 0,
                actualDeltaY: 0,
                position: { x: 0, y: 1200, maxX: 0, maxY: 1200 },
              },
        observation: call.name === 'browser_inspect' ? null : { targetPresent: null },
      }),
      attachmentIds: [],
    }));

    const result = await runBrowserProgressScenario('immobile-scroll', calls, execute);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.map(([call]) => call.name)).toEqual([
      'browser_scroll',
      'browser_inspect',
    ]);
    expect(JSON.parse(result.checkpoint.completedToolResults.at(-1)?.output ?? '')).toMatchObject({
      ok: false,
      code: 'NO_PROGRESS',
      retryable: false,
      needsInspect: false,
      data: {
        direction: { deltaX: 0, deltaY: 600 },
        position: { x: 0, y: 1200, maxX: 0, maxY: 1200 },
      },
    });
  });

  it('blocks a repeated bounded scroll after it reports no progress', async () => {
    const arguments_ = {
      target: 'ref_history',
      deltaX: 0,
      deltaY: -600,
      maxSegments: 8,
      stopText: '',
    };
    const calls = [
      browserCall('call_scroll_until_1', 'browser_scroll_until', arguments_),
      browserCall('call_scroll_until_2', 'browser_scroll_until', arguments_),
    ];
    const execute = vi.fn<BrowserExecutionPort['execute']>(async () => ({
      output: JSON.stringify({
        ok: true,
        tabId: 7,
        url: 'https://example.test/history',
        data: {
          action: 'scroll_until',
          moved: false,
          stopReason: 'no_progress',
          position: { x: 0, y: 0, maxX: 0, maxY: 1_200 },
          observations: [
            {
              mode: 'interactive',
              snapshot: 'snapshot_no_progress',
              base: 'snapshot_before',
              unchanged: true,
            },
          ],
        },
        observation: null,
      }),
      attachmentIds: [],
    }));

    const result = await runBrowserProgressScenario('bounded-scroll-no-progress', calls, execute);

    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.parse(result.checkpoint.completedToolResults.at(-1)?.output ?? '')).toMatchObject({
      ok: false,
      code: 'NO_PROGRESS',
      retryable: false,
      needsInspect: false,
      data: {
        direction: { deltaX: 0, deltaY: -600 },
        position: { x: 0, y: 0, maxX: 0, maxY: 1_200 },
      },
    });
  });

  it('rejects a premature final answer until an unfinished virtualized scroll is inspected and resumed', async () => {
    const calls: readonly AgentEvent[] = [
      browserCall('call_scroll_initial', 'browser_scroll', {
        tabId: 0,
        target: 'ref_history',
        deltaX: 0,
        deltaY: -10_000,
      }),
      {
        type: 'task.completed',
        reason: 'model_response_completed',
        messageId: 'message_premature',
      },
      browserCall('call_inspect_loaded_batch', 'browser_inspect', {
        tabId: 0,
        mode: 'interactive',
        since: 'snapshot_before_scroll',
      }),
      browserCall('call_scroll_remaining', 'browser_scroll', {
        tabId: 0,
        target: 'ref_history',
        deltaX: 0,
        deltaY: -9_035,
      }),
      browserCall('call_inspect_completed_scroll', 'browser_inspect', {
        tabId: 0,
        mode: 'interactive',
        since: 'snapshot_loaded_batch',
      }),
    ];
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (call) => {
      if (call.callId === 'call_scroll_initial') {
        return {
          output: JSON.stringify({
            ok: true,
            tabId: 7,
            data: {
              action: 'scroll',
              requestedDeltaApplied: false,
              remainingDeltaX: 0,
              remainingDeltaY: -9_035,
              loadedMore: true,
              boundaryVerified: false,
            },
          }),
          attachmentIds: [],
        };
      }
      if (call.callId === 'call_inspect_loaded_batch') {
        return {
          output: JSON.stringify({
            ok: true,
            tabId: 7,
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_loaded_batch',
              elements: [{ ref: 'message_1', r: 'statictext', n: 'Older message' }],
            },
          }),
          attachmentIds: [],
        };
      }
      if (call.callId === 'call_inspect_completed_scroll') {
        return {
          output: JSON.stringify({
            ok: true,
            tabId: 7,
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_completed_scroll',
              elements: [{ ref: 'message_2', r: 'statictext', n: 'Oldest message' }],
            },
          }),
          attachmentIds: [],
        };
      }
      return {
        output: JSON.stringify({
          ok: true,
          tabId: 7,
          data: {
            action: 'scroll',
            requestedDeltaApplied: true,
            remainingDeltaX: 0,
            remainingDeltaY: 0,
            loadedMore: false,
            boundaryVerified: false,
          },
        }),
        attachmentIds: [],
      };
    });

    const result = await runBrowserProgressScenario(
      'unfinished-virtual-scroll-blocks-final',
      calls,
      execute,
      ({ taskId, appendMessage, now }) => {
        const at = now();
        void appendMessage({
          id: 'message_premature',
          kind: 'conversation',
          conversationId: 'conversation_1',
          taskId,
          role: 'assistant',
          status: 'complete',
          text: 'The history is complete.',
          attachmentIds: [],
          createdAt: at,
          updatedAt: at,
        });
      },
    );

    expect(result.task.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(4);
    expect(result.events.filter(({ type }) => type === 'task.completed')).toHaveLength(1);
    expect(result.checkpoint.continuationItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          callId: 'call_inspect_loaded_batch',
        }),
        expect.objectContaining({
          type: 'function_call',
          callId: 'call_scroll_remaining',
        }),
        expect.objectContaining({
          type: 'function_call',
          callId: 'call_inspect_completed_scroll',
        }),
      ]),
    );
  });

  it('replays an already verified selection on the same ref and page epoch', async () => {
    const calls = [
      browserCall('call_selection_inspect', 'browser_inspect', {
        mode: 'interactive',
      }),
      browserCall('call_selection_first', 'browser_set_checked', {
        ref: 'answer_group_1_a',
        checked: true,
      }),
      browserCall('call_selection_duplicate', 'browser_set_checked', {
        ref: 'answer_group_1_a',
        checked: true,
      }),
    ];
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (call) => ({
      output:
        call.operation === 'inspect'
          ? JSON.stringify({
              ok: true,
              tabId: 7,
              url: 'https://example.test/form',
              data: {
                mode: 'interactive',
                snapshot: 'snapshot_selection_1',
                elements: [],
              },
              observation: null,
            })
          : JSON.stringify({
              ok: true,
              tabId: 7,
              url: 'https://example.test/form',
              data: {
                action: 'set_checked',
                dispatched: true,
                requested: true,
                verified: true,
                strategy: 'pointer',
              },
              observation: {
                targetPresent: true,
                state: ['checked'],
                target: {
                  ref: 'answer_group_1_a',
                  role: 'checkbox',
                  state: ['checked'],
                },
              },
            }),
      attachmentIds: [],
    }));

    const result = await runBrowserProgressScenario('verified-selection-replay', calls, execute);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.checkpoint.completedToolResults.at(-1)?.output ?? '')).toMatchObject({
      ok: true,
      data: {
        action: 'set_checked',
        requested: true,
        verified: true,
        dispatched: false,
        replayed: true,
        strategy: 'already_verified',
      },
      observation: {
        target: { ref: 'answer_group_1_a', state: ['checked'] },
      },
    });
  });

  it('allows the same selection after a fresh page epoch and a different ref in the same epoch', async () => {
    const calls = [
      browserCall('call_epoch_inspect_1', 'browser_inspect', {
        mode: 'interactive',
      }),
      browserCall('call_epoch_select_1', 'browser_set_checked', {
        ref: 'answer_group_1_a',
        checked: true,
      }),
      browserCall('call_epoch_inspect_2', 'browser_inspect', {
        mode: 'interactive',
      }),
      browserCall('call_epoch_select_2', 'browser_set_checked', {
        ref: 'answer_group_1_a',
        checked: true,
      }),
      browserCall('call_other_group_select', 'browser_set_checked', {
        ref: 'answer_group_2_a',
        checked: true,
      }),
    ];
    let inspect = 0;
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (call) => {
      if (call.operation === 'inspect') {
        inspect += 1;
        return {
          output: JSON.stringify({
            ok: true,
            tabId: 7,
            url: 'https://example.test/form',
            data: {
              mode: 'interactive',
              snapshot: `snapshot_epoch_${String(inspect)}`,
              elements: [],
            },
            observation: null,
          }),
          attachmentIds: [],
        };
      }
      const ref = (call.arguments as { readonly ref: string }).ref;
      return {
        output: JSON.stringify({
          ok: true,
          tabId: 7,
          url: 'https://example.test/form',
          data: {
            action: 'set_checked',
            dispatched: true,
            requested: true,
            verified: true,
            strategy: 'pointer',
          },
          observation: {
            targetPresent: true,
            state: ['checked'],
            target: { ref, role: 'checkbox', state: ['checked'] },
          },
        }),
        attachmentIds: [],
      };
    });

    const result = await runBrowserProgressScenario(
      'selection-new-epoch-and-group',
      calls,
      execute,
    );

    expect(result.task.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it('retains page evidence across a user supplement while allowing a different action', async () => {
    const calls = [
      browserCall('call_supplement_inspect', 'browser_inspect', {
        mode: 'interactive',
      }),
      browserCall('call_supplement_select_a', 'browser_set_checked', {
        ref: 'answer_group_1_a',
        checked: true,
      }),
      browserCall('call_supplement_select_b', 'browser_set_checked', {
        ref: 'answer_group_1_b',
        checked: true,
      }),
    ];
    let appendSupplement = async () => undefined;
    let supplementAdded = false;
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (call) => {
      if (call.operation === 'inspect') {
        return {
          output: JSON.stringify({
            ok: true,
            tabId: 7,
            url: 'https://example.test/form',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_supplement',
              elements: [],
            },
            observation: null,
          }),
          attachmentIds: [],
        };
      }
      const ref = (call.arguments as { readonly ref: string }).ref;
      if (!supplementAdded) {
        supplementAdded = true;
        await appendSupplement();
      }
      return {
        output: JSON.stringify({
          ok: true,
          tabId: 7,
          url: 'https://example.test/form',
          data: {
            action: 'set_checked',
            dispatched: true,
            requested: true,
            verified: true,
            strategy: 'pointer',
          },
          observation: {
            targetPresent: true,
            state: ['checked'],
            target: { ref, role: 'radio', state: ['checked'] },
          },
        }),
        attachmentIds: [],
      };
    });

    const result = await runBrowserProgressScenario(
      'supplement-preserves-page-evidence',
      calls,
      execute,
      ({ taskId, appendMessage, now }) => {
        appendSupplement = async () => {
          const at = now();
          await appendMessage({
            id: 'supplement_progress_detail',
            kind: 'supplement',
            conversationId: 'conversation_1',
            taskId,
            role: 'user',
            status: 'complete',
            text: 'Use the second answer for the next group.',
            attachmentIds: [],
            createdAt: at,
            updatedAt: at,
          });
        };
      },
    );

    expect(result.task.status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(
      result.checkpoint.continuationItems.some(
        (item) => item.type === 'message_ref' && item.messageId === 'supplement_progress_detail',
      ),
    ).toBe(true);
  });

  it('retains browser screenshot attachment IDs and gives them a durable result reference', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('browser-screenshot'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Inspect the current page visually',
    });
    let turn = 0;
    const planner = {
      plan: () =>
        (async function* () {
          turn += 1;
          if (turn === 1) {
            yield browserCall('call_screenshot', 'browser_inspect', {
              tabId: 7,
              mode: 'screenshot',
            });
          } else {
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          }
        })(),
    };
    const addReference = vi.fn(async () => undefined);
    const removeReference = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      tavily: tavilyPort(),
      browser: browserPort({
        execute: vi.fn(async () => ({
          output: '{"ok":true,"data":{"mode":"screenshot"}}',
          attachmentIds: ['attachment_screenshot'],
        })),
        release,
      }),
      attachments: { addReference, removeReference },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);
    const completed = result.checkpoint.completedToolResults[0];

    expect(completed).toMatchObject({
      callId: 'call_screenshot',
      attachmentIds: ['attachment_screenshot'],
    });
    expect(
      result.checkpoint.continuationItems.find(
        (item) => item.type === 'function_call_output_ref' && item.callId === 'call_screenshot',
      ),
    ).toMatchObject({
      type: 'function_call_output_ref',
      callId: 'call_screenshot',
      attachmentIds: ['attachment_screenshot'],
    });
    expect(addReference).toHaveBeenCalledWith('attachment_screenshot', completed?.resultRef);
    expect(removeReference).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(expect.stringMatching(/^runner_/));
    database.close();
  });

  it('keeps full browser audit output while replaying the compact model output', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('browser-model-output'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Inspect the page without replaying audit-only metadata',
    });
    let turn = 0;
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            turn += 1;
            if (turn === 1) {
              yield browserCall('call_inspect', 'browser_inspect', {
                tabId: 7,
                mode: 'interactive',
                since: '',
              });
              return;
            }
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          })(),
      },
      tavily: tavilyPort(),
      browser: browserPort({
        execute: vi.fn(async () => ({
          output: '{"ok":true,"data":{"full":"audit"}}',
          modelOutput: '{"ok":true,"verified":true}',
          attachmentIds: [],
        })),
      }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.checkpoint.completedToolResults[0]).toMatchObject({
      output: '{"ok":true,"data":{"full":"audit"}}',
      modelOutput: '{"ok":true,"verified":true}',
    });
    const continuationOutput = result.checkpoint.continuationItems.find(
      (item) => 'callId' in item && item.callId === 'call_inspect' && item.type !== 'function_call',
    );
    expect(continuationOutput).toMatchObject({
      type: 'function_call_output_ref',
      callId: 'call_inspect',
    });
    expect(continuationOutput).not.toHaveProperty('output');
    database.close();
  });

  it('keeps captured delivery assets durable without replaying their bytes to the model', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('browser-capture-asset'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Capture and send the current page',
    });
    let turn = 0;
    const planner = {
      plan: () =>
        (async function* () {
          turn += 1;
          if (turn === 1) {
            yield browserCall('call_capture', 'browser_capture_screenshot', {
              tabId: 7,
            });
          } else if (turn === 2) {
            yield browserCall('call_paste', 'browser_paste_image', {
              tabId: 7,
              ref: 'ref_editor',
              assetId: 'attachment_capture',
            });
          } else {
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          }
        })(),
    };
    const addReference = vi.fn(async () => undefined);
    const executeBrowser = vi.fn(async (call_) =>
      call_.operation === 'capture_screenshot'
        ? {
            output: '{"ok":true,"assetId":"attachment_capture"}',
            attachmentIds: ['attachment_capture'],
            modelAttachmentIds: [],
          }
        : {
            output: '{"ok":true,"pasted":true}',
            attachmentIds: [],
          },
    );
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      tavily: tavilyPort(),
      browser: browserPort({
        execute: executeBrowser,
      }),
      attachments: {
        addReference,
        removeReference: vi.fn(async () => undefined),
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);
    const completed = result.checkpoint.completedToolResults[0];
    const continuation = result.checkpoint.continuationItems.find(
      (item) => item.type === 'function_call_output_ref' && item.callId === 'call_capture',
    );

    expect(completed?.attachmentIds).toEqual(['attachment_capture']);
    expect(continuation).toMatchObject({
      type: 'function_call_output_ref',
      callId: 'call_capture',
      attachmentIds: [],
    });
    expect(addReference).toHaveBeenCalledWith('attachment_capture', completed?.resultRef);
    expect(executeBrowser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operation: 'paste_image' }),
      expect.any(AbortSignal),
      expect.objectContaining({ availableAssetIds: ['attachment_capture'] }),
    );
    database.close();
  });

  it('rolls back screenshot references when the result checkpoint cannot be saved', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('browser-screenshot-race'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Inspect the current page visually',
    });
    const originalSaveTransition = repository.saveTransition.bind(repository);
    vi.spyOn(repository, 'saveTransition').mockImplementation(async (input) => {
      if (input.event.type === 'tool.result-recorded') throw new Error('synthetic conflict');
      return originalSaveTransition(input);
    });
    const addReference = vi.fn(async () => undefined);
    const removeReference = vi.fn(async () => undefined);
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield browserCall('call_screenshot', 'browser_inspect', {
              tabId: 7,
              mode: 'screenshot',
            });
          })(),
      },
      tavily: tavilyPort(),
      browser: browserPort({
        execute: vi.fn(async () => ({
          output: '{"ok":true,"data":{"mode":"screenshot"}}',
          attachmentIds: ['attachment_screenshot'],
        })),
      }),
      attachments: { addReference, removeReference },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toThrow(
      'synthetic conflict',
    );
    expect(addReference).toHaveBeenCalledOnce();
    expect(removeReference).toHaveBeenCalledWith(
      'attachment_screenshot',
      expect.stringMatching(/^toolResult_/),
    );
    database.close();
  });

  it('durably marks a browser mutation before dispatch and records its result', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('browser-mutation'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Open a browser tab',
    });
    let turn = 0;
    const planner = {
      plan: () =>
        (async function* () {
          turn += 1;
          if (turn === 1) {
            yield browserCall('call_open', 'browser_open_tab', {
              url: 'https://example.com',
              activate: true,
            });
          } else {
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          }
        })(),
    };
    const execute = vi.fn(async () => {
      const dispatchBoundary = await commands.getSnapshot(created.task.id);
      expect(dispatchBoundary.events.at(-1)?.type).toBe('tool.execution-started');
      expect(dispatchBoundary.checkpoint.pendingToolCall).toMatchObject({
        callId: 'call_open',
        executionState: 'may_have_dispatched',
      });
      return { output: '{"ok":true,"tabId":91}', attachmentIds: [] };
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      tavily: tavilyPort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'browser_open_tab' }),
      expect.any(AbortSignal),
      expect.objectContaining({
        currentTabId: 7,
        sessionOwnerId: expect.stringMatching(/^runner_/),
      }),
    );
    expect(result.events.map(({ type }) => type)).toEqual([
      'planning.started',
      'tool.call-recorded',
      'tool.execution-started',
      'tool.result-recorded',
      'task.completed',
    ]);
    expect(result.checkpoint.completedToolResults[0]).toMatchObject({
      callId: 'call_open',
      toolName: 'browser_open_tab',
      output: '{"ok":true,"tabId":91}',
    });
    expect(result.checkpoint.browserTargetTabId).toBe(91);
    database.close();
  });

  it('records Sandbox reads and durably marks Sandbox exec before dispatch', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('sandbox-tools'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Use one Sandbox Skill',
    });
    let turn = 0;
    const planner = {
      plan: () =>
        (async function* () {
          turn += 1;
          if (turn === 1) {
            yield sandboxCall('call_read', 'sandbox_read', {
              path: '/skills/example/SKILL.md',
              startLine: 1,
              maxLines: 400,
            });
          } else if (turn === 2) {
            yield sandboxCall('call_exec', 'sandbox_exec', {
              command: 'bash scripts/run.sh',
              cwd: '/skills/example',
            });
          } else {
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          }
        })(),
    };
    const execute = vi.fn<SandboxExecutionPort['execute']>(async (call) => {
      if (call.operation === 'exec') {
        const dispatchBoundary = await commands.getSnapshot(created.task.id);
        expect(dispatchBoundary.events.at(-1)?.type).toBe('tool.execution-started');
        expect(dispatchBoundary.checkpoint.pendingToolCall).toMatchObject({
          callId: 'call_exec',
          executionState: 'may_have_dispatched',
        });
        return '{"code":0,"stdout":"done","stderr":"","truncated":false}';
      }
      return '{"code":0,"content":"skill","truncated":false}';
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      tavily: tavilyPort(),
      browser: browserPort(),
      sandbox: { execute },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.events.map(({ type }) => type)).toEqual([
      'planning.started',
      'tool.call-recorded',
      'tool.result-recorded',
      'tool.call-recorded',
      'tool.execution-started',
      'tool.result-recorded',
      'task.completed',
    ]);
    expect(result.checkpoint.completedToolResults.map(({ toolName }) => toolName)).toEqual([
      'sandbox_read',
      'sandbox_exec',
    ]);
    expect(
      result.checkpoint.continuationItems.filter(
        (item) => 'callId' in item && item.callId === 'call_exec',
      ),
    ).toMatchObject([
      { type: 'function_call', callId: 'call_exec', name: 'sandbox_exec' },
      { type: 'function_call_output_ref', callId: 'call_exec' },
    ]);
    database.close();
  });

  it('never redispatches a Sandbox exec that may already have run', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('sandbox-ambiguous'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Run one command at most once',
    });
    let turn = 0;
    const planner = {
      plan: () =>
        (async function* () {
          turn += 1;
          if (turn === 1) {
            yield sandboxCall('call_exec', 'sandbox_exec', { command: 'touch marker', cwd: null });
          } else {
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          }
        })(),
    };
    const execute = vi.fn<SandboxExecutionPort['execute']>(async () => {
      throw new DOMException('Stopped after dispatch.', 'AbortError');
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      tavily: tavilyPort(),
      browser: browserPort(),
      sandbox: { execute },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    await expect(commands.getSnapshot(created.task.id)).resolves.toMatchObject({
      checkpoint: {
        pendingToolCall: {
          callId: 'call_exec',
          executionState: 'may_have_dispatched',
        },
      },
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledOnce();
    expect(recovered.task.status).toBe('completed');
    expect(
      JSON.parse(
        recovered.checkpoint.completedToolResults.find(({ callId }) => callId === 'call_exec')
          ?.output ?? '{}',
      ),
    ).toMatchObject({ code: 'AMBIGUOUS_EXECUTION', retryable: false });
    database.close();
  });

  it('keeps a definitely undispatched Sandbox exec retryable after authentication failure', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('sandbox-auth'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Run after credentials are fixed',
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield sandboxCall('call_exec', 'sandbox_exec', { command: 'true', cwd: null });
          })(),
      },
      tavily: tavilyPort(),
      browser: browserPort(),
      sandbox: {
        execute: vi.fn(async () => {
          throw new SandboxClientError('AUTH', 'definitely_not_dispatched');
        }),
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('waiting_for_auth');
    expect(result.task.lastError).toMatchObject({
      code: 'AuthError',
      userMessage: 'Sandbox authentication is required. Update the Sandbox Token in Settings.',
    });
    expect(result.checkpoint.pendingToolCall).toMatchObject({
      callId: 'call_exec',
      executionState: 'recorded',
    });
    database.close();
  });

  it('enforces an independent 128-call Sandbox ceiling', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('sandbox-limit'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Stop an unbounded Sandbox loop',
    });
    let turn = 0;
    const execute = vi.fn<SandboxExecutionPort['execute']>(async () =>
      JSON.stringify({ code: 0, content: '', truncated: false }),
    );
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            turn += 1;
            yield sandboxCall(`call_read_${String(turn)}`, 'sandbox_read', {
              path: '/skills/example/SKILL.md',
              startLine: turn,
              maxLines: 1,
            });
          })(),
      },
      tavily: tavilyPort(),
      browser: browserPort(),
      sandbox: { execute },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('failed');
    expect(result.task.lastError).toMatchObject({
      code: 'ToolCallLimitError',
      userMessage: 'The task exceeded the Sandbox tool-call limit.',
    });
    expect(execute).toHaveBeenCalledTimes(128);
    expect(result.checkpoint.completedToolResults).toHaveLength(128);
    database.close();
  });

  it('keeps the durable target while inspecting and closing explicit background tabs', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('browser-target'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Compare another tab',
    });
    let turn = 0;
    const planner = {
      plan: () =>
        (async function* () {
          turn += 1;
          if (turn === 1) {
            yield browserCall('call_open_background', 'browser_open_tab', {
              url: 'https://example.com/background',
              activate: false,
            });
          } else if (turn === 2) {
            yield browserCall('call_inspect_background', 'browser_inspect', {
              tabId: 22,
              mode: 'content',
            });
          } else if (turn === 3) {
            yield browserCall('call_close', 'browser_close_tab', { tabId: 22 });
          } else {
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          }
        })(),
    };
    const execute = vi.fn<BrowserExecutionPort['execute']>(async (call) => ({
      output: JSON.stringify({
        ok: true,
        tabId: call.operation === 'open_tab' ? 91 : 22,
      }),
      attachmentIds: [],
    }));
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      tavily: tavilyPort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    const contexts = execute.mock.calls.map(([, , context]) => context);
    expect(contexts.map((context) => context?.currentTabId)).toEqual([7, 7, 7]);
    expect(new Set(contexts.map((context) => context?.sessionOwnerId)).size).toBe(1);
    expect(contexts[0]?.sessionOwnerId).toMatch(/^runner_/);
    expect(result.checkpoint.browserTargetTabId).toBe(7);
    database.close();
  });

  it('never replays a browser mutation that may already have been dispatched', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('browser-ambiguous'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Click once',
    });
    let turn = 0;
    const planner = {
      plan: () =>
        (async function* () {
          turn += 1;
          if (turn === 1) {
            yield browserCall('call_click', 'browser_click', {
              tabId: 7,
              ref: 'ref_1',
              button: 'left',
              count: 1,
            });
          } else {
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          }
        })(),
    };
    const execute = vi.fn(async () => {
      throw new DOMException('Worker stopped after dispatch.', 'AbortError');
    });
    const release = vi.fn(async () => undefined);
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      tavily: tavilyPort(),
      browser: browserPort({ execute, release }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
    await expect(commands.getSnapshot(created.task.id)).resolves.toMatchObject({
      checkpoint: {
        pendingToolCall: {
          callId: 'call_click',
          executionState: 'may_have_dispatched',
        },
      },
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledOnce();
    expect(recovered.task.status).toBe('completed');
    const ambiguous = recovered.checkpoint.completedToolResults.find(
      ({ callId }) => callId === 'call_click',
    );
    expect(JSON.parse(ambiguous?.output ?? '{}')).toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_MUTATION',
      needsInspect: true,
    });
    expect(release).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('runs a pure model turn without invoking Tavily', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('text-executor'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Answer this message',
    });
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>(() =>
      (async function* () {
        yield {
          type: 'reasoning.summary',
          text: 'Verified the available context.',
        };
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        };
      })(),
    );
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map((event) => event.type)).toEqual([
      'planning.started',
      'reasoning.summary-recorded',
      'task.completed',
    ]);
    expect(result.events[1]).toMatchObject({
      reasoningSummary: 'Verified the available context.',
    });
    expect(plan).toHaveBeenCalledOnce();
    database.close();
  });

  it('retries one transient model failure without pausing the task', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('transient-retry'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Retry one stalled model response',
    });
    let attempt = 0;
    const plan = vi.fn(() =>
      (async function* () {
        attempt += 1;
        if (attempt === 1) {
          throw providerErrorFromCode('TRANSIENT');
        }
        yield {
          type: 'task.completed' as const,
          reason: 'retried',
          messageId: 'message_retry',
        };
      })(),
    );
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map((event) => event.type)).toEqual([
      'planning.started',
      'task.completed',
    ]);
    expect(plan).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('keeps a completed reasoning summary and pauses after two transient failures', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('reasoning-failure'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Keep the reasoning summary',
    });
    let attempt = 0;
    const plan = vi.fn(() =>
      (async function* () {
        attempt += 1;
        if (attempt === 1) {
          yield {
            type: 'reasoning.summary' as const,
            text: 'Checked the source before the outage.',
          };
        }
        throw providerErrorFromCode('TRANSIENT');
      })(),
    );
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('paused');
    expect(result.events.map((event) => event.type)).toEqual([
      'planning.started',
      'reasoning.summary-recorded',
      'task.paused',
    ]);
    expect(result.events[1]).toMatchObject({
      reasoningSummary: 'Checked the source before the outage.',
    });
    expect(plan).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('checkpoints sequential search and extract results before replanning to a final answer', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('tool-loop-executor'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Research authentication',
    });
    const inputs: AgentPlanInput[] = [];
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>((input) => {
      inputs.push(input);
      const turn = inputs.length;
      return (async function* () {
        if (turn === 1) {
          yield searchCall('call_search');
        } else if (turn === 2) {
          yield {
            type: 'tavily.call',
            operation: 'extract',
            callId: 'call_extract',
            argumentsJson:
              '{"urls":["https://example.com/a"],"query":"auth","extractDepth":"basic"}',
            arguments: {
              urls: ['https://example.com/a'],
              query: 'auth',
              extractDepth: 'basic',
            },
          };
        } else {
          yield {
            type: 'task.completed',
            reason: 'model_response_completed',
            messageId: 'message_answer',
          };
        }
      })();
    });
    const tavily = tavilyPort({
      search: vi.fn(async () => {
        const pending = await commands.getSnapshot(created.task.id);
        expect(pending.checkpoint.pendingToolCall).toMatchObject({
          callId: 'call_search',
          name: 'tavily_search',
        });
        expect(pending.checkpoint.continuationItems.at(-1)).toMatchObject({
          type: 'function_call',
          callId: 'call_search',
        });
        return {
          results: [
            {
              title: 'Search result',
              url: 'https://example.com/a',
              content: 'Authentication overview',
              score: 0.9,
              source: 'search' as const,
            },
          ],
          truncated: false,
        };
      }),
      extract: vi.fn(async () => ({
        results: [
          {
            title: null,
            url: 'https://example.com/a',
            content: '# Authentication',
            score: null,
            source: 'extract' as const,
          },
        ],
        truncated: false,
      })),
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map(({ type }) => type)).toEqual([
      'planning.started',
      'tool.call-recorded',
      'tool.result-recorded',
      'tool.call-recorded',
      'tool.result-recorded',
      'task.completed',
    ]);
    expect(inputs.map(({ checkpoint }) => checkpoint.completedToolResults.length)).toEqual([
      0, 1, 2,
    ]);
    expect(result.checkpoint.completedToolResults).toHaveLength(2);
    expect(result.checkpoint.completedToolResults[0]).toMatchObject({
      callId: 'call_search',
      toolName: 'tavily_search',
      argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
    });
    expect(JSON.parse(result.checkpoint.completedToolResults[0]?.output ?? '')).toMatchObject({
      ok: true,
      results: [{ content: 'Authentication overview', source: 'search' }],
      truncated: false,
    });
    expect(result.checkpoint.completedToolResults[1]).toMatchObject({
      callId: 'call_extract',
      toolName: 'tavily_extract',
    });
    expect(
      result.checkpoint.completedToolResults.every(({ resultRef }) => resultRef.length > 0),
    ).toBe(true);
    expect(tavily.search).toHaveBeenCalledOnce();
    expect(tavily.extract).toHaveBeenCalledOnce();
    database.close();
  });

  it('compacts through the requested cursor while retaining later results and full audit', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('context-commit-executor'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Research and preserve only the stable working state',
      userMessageId: 'message_user',
    });
    const transitions: Parameters<typeof repository.saveTransition>[0][] = [];
    const originalSaveTransition = repository.saveTransition.bind(repository);
    vi.spyOn(repository, 'saveTransition').mockImplementation(async (input) => {
      transitions.push(input);
      await originalSaveTransition(input);
    });
    const inputs: AgentPlanInput[] = [];
    const commitState =
      'Goal: finish the research. Verified: the search completed. Next: answer the user.';
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>((input) => {
      inputs.push(input);
      return (async function* () {
        if (inputs.length === 1) {
          yield searchCall('call_search_1');
        } else if (inputs.length === 2) {
          yield searchCall('call_search_2');
        } else if (inputs.length === 3) {
          yield contextCommitCall('call_commit', commitState, 'call_search_1');
        } else {
          yield {
            type: 'task.completed',
            reason: 'model_response_completed',
            messageId: 'message_answer',
          };
        }
      })();
    });
    const tavily = tavilyPort();
    const resetObservationBaselines = vi.fn();
    const browser = browserPort({ resetObservationBaselines });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser,
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map(({ type }) => type)).toEqual([
      'planning.started',
      'tool.call-recorded',
      'tool.result-recorded',
      'tool.call-recorded',
      'tool.result-recorded',
      'tool.call-recorded',
      'tool.result-recorded',
      'task.completed',
    ]);
    const commitBoundary = transitions.find(
      ({ event }) =>
        event.type === 'tool.call-recorded' && event.reason === 'commit_context_call_recorded',
    );
    expect(commitBoundary?.checkpoint.pendingToolCall).toEqual({
      callId: 'call_commit',
      name: 'commit_context',
      argumentsJson: JSON.stringify({
        state: commitState,
        throughCallId: 'call_search_1',
      }),
      executionState: 'recorded',
    });
    expect(result.checkpoint.completedToolResults.map(({ toolName }) => toolName)).toEqual([
      'tavily_search',
      'tavily_search',
      'commit_context',
    ]);
    expect(inputs[3]?.checkpoint.continuationItems).toEqual([
      { type: 'message_ref', messageId: 'message_user' },
      {
        type: 'function_call',
        callId: 'call_commit',
        name: 'commit_context',
        argumentsJson: JSON.stringify({
          state: commitState,
          throughCallId: 'call_search_1',
        }),
      },
      expect.objectContaining({
        type: 'function_call_output_ref',
        callId: 'call_commit',
        attachmentIds: [],
      }),
      {
        type: 'function_call',
        callId: 'call_search_2',
        name: 'tavily_search',
        argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
      },
      expect.objectContaining({
        type: 'function_call_output_ref',
        callId: 'call_search_2',
        attachmentIds: [],
      }),
    ]);
    expect(
      JSON.parse(
        inputs[3]?.checkpoint.completedToolResults.find((item) => item.callId === 'call_commit')
          ?.output ?? '',
      ),
    ).toMatchObject({ ok: true, compactedCalls: 1, releasedImages: 0 });
    expect(tavily.search).toHaveBeenCalledTimes(2);
    expect(resetObservationBaselines).toHaveBeenCalledOnce();
    expect(browser.execute).not.toHaveBeenCalled();
    database.close();
  });

  it('recovers an invalid context commit cursor without discarding raw tool history', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('invalid-context-commit-cursor'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Recover a browser task after a bad commit cursor',
      userMessageId: 'message_user',
    });
    const inputs: AgentPlanInput[] = [];
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>((input) => {
      inputs.push(input);
      return (async function* () {
        if (inputs.length === 1) {
          yield searchCall('call_search');
          return;
        }
        if (inputs.length === 2) {
          yield contextCommitCall(
            'call_bad_commit',
            'The search result is preserved. Next: continue the browser task.',
            'call_hallucinated',
          );
          return;
        }
        if (inputs.length === 3) {
          yield contextCommitCall(
            'call_good_commit',
            'The search result is preserved. Next: continue the browser task.',
            'call_search',
          );
          return;
        }
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        };
      })();
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(inputs).toHaveLength(4);
    const retryInput = inputs[2]?.checkpoint;
    expect(
      retryInput?.continuationItems.some(
        (item) => item.type === 'function_call' && item.callId === 'call_search',
      ),
    ).toBe(true);
    expect(
      retryInput?.completedToolResults.find((item) => item.callId === 'call_bad_commit'),
    ).toMatchObject({
      output: JSON.stringify({
        ok: false,
        code: 'INVALID_CONTEXT_COMMIT_CURSOR',
        message:
          'throughCallId did not match a current completed non-commit tool call. Retry commit_context with one of validThroughCallIds.',
        validThroughCallIds: ['call_search'],
      }),
    });
    expect(result.checkpoint.completedToolResults.map(({ callId }) => callId)).toEqual([
      'call_search',
      'call_bad_commit',
      'call_good_commit',
    ]);
    expect(
      result.checkpoint.continuationItems.some(
        (item) =>
          'callId' in item && (item.callId === 'call_search' || item.callId === 'call_bad_commit'),
      ),
    ).toBe(false);
    database.close();
  });

  it('allows an internal context commit after the Tavily family reaches its call limit', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('context-commit-after-tavily-limit'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Commit after bounded research',
    });
    let turn = 0;
    const plan = () =>
      (async function* () {
        turn += 1;
        if (turn <= 8) {
          yield searchCall(`call_search_${turn}`);
        } else if (turn === 9) {
          yield contextCommitCall(
            'call_commit',
            'Eight searches completed. Next: answer.',
            'call_search_8',
          );
        } else {
          yield {
            type: 'task.completed',
            reason: 'model_response_completed',
            messageId: 'message_answer',
          } as const;
        }
      })();
    const tavily = tavilyPort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(turn).toBe(10);
    expect(tavily.search).toHaveBeenCalledTimes(8);
    expect(result.checkpoint.completedToolResults.at(-1)?.toolName).toBe('commit_context');
    database.close();
  });

  it('resumes from a persisted tool result without executing that call again', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('tool-recovery-executor'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Recover research',
    });
    let turn = 0;
    const seenResultCounts: number[] = [];
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>((input) => {
      seenResultCounts.push(input.checkpoint.completedToolResults.length);
      turn += 1;
      return (async function* () {
        if (turn === 1) yield searchCall('call_search');
        else if (turn === 2) throw new DOMException('Worker stopped.', 'AbortError');
        else
          yield {
            type: 'task.completed',
            reason: 'model_response_completed',
            messageId: 'message_answer',
          };
      })();
    });
    const tavily = tavilyPort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    const interrupted = await commands.getSnapshot(created.task.id);
    expect(interrupted).toMatchObject({
      task: { status: 'planning' },
      checkpoint: { completedToolResults: [{ callId: 'call_search' }] },
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);
    expect(recovered.task.status).toBe('completed');
    expect(seenResultCounts).toEqual([0, 1, 1]);
    expect(tavily.search).toHaveBeenCalledOnce();
    database.close();
  });

  it('executes a persisted pending Tavily call before asking the planner again', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('pending-tool-recovery'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Recover the pending call',
    });
    const order: string[] = [];
    let plannerCalls = 0;
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>(() => {
      plannerCalls += 1;
      order.push(`planner_${plannerCalls}`);
      return (async function* () {
        if (plannerCalls === 1) yield searchCall('call_pending');
        else
          yield {
            type: 'task.completed',
            reason: 'model_response_completed',
            messageId: 'message_answer',
          };
      })();
    });
    let tavilyCalls = 0;
    const tavily = tavilyPort({
      search: vi.fn(async () => {
        tavilyCalls += 1;
        order.push(`tavily_${tavilyCalls}`);
        if (tavilyCalls === 1) throw providerErrorFromCode('ABORTED');
        return { results: [], truncated: false };
      }),
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { code: 'ABORTED' },
    );
    await expect(commands.getSnapshot(created.task.id)).resolves.toMatchObject({
      task: { status: 'planning' },
      checkpoint: {
        completedToolResults: [],
        pendingToolCall: { callId: 'call_pending', name: 'tavily_search' },
      },
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(recovered.task.status).toBe('completed');
    expect(order).toEqual(['planner_1', 'tavily_1', 'tavily_2', 'planner_2']);
    expect(plan).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('finishes a running tool before applying a supplement to the next planner turn', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('tool-supplement'));
    const repository = new IndexedDbTaskRepository(database);
    const conversations = new IndexedDbConversationRepository(database);
    const dependencies = sources();
    await seedConversation(database, {
      id: 'conversation_1',
      tabId: 7,
      title: 'Research this',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await conversations.appendMessage({
      id: 'message_user',
      kind: 'conversation',
      conversationId: 'conversation_1',
      taskId: null,
      role: 'user',
      status: 'complete',
      text: 'Research this',
      attachmentIds: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Research this',
      userMessageId: 'message_user',
    });
    const [userMessage] = await conversations.listMessages('conversation_1');
    if (userMessage === undefined) throw new Error('User message fixture is missing.');
    await conversations.updateMessage({
      ...userMessage,
      taskId: created.task.id,
    });
    let turn = 0;
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>((input) => {
      turn += 1;
      return (async function* () {
        if (turn === 1) {
          yield searchCall('call_search');
          return;
        }
        expect(input.checkpoint.continuationItems.slice(-3)).toEqual([
          expect.objectContaining({
            type: 'function_call_output_ref',
            callId: 'call_search',
          }),
          { type: 'message_ref', messageId: 'supplement_during_tool' },
          { type: 'message_ref', messageId: 'supplement_during_tool_2' },
        ]);
        await conversations.appendMessage({
          id: 'message_answer',
          kind: 'conversation',
          conversationId: 'conversation_1',
          taskId: created.task.id,
          role: 'assistant',
          status: 'complete',
          text: 'Finished with the additional detail.',
          attachmentIds: [],
          createdAt: dependencies.clock.now(),
          updatedAt: dependencies.clock.now(),
        });
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        };
      })();
    });
    const tavily = tavilyPort({
      search: vi.fn(async () => {
        await conversations.appendSupplement({
          id: 'supplement_during_tool',
          kind: 'supplement',
          conversationId: 'conversation_1',
          taskId: created.task.id,
          role: 'user',
          status: 'complete',
          text: 'Prioritize official sources.',
          attachmentIds: [],
          createdAt: dependencies.clock.now(),
          updatedAt: dependencies.clock.now(),
        });
        await conversations.appendSupplement({
          id: 'supplement_during_tool_2',
          kind: 'supplement',
          conversationId: 'conversation_1',
          taskId: created.task.id,
          role: 'user',
          status: 'complete',
          text: 'Include the mobile layout.',
          attachmentIds: [],
          createdAt: dependencies.clock.now(),
          updatedAt: dependencies.clock.now(),
        });
        return { results: [], truncated: false };
      }),
    });
    const executor = new TaskExecutor({
      repository,
      conversations,
      planner: { plan },
      tavily,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.events.map(({ type }) => type)).toEqual([
      'planning.started',
      'tool.call-recorded',
      'tool.result-recorded',
      'task.supplements-applied',
      'task.completed',
    ]);
    expect(
      result.events.find(({ type }) => type === 'task.supplements-applied')?.supplementIds,
    ).toEqual(['supplement_during_tool', 'supplement_during_tool_2']);
    expect(plan).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('keeps one reply bubble and replans when a supplement wins the completion race', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('completion-supplement'));
    const repository = new IndexedDbTaskRepository(database);
    const conversations = new IndexedDbConversationRepository(database);
    const dependencies = sources();
    await seedConversation(database, {
      id: 'conversation_1',
      tabId: 7,
      title: 'Answer this',
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await conversations.appendMessage({
      id: 'message_user',
      kind: 'conversation',
      conversationId: 'conversation_1',
      taskId: null,
      role: 'user',
      status: 'complete',
      text: 'Answer this',
      attachmentIds: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Answer this',
      userMessageId: 'message_user',
    });
    const [userMessage] = await conversations.listMessages('conversation_1');
    if (userMessage === undefined) throw new Error('User message fixture is missing.');
    await conversations.updateMessage({
      ...userMessage,
      taskId: created.task.id,
    });
    let turn = 0;
    const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>((input) => {
      turn += 1;
      return (async function* () {
        const existing = (await conversations.listMessages('conversation_1')).find(
          ({ id }) => id === 'message_answer',
        );
        if (turn === 1) {
          await conversations.appendMessage({
            id: 'message_answer',
            kind: 'conversation',
            conversationId: 'conversation_1',
            taskId: created.task.id,
            role: 'assistant',
            status: 'complete',
            text: 'First answer',
            attachmentIds: [],
            createdAt: dependencies.clock.now(),
            updatedAt: dependencies.clock.now(),
          });
          await conversations.appendSupplement({
            id: 'supplement_during_model',
            kind: 'supplement',
            conversationId: 'conversation_1',
            taskId: created.task.id,
            role: 'user',
            status: 'complete',
            text: 'Add the missing detail.',
            attachmentIds: [],
            createdAt: dependencies.clock.now(),
            updatedAt: dependencies.clock.now(),
          });
        } else {
          expect(input.checkpoint.continuationItems.at(-1)).toEqual({
            type: 'message_ref',
            messageId: 'supplement_during_model',
          });
          expect(existing).toMatchObject({
            status: 'interrupted',
            text: 'First answer',
          });
          if (existing === undefined) throw new Error('Assistant message fixture is missing.');
          await conversations.updateMessage({
            ...existing,
            status: 'complete',
            text: 'Revised answer with the missing detail.',
            updatedAt: dependencies.clock.now(),
          });
        }
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        };
      })();
    });
    const executor = new TaskExecutor({
      repository,
      conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);
    const assistantMessages = (await conversations.listMessages('conversation_1')).filter(
      ({ role }) => role === 'assistant',
    );

    expect(result.task.status).toBe('completed');
    expect(result.events.map(({ type }) => type)).toEqual([
      'planning.started',
      'task.supplements-applied',
      'task.completed',
    ]);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(assistantMessages).toEqual([
      expect.objectContaining({
        id: 'message_answer',
        status: 'complete',
        text: 'Revised answer with the missing detail.',
      }),
    ]);
    database.close();
  });

  it('fails safely when the model repeats an already completed call ID', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('duplicate-tool-call'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Reject duplicate calls',
    });
    let turn = 0;
    const plan = () =>
      (async function* () {
        turn += 1;
        yield searchCall('call_duplicate');
      })();
    const tavily = tavilyPort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(turn).toBe(2);
    expect(result.task).toMatchObject({
      status: 'failed',
      lastError: { code: 'InvalidProviderResponse', retryable: false },
    });
    expect(dependencies.conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation_1',
        taskId: created.task.id,
        role: 'assistant',
        status: 'error',
        text: '',
      }),
    );
    expect(tavily.search).toHaveBeenCalledOnce();
    database.close();
  });

  it('fails before a ninth completed Tavily call can execute', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('tool-call-limit'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Bound tool calls',
    });
    let turn = 0;
    const plan = () =>
      (async function* () {
        turn += 1;
        yield searchCall(`call_${String(turn)}`);
      })();
    const tavily = tavilyPort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(turn).toBe(9);
    expect(tavily.search).toHaveBeenCalledTimes(8);
    expect(result.task).toMatchObject({
      status: 'failed',
      lastError: { code: 'ToolCallLimitError', retryable: false },
    });
    expect(result.checkpoint.completedToolResults).toHaveLength(8);
    database.close();
  });

  it('does not charge retained browser audit results against a fresh execution attempt', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('browser-audit-budget-separation'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Continue after compacted browser work',
    });
    const planningAt = created.task.updatedAt;
    const auditResults = Array.from({ length: 256 }, (_, index) => ({
      callId: `call_audit_${String(index + 1)}`,
      toolName: 'browser_inspect',
      argumentsJson: '{"tabId":0,"mode":"interactive","since":""}',
      output: '{"ok":true}',
      resultRef: `result_audit_${String(index + 1)}`,
      attachmentIds: [],
    }));
    const planningCheckpoint = {
      ...created.checkpoint,
      id: 'checkpoint_compacted_browser_audit',
      sequence: 1,
      taskStatus: 'planning' as const,
      completedToolResults: auditResults,
      continuationItems: [],
      browserToolCallsInAttempt: 0,
      createdAt: planningAt,
    };
    await repository.saveTransition({
      task: {
        ...created.task,
        status: 'planning',
        checkpointId: planningCheckpoint.id,
        updatedAt: planningAt,
      },
      event: {
        id: 'event_compacted_browser_audit',
        taskId: created.task.id,
        sequence: 1,
        type: 'planning.started',
        reason: 'model_request_started',
        at: planningAt,
        error: null,
      },
      checkpoint: planningCheckpoint,
    });
    let turn = 0;
    const plan = () =>
      (async function* () {
        turn += 1;
        if (turn === 1) {
          yield browserCall('call_fresh_browser', 'browser_get_current_tab', {});
          return;
        }
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        } as const;
      })();
    const browser = browserPort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser,
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(browser.execute).toHaveBeenCalledOnce();
    expect(result.checkpoint).toMatchObject({ browserToolCallsInAttempt: 1 });
    expect(result.checkpoint.completedToolResults).toHaveLength(257);
    database.close();
  });

  it('allows 256 browser calls in one execution attempt and rejects the next call', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('browser-attempt-call-limit'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Run a long browser workflow',
    });
    let turn = 0;
    const plan = () =>
      (async function* () {
        turn += 1;
        yield browserCall(`call_browser_${String(turn)}`, 'browser_get_current_tab', {});
      })();
    let browserResult = 0;
    const browser = browserPort({
      execute: vi.fn(async () => ({
        output: JSON.stringify({
          ok: true,
          data: { sequence: ++browserResult },
        }),
        attachmentIds: [],
      })),
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser,
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(turn).toBe(257);
    expect(browser.execute).toHaveBeenCalledTimes(256);
    expect(result.task).toMatchObject({
      status: 'failed',
      lastError: { code: 'ToolCallLimitError', retryable: false },
    });
    expect(result.checkpoint).toMatchObject({ browserToolCallsInAttempt: 256 });
    database.close();
  });

  it('resets the browser execution budget only after an explicit retry', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('browser-attempt-retry-budget'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Retry a bounded browser workflow',
    });
    const planningAt = created.task.updatedAt;
    const exhaustedCheckpoint = {
      ...created.checkpoint,
      id: 'checkpoint_exhausted_browser_attempt',
      sequence: 1,
      taskStatus: 'planning' as const,
      browserToolCallsInAttempt: 256,
      createdAt: planningAt,
    };
    await repository.saveTransition({
      task: {
        ...created.task,
        status: 'planning',
        checkpointId: exhaustedCheckpoint.id,
        updatedAt: planningAt,
      },
      event: {
        id: 'event_exhausted_browser_attempt',
        taskId: created.task.id,
        sequence: 1,
        type: 'planning.started',
        reason: 'model_request_started',
        at: planningAt,
        error: null,
      },
      checkpoint: exhaustedCheckpoint,
    });
    let mode: 'exhausted' | 'retry' = 'exhausted';
    let retryTurn = 0;
    const plan = () =>
      (async function* () {
        if (mode === 'exhausted') {
          yield browserCall('call_over_budget', 'browser_get_current_tab', {});
          return;
        }
        retryTurn += 1;
        if (retryTurn === 1) {
          yield browserCall('call_after_retry', 'browser_get_current_tab', {});
          return;
        }
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        } as const;
      })();
    const browser = browserPort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      tavily: tavilyPort(),
      browser,
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const exhausted = await executor.run(created.task.id, new AbortController().signal);

    expect(exhausted.task.status).toBe('failed');
    expect(browser.execute).not.toHaveBeenCalled();

    mode = 'retry';
    const retried = await commands.retry(created.task.id);
    expect(retried.checkpoint).toMatchObject({ browserToolCallsInAttempt: 0 });

    const completed = await executor.run(created.task.id, new AbortController().signal);

    expect(completed.task.status).toBe('completed');
    expect(browser.execute).toHaveBeenCalledOnce();
    expect(completed.checkpoint).toMatchObject({
      browserToolCallsInAttempt: 1,
    });
    database.close();
  });

  it('persists authentication failures as an explicit resumable boundary', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('auth-executor'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Answer this message',
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield* [];
            throw providerErrorFromCode('AUTH', { status: 401 });
          })(),
      },
      tavily: tavilyPort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({
      task: {
        status: 'waiting_for_auth',
        lastError: { code: 'AuthError', recoveryAction: 'update_credentials' },
      },
    });
    database.close();
  });

  it('fails durably when task input cannot be prepared instead of remaining stuck in planning', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('input-error-executor'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Answer this message',
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield* [];
            throw new Error('private attachment detail');
          })(),
      },
      tavily: tavilyPort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({
      task: {
        status: 'failed',
        lastError: {
          code: 'TaskInputError',
          userMessage: 'Task input could not be prepared.',
        },
      },
    });
    expect(dependencies.conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: created.task.id,
        role: 'assistant',
        status: 'error',
        text: '',
      }),
    );
    database.close();
  });

  it('keeps an existing failed reply instead of appending an empty replacement', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('existing-failed-reply'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Keep partial output',
    });
    dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_partial',
        kind: 'conversation',
        conversationId: 'conversation_1',
        taskId: created.task.id,
        role: 'assistant',
        status: 'error',
        text: 'Already generated reply',
        attachmentIds: [],
        createdAt: 1_000,
        updatedAt: 1_001,
      },
    ]);
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield* [];
            throw providerErrorFromCode('INVALID_RESPONSE');
          })(),
      },
      tavily: tavilyPort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({ task: { status: 'failed' } });
    expect(dependencies.conversations.appendMessage).not.toHaveBeenCalled();
    database.close();
  });

  it.each([
    ['AUTH', 'waiting_for_auth', 'AuthError'],
    ['RATE_LIMIT', 'paused', 'RateLimitError'],
    ['TRANSIENT', 'paused', 'TransientProviderError'],
    ['INVALID_RESPONSE', 'failed', 'InvalidProviderResponse'],
  ] as const)(
    'maps Tavily %s failures to a durable %s boundary',
    async (code, status, taskCode) => {
      const database = await openChatBrowserDatabase(createTestDatabaseName(`tavily-${code}`));
      const repository = new IndexedDbTaskRepository(database);
      const dependencies = sources();
      const commands = new TaskCommandService(
        repository,
        dependencies.clock,
        dependencies.ids,
        dependencies.conversations,
      );
      const created = await commands.create({
        conversationId: 'conversation_1',
        tabId: 7,
        goal: 'Handle Tavily failure',
      });
      const executor = new TaskExecutor({
        repository,
        conversations: dependencies.conversations,
        planner: {
          plan: () =>
            (async function* () {
              yield searchCall('call_failure');
            })(),
        },
        tavily: tavilyPort({
          search: vi.fn(async () => {
            throw providerErrorFromCode(code);
          }),
        }),
        browser: browserPort(),
        clock: dependencies.clock,
        ids: dependencies.ids,
      });

      const result = await executor.run(created.task.id, new AbortController().signal);

      expect(result.task).toMatchObject({
        status,
        lastError: { code: taskCode },
      });
      if (code === 'AUTH') {
        expect(result.task.lastError?.userMessage).toMatch(/tavily/i);
      }
      expect(result.checkpoint.completedToolResults).toEqual([]);
      database.close();
    },
  );

  it('propagates an aborted Tavily request and leaves the task at its recoverable checkpoint', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('tavily-aborted'));
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Abort Tavily request',
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield searchCall('call_aborted');
          })(),
      },
      tavily: tavilyPort({
        search: vi.fn(async () => {
          throw providerErrorFromCode('ABORTED');
        }),
      }),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { code: 'ABORTED' },
    );
    await expect(commands.getSnapshot(created.task.id)).resolves.toMatchObject({
      task: { status: 'planning' },
      checkpoint: { completedToolResults: [] },
    });
    database.close();
  });

  it('persists native compaction as a hidden planning boundary and continues the loop', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('native-context-compaction-boundary'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const dependencies = sources();
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      dependencies.conversations,
    );
    const created = await commands.create({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Continue after compacting local process context',
    });
    let turn = 0;
    const browser = browserPort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            turn += 1;
            if (turn === 1) {
              yield {
                type: 'context.compacted',
                continuationItems: [
                  {
                    type: 'compaction',
                    itemId: 'cmp_native',
                    encryptedContent: 'opaque-native-context',
                  },
                ],
              } as const;
              return;
            }
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          })(),
      },
      tavily: tavilyPort(),
      browser,
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map(({ type }) => type)).toContain('task.context-compacted');
    expect(result.checkpoint.continuationItems).toEqual([
      {
        type: 'compaction',
        itemId: 'cmp_native',
        encryptedContent: 'opaque-native-context',
      },
      { type: 'message_ref', messageId: 'message_answer' },
    ]);
    expect(browser.resetObservationBaselines).toHaveBeenCalledOnce();
    database.close();
  });
});
