// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { TaskExecutor } from '../../src/agent/task-executor';
import type { AgentEvent, AgentPlanInput } from '../../src/agent/execution-types';
import { parseBrowserToolCall } from '../../src/agent/tools/browser-tool-schema';
import { parseContextCommitToolCall } from '../../src/agent/tools/context-commit-tool-schema';
import type { BrowserExecutionPort } from '../../src/browser/browser-execution-types';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { IndexedDbConversationRepository } from '../../src/persistence/conversation-repository';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import type { TavilyExecutionPort } from '../../src/providers/tavily/tavily-types';
import { TaskCommandService } from '../../src/tasks/task-command-service';
import type { MessageRecord } from '../../src/tasks/message-types';
import { createTestDatabaseName } from '../persistence/test-helpers';

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

function contextCommitCall(callId: string, state: string): AgentEvent {
  return {
    type: 'context.commit',
    call: parseContextCommitToolCall({
      callId,
      name: 'commit_context',
      argumentsJson: JSON.stringify({ state }),
    }),
  };
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

  it('safely completes a recorded pending context commit after executor restart', async () => {
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
    const argumentsJson = JSON.stringify({ state: 'Search completed. Next: answer.' });
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
        (item) => item.type === 'function_call_output' && item.callId === 'call_screenshot',
      ),
    ).toMatchObject({
      type: 'function_call_output',
      callId: 'call_screenshot',
      attachmentIds: ['attachment_screenshot'],
    });
    expect(addReference).toHaveBeenCalledWith('attachment_screenshot', completed?.resultRef);
    expect(removeReference).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(expect.stringMatching(/^runner_/));
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
      {
        currentTabId: 7,
        sessionOwnerId: expect.stringMatching(/^runner_/),
      },
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

  it('moves the durable target across background tabs and clears a closed target', async () => {
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
    expect(contexts.map((context) => context?.currentTabId)).toEqual([7, 91, 22]);
    expect(new Set(contexts.map((context) => context?.sessionOwnerId)).size).toBe(1);
    expect(contexts[0]?.sessionOwnerId).toMatch(/^runner_/);
    expect(result.checkpoint.browserTargetTabId).toBeNull();
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

  it('keeps a completed reasoning summary when the same model turn later fails', async () => {
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
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield {
              type: 'reasoning.summary',
              text: 'Checked the source before the outage.',
            };
            throw providerErrorFromCode('TRANSIENT');
          })(),
      },
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

  it('records a context commit internally, compacts active continuation, and preserves audit results', async () => {
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
          yield searchCall('call_search');
        } else if (inputs.length === 2) {
          yield contextCommitCall('call_commit', commitState);
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
    const commitBoundary = transitions.find(
      ({ event }) =>
        event.type === 'tool.call-recorded' && event.reason === 'commit_context_call_recorded',
    );
    expect(commitBoundary?.checkpoint.pendingToolCall).toEqual({
      callId: 'call_commit',
      name: 'commit_context',
      argumentsJson: JSON.stringify({ state: commitState }),
      executionState: 'recorded',
    });
    expect(result.checkpoint.completedToolResults.map(({ toolName }) => toolName)).toEqual([
      'tavily_search',
      'commit_context',
    ]);
    expect(inputs[2]?.checkpoint.continuationItems).toEqual([
      { type: 'message_ref', messageId: 'message_user' },
      {
        type: 'function_call',
        callId: 'call_commit',
        name: 'commit_context',
        argumentsJson: JSON.stringify({ state: commitState }),
      },
      expect.objectContaining({
        type: 'function_call_output',
        callId: 'call_commit',
        attachmentIds: [],
      }),
    ]);
    expect(
      JSON.parse(
        inputs[2]?.checkpoint.continuationItems.find((item) => item.type === 'function_call_output')
          ?.output ?? '',
      ),
    ).toMatchObject({ ok: true, compactedCalls: 1, releasedImages: 0 });
    expect(tavily.search).toHaveBeenCalledOnce();
    expect(browser.execute).not.toHaveBeenCalled();
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
          yield contextCommitCall('call_commit', 'Eight searches completed. Next: answer.');
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
    await conversations.create({
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
            type: 'function_call_output',
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
    await conversations.create({
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
});
