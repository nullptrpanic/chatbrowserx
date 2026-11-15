// @vitest-environment node

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  TaskExecutor as ProductionTaskExecutor,
  type TaskExecutorDependencies,
} from '../../src/agent/task-executor';
import type { AgentEvent, AgentPlanInput } from '../../src/agent/execution-types';
import { parseBrowserToolCall } from '../../src/tools/browser/contract';
import type { BrowserExecutionPort } from '../../src/browser/browser-execution-types';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import {
  IndexedDbConversationRepository,
  type ConversationRepository,
} from '../../src/persistence/conversation-repository';
import { IndexedDbTaskRepository } from '../../src/persistence/task-repository';
import { providerErrorFromCode } from '../../src/providers/provider-error';
import {
  fixtureTools,
  fixtureService,
  fixtureError,
  type FixtureExecutionPort,
} from './fixtures/execution-tool';
interface AgentPlanner {
  plan(input: AgentPlanInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
import { SandboxClientError } from '../../src/sandbox/sandbox-client';
import type { SandboxExecutionPort } from '../../src/sandbox/sandbox-tool-executor';
import { TaskCommandService as DurableTaskCommandService } from '../../src/tasks/task-command-service';
import type { CreateTaskInput } from '../../src/tasks/task-factory';
import type { MessageRecord, TaskMessageDraft } from '../../src/tasks/message-types';
import { createTestDatabaseName, seedConversation } from '../persistence/test-helpers';
import type { TaskHistoryReaderPort } from '../../src/tasks/task-history-reader';
import { bindToolRuntime } from '../../src/tools/registry';
import { discoverTools } from '../../src/tools/discover';
import { ToolServiceResolver } from '../../src/tools/service-resolver';
import { historyService } from '../../src/tools/history/service';
import { createSandboxToolService, sandboxService } from '../../src/tools/sandbox/service';
import { browserService } from '../../src/tools/browser/service';

function sources() {
  let now = 1_000;
  let id = 0;
  const messages: MessageRecord[] = [];
  return {
    clock: { now: () => ++now },
    ids: { create: (prefix: string) => `${prefix}_${String(++id)}` },
    conversations: {
      listMessages: vi.fn(async () => [...messages]),
      listTaskMessages: vi.fn(async (taskId: string) =>
        messages.filter((message) => message.taskId === taskId),
      ),
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

/** Creates only valid message-backed submissions after the production empty-task path was removed. */
type ExecutorConversationStore = Pick<ConversationRepository, 'listMessages' | 'updateMessage'> & {
  readonly appendMessage?: (message: MessageRecord) => Promise<void>;
};

class TaskCommandService extends DurableTaskCommandService {
  readonly #clock: ReturnType<typeof sources>['clock'];
  readonly #ids: ReturnType<typeof sources>['ids'];
  readonly #conversations: ExecutorConversationStore;

  constructor(
    repository: IndexedDbTaskRepository,
    clock: ReturnType<typeof sources>['clock'],
    ids: ReturnType<typeof sources>['ids'],
    conversations: ExecutorConversationStore,
  ) {
    super(repository, clock, ids, conversations);
    this.#clock = clock;
    this.#ids = ids;
    this.#conversations = conversations;
  }

  async create(input: CreateTaskInput & { readonly userMessageId?: string }) {
    const now = this.#clock.now();
    const message: TaskMessageDraft = {
      id: input.userMessageId ?? this.#ids.create('message'),
      kind: 'conversation',
      conversationId: input.conversationId,
      role: 'user',
      status: 'complete',
      text: input.goal,
      attachmentIds: [],
      createdAt: now,
      updatedAt: now,
    };
    const conversation = {
      id: input.conversationId,
      tabId: input.tabId,
      title: input.goal,
      createdAt: now,
      updatedAt: now,
    };
    const submit = (createConversation: boolean) =>
      this.createSubmission({
        ...input,
        conversation,
        createConversation,
        message,
      });
    let snapshot;
    try {
      snapshot = await submit(true);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Conversation already exists.') {
        throw error;
      }
      snapshot = await submit(false);
    }
    if (
      this.#conversations.appendMessage !== undefined &&
      !(await this.#conversations.listMessages(input.conversationId)).some(
        ({ id }) => id === message.id,
      )
    ) {
      await this.#conversations.appendMessage({
        ...message,
        taskId: snapshot.task.id,
      });
    }
    return snapshot;
  }
}

async function seedExecutorConversation(
  database: Awaited<ReturnType<typeof openChatBrowserDatabase>>,
  title = 'Executor test',
): Promise<void> {
  if ((await database.get('conversations', 'conversation_1')) !== undefined) return;
  await seedConversation(database, {
    id: 'conversation_1',
    tabId: 7,
    title,
    createdAt: 1_000,
    updatedAt: 1_000,
  });
}

function fixturePort(overrides: Partial<FixtureExecutionPort> = {}): FixtureExecutionPort {
  return {
    isConfigured: vi.fn(async () => true),
    search: vi.fn(async () => ({ results: [], truncated: false })),
    extract: vi.fn(async () => ({ results: [], truncated: false })),
    crawl: vi.fn(async () => ({ results: [], truncated: false })),
    ...overrides,
  };
}

type TestTaskExecutorDependencies = Omit<TaskExecutorDependencies, 'tools' | 'runtime'> & {
  readonly planner: AgentPlanner;
  readonly fixture: FixtureExecutionPort;
  readonly history?: TaskHistoryReaderPort;
  readonly sandbox?: SandboxExecutionPort;
  readonly browser: BrowserExecutionPort;
};

/** Binds legacy test doubles through the same registered runtime used by production Agent setup. */
class TaskExecutor extends ProductionTaskExecutor {
  constructor(dependencies: TestTaskExecutorDependencies) {
    const { fixture, history, sandbox, browser, planner, ...executorDependencies } = dependencies;
    const services = new ToolServiceResolver();
    services.bind(fixtureService, fixture);
    services.bind(browserService, browser);
    if (history !== undefined) services.bind(historyService, history);
    if (sandbox !== undefined) {
      services.bind(sandboxService, createSandboxToolService(sandbox));
    }
    super({
      ...executorDependencies,
      tools: bindToolRuntime([...discoverTools(), ...fixtureTools], services),
      runtime: {
        async run(hooks, signal) {
          // These tests exercise host recovery/effect guards; framework iteration has its own tests.
          while (!signal.aborted) {
            const input = await hooks.prepare();
            let observed = false;
            for await (const event of planner.plan(input, signal)) {
              observed = true;
              const result = await hooks.observe(event);
              if (result.task.status !== 'planning') return;
            }
            if (!observed) throw new Error('Scripted runtime did not produce an event.');
          }
          throw new DOMException('Aborted', 'AbortError');
        },
      },
    });
  }
}

function browserPort(overrides: Partial<BrowserExecutionPort> = {}): BrowserExecutionPort {
  return {
    execute: vi.fn(async () => ({ output: '{"ok":true}', attachmentIds: [] })),
    resetObservationBaselines: vi.fn(),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}

const SEARCH_ARGUMENTS = {
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
    type: 'tool.call',
    call: {
      callId,
      name: 'fixture_search',
      argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
      arguments: SEARCH_ARGUMENTS,
    },
  };
}

function browserCall(callId: string, name: string, arguments_: unknown): AgentEvent {
  return {
    type: 'tool.call',
    call: parseBrowserToolCall({
      callId,
      name,
      argumentsJson: JSON.stringify(arguments_),
    }),
  };
}

function sandboxCall(callId: string, name: string, arguments_: unknown): AgentEvent {
  return {
    type: 'tool.call',
    call: {
      callId,
      name,
      argumentsJson: JSON.stringify(arguments_),
      arguments: arguments_,
    },
  };
}

async function runBrowserProgressScenario(
  databaseName: string,
  calls: readonly AgentEvent[],
  execute: BrowserExecutionPort['execute'],
  configure?: (context: {
    readonly taskId: string;
    readonly appendMessage: (message: MessageRecord) => Promise<void>;
    readonly appendSupplement: (message: MessageRecord) => Promise<void>;
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
    appendSupplement: async (message) => {
      await commands.appendSupplement(message);
      await dependencies.conversations.appendMessage(message);
    },
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
    fixture: fixturePort(),
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
  it.each(['continue', 'blocked', 'no-progress', 'user-stop'] as const)(
    'reviews recorded progress before finishing (%s)',
    async (mode) => {
      const database = await openChatBrowserDatabase(createTestDatabaseName(`completion-${mode}`));
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
        goal: 'Move Alpha and Beta',
      });
      const initial = {
        scope: 'Move Alpha and Beta',
        inventoryComplete: true,
        inventoryEvidence: 'Both user-specified items',
        blocker: mode === 'blocked' ? 'Permission denied for Beta' : '',
        items: ['alpha', 'beta'].map((id) => ({
          id,
          description: id,
          status: 'pending',
          evidence: '',
          evidenceCallId: '',
        })),
      };
      const progress = (id: string, update: unknown): AgentEvent =>
        sandboxCall(id, 'task_progress', { update });
      const calls: (AgentEvent | 'final')[] = [progress('plan', initial), 'final'];
      if (mode === 'continue')
        calls.push(
          progress('review', null),
          browserCall('verify', 'browser_inspect', { mode: 'interactive' }),
          progress('verified', {
            ...initial,
            items: initial.items.map((item) => ({
              ...item,
              status: 'verified',
              evidence: 'Observed in destination',
              evidenceCallId: 'verify',
            })),
          }),
          'final',
        );
      if (mode === 'no-progress')
        calls.push(progress('review1', null), 'final', progress('review2', null), 'final');
      let turn = 0;
      const planner = {
        plan: () =>
          (async function* () {
            const next = calls[turn++];
            if (!next) throw new Error('Unbounded completion retries');
            if (next !== 'final') {
              yield next;
              return;
            }
            if (mode === 'user-stop') await commands.pause(created.task.id);
            const messageId = `answer_${turn}`;
            await dependencies.conversations.appendMessage({
              id: messageId,
              taskId: created.task.id,
              conversationId: 'conversation_1',
              kind: 'conversation',
              role: 'assistant',
              status: 'complete',
              text: 'Progress report',
              attachmentIds: [],
              createdAt: turn,
              updatedAt: turn,
            });
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId,
            } as const;
          })(),
      };
      try {
        const executor = new TaskExecutor({
          repository,
          conversations: dependencies.conversations,
          planner,
          fixture: fixturePort(),
          browser: browserPort(),
          clock: dependencies.clock,
          ids: dependencies.ids,
        });
        const result = await executor.run(created.task.id, new AbortController().signal);
        expect(result.task.status).toBe(mode === 'continue' ? 'completed' : 'paused');
        expect(turn).toBe(calls.length);
        const messages = await dependencies.conversations.listTaskMessages(created.task.id);
        expect(messages.filter((message) => message.status === 'interrupted')).toHaveLength(
          mode === 'blocked' || mode === 'user-stop' ? 0 : mode === 'continue' ? 1 : 2,
        );
        if (mode === 'user-stop') expect(result.run?.error).toBeNull();
        else if (mode !== 'continue') expect(result.run?.error?.retryable).toBe(true);
        else expect(result.toolResults.at(-1)?.output).toContain('verified');
        if (mode === 'blocked') {
          calls.push(
            'final',
            progress('resume-read', null),
            browserCall('resume-verify', 'browser_inspect', { mode: 'interactive' }),
            progress('resume-done', {
              ...initial,
              blocker: '',
              items: initial.items.map((item) => ({
                ...item,
                status: 'verified',
                evidence: 'Observed destination after permission granted',
                evidenceCallId: 'resume-verify',
              })),
            }),
            'final',
          );
          await commands.resume(created.task.id);
          const resumed = await executor.run(created.task.id, new AbortController().signal);
          expect(resumed.task.status).toBe('completed');
          expect(resumed.run?.attempt).toBe(2);
          expect(turn).toBe(calls.length);
        }
      } finally {
        database.close();
      }
    },
  );

  it('does not execute when a detached wake-up targets an older run', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('stale-run-wakeup'));
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
      goal: 'Do not execute a stale wake-up',
    });
    const plan = vi.fn(() =>
      (async function* () {
        yield* [];
      })(),
    );
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      fixture: fixturePort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(
      created.task.id,
      new AbortController().signal,
      'superseded_run',
    );

    expect(result).toMatchObject({ task: { status: 'queued' }, run: { id: created.run.id } });
    expect(plan).not.toHaveBeenCalled();
    database.close();
  });

  it('executes an exact task selector through the unified history reader', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('exact-history-read'));
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
      goal: 'Follow an exact reply reference',
    });
    const readHistory = vi.fn(async () => ({
      ok: false as const,
      code: 'HISTORY_NOT_FOUND' as const,
      message: 'not found',
      retryable: false as const,
    }));
    let turn = 0;
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            if (turn++ === 0) {
              yield {
                type: 'tool.call',
                call: {
                  callId: 'call_exact_history',
                  name: 'history_read',
                  argumentsJson: '{"taskId":"task_old","offset":null,"cursor":"","limit":50}',
                  arguments: {
                    taskId: 'task_old',
                    offset: null,
                    cursor: '',
                    limit: 50,
                  },
                },
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
      fixture: fixturePort(),
      browser: browserPort(),
      history: {
        searchHistory: vi.fn(),
        readAttachments: vi.fn(async () => null),
        readHistory,
        readMessage: vi.fn(),
        readResult: vi.fn(),
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(readHistory).toHaveBeenCalledWith(
      {
        conversationId: 'conversation_1',
        currentTaskId: created.task.id,
        currentTaskLastEventSequence: expect.any(Number),
      },
      { taskId: 'task_old', offset: null, cursor: '', limit: 50 },
    );
    database.close();
  });

  it('loads the full runtime snapshot only once during a text-only execution', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('runtime-delta-loop'));
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
      goal: 'Complete without rereading the full event stream',
    });
    const fullSnapshotReads = vi.spyOn(repository, 'readActiveRuntimeSnapshot');
    dependencies.conversations.listMessages.mockClear();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield {
              type: 'task.completed',
              reason: 'model_response_completed',
              messageId: 'message_answer',
            } as const;
          })(),
      },
      fixture: fixturePort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(fullSnapshotReads).toHaveBeenCalledOnce();
    expect(dependencies.conversations.listMessages).not.toHaveBeenCalled();
    expect(dependencies.conversations.listTaskMessages).not.toHaveBeenCalled();
    database.close();
  });

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
    const fixture = fixturePort({
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
      fixture,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { code: 'ABORTED' },
    );
    const interrupted = await commands.getSnapshot(created.task.id);
    expect(interrupted.checkpoint?.pendingToolCall).toMatchObject({
      callId: 'call_search',
      name: 'fixture_search',
    });
    expect(interrupted.checkpoint?.continuationItems.at(-1)).toMatchObject({
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
    expect(interrupted.checkpoint?.lastModelInputTokens).toBe(120);
    expect(interrupted.events.findLast(({ type }) => type === 'model.turn')).toMatchObject({
      type: 'model.turn',
      metrics: {
        inputItemCount: 1,
        elapsedMs: 25,
        firstEventMs: 4,
        firstTextMs: 10,
        inputTokens: 120,
        outputTokens: 15,
        totalTokens: 135,
        cachedInputTokens: 80,
      },
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(recovered.task.status).toBe('completed');
    expect(recovered.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining(['model.turn', 'tool.call', 'tool.result', 'status.changed']),
    );
    expect(plan).toHaveBeenCalledTimes(2);
    expect(fixture.search).toHaveBeenCalledTimes(2);
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
      fixture: fixturePort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
    expect(result.toolResults).toHaveLength(2);
    expect(JSON.parse(result.toolResults[1]?.output ?? '')).toEqual({
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
      fixture: fixturePort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(execute).toHaveBeenCalledOnce();
    expect(result.toolResults).toHaveLength(2);
    expect(JSON.parse(result.toolResults[1]?.output ?? '')).toMatchObject({
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
      fixture: fixturePort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledTimes(4);
    expect(JSON.parse(result.toolResults.at(-1)?.output ?? '')).toMatchObject({
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
    expect(JSON.parse(result.toolResults.at(-1)?.output ?? '')).toMatchObject({
      ok: false,
      code: 'NO_PROGRESS',
      retryable: false,
      needsInspect: false,
    });
  });

  it.each([true, false])(
    'does not block repeatable clicks solely because AX is unchanged (%s)',
    async (unchanged) => {
      const calls = Array.from({ length: 3 }, (_, index) =>
        browserCall(`click_${index}`, 'browser_click', {
          ref: 'ref_menu',
          button: 'left',
          count: 1,
        }),
      );
      let count = 0;
      const execute = vi.fn<BrowserExecutionPort['execute']>(async () => ({
        output: JSON.stringify({
          ok: true,
          tabId: 7,
          url: 'https://example.test/menu',
          data: {
            action: 'click',
            dispatched: true,
            verified: 'target_remeasured',
            verification: unchanged
              ? { mode: 'interactive', snapshot: `s${++count}`, unchanged: true }
              : {
                  mode: 'interactive',
                  snapshot: `s${++count}`,
                  elements: [{ r: 'status', n: `Step ${count}` }],
                },
          },
          observation: null,
        }),
        attachmentIds: [],
      }));
      const result = await runBrowserProgressScenario(
        `dispatched-click-${unchanged}`,
        calls,
        execute,
      );
      expect(execute).toHaveBeenCalledTimes(3);
      expect(JSON.parse(result.toolResults.at(-1)?.output ?? '{}')).toMatchObject({ ok: true });
    },
  );

  it.each([true, false])(
    'allows different targets without injecting progress instructions (%s)',
    async (stalled) => {
      const calls = Array.from({ length: 4 }, (_, index) =>
        browserCall(`probe_${index}`, 'browser_click', {
          ref: `ref_${index}`,
          button: 'left',
          count: 1,
        }),
      );
      let count = 0;
      const execute = vi.fn<BrowserExecutionPort['execute']>(async () => ({
        output: JSON.stringify({
          ok: true,
          tabId: 7,
          url: 'https://example.test/menu',
          data: {
            action: 'click',
            dispatched: true,
            verification: {
              mode: 'interactive',
              snapshot: `s${++count}`,
              ...(stalled || count < 4
                ? { unchanged: true }
                : { elements: [{ r: 'dialog', n: 'Move to' }] }),
            },
          },
          observation: null,
        }),
        attachmentIds: [],
      }));
      const result = await runBrowserProgressScenario(`changed-refs-${stalled}`, calls, execute);
      expect(execute).toHaveBeenCalledTimes(4);
      const contract = await bindToolRuntime(
        discoverTools().filter((tool) => tool.declaration.name.startsWith('browser_')),
        new ToolServiceResolver(),
      ).contract({
        toolResults: result.toolResults,
      });
      expect(contract.systemPrompt).toBe('');
    },
  );

  it('blocks a repeated immobile scroll at the same position before redispatch', async () => {
    const calls = [
      browserCall('call_immobile_scroll_1', 'browser_scroll', {
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
        maxSegments: 1,
        stopText: '',
      }),
      browserCall('call_inspect_after_immobile_scroll', 'browser_inspect', {
        mode: 'interactive',
        since: 'snapshot_before_scroll',
      }),
      browserCall('call_immobile_scroll_2', 'browser_scroll', {
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
        maxSegments: 1,
        stopText: '',
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
    expect(JSON.parse(result.toolResults.at(-1)?.output ?? '')).toMatchObject({
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
      browserCall('call_scroll_traverse_1', 'browser_scroll', arguments_),
      browserCall('call_scroll_traverse_2', 'browser_scroll', arguments_),
    ];
    const execute = vi.fn<BrowserExecutionPort['execute']>(async () => ({
      output: JSON.stringify({
        ok: true,
        tabId: 7,
        url: 'https://example.test/history',
        data: {
          action: 'scroll',
          mode: 'traverse',
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
    expect(JSON.parse(result.toolResults.at(-1)?.output ?? '')).toMatchObject({
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

  it('bounds repeated finals during unfinished scroll and persists rejected turn metrics', async () => {
    const finals: AgentEvent[] = Array.from({ length: 3 }, (_, i) => ({
      type: 'task.completed',
      reason: 'model_response_completed',
      messageId: `scroll_final_${i}`,
      modelTurn: {
        responseId: `response_${i}`,
        inputItemCount: 2,
        elapsedMs: 25,
        firstEventMs: 4,
        usage: null,
      },
    }));
    const result = await runBrowserProgressScenario(
      'scroll-final-loop',
      [
        browserCall('unfinished_scroll', 'browser_scroll', {
          tabId: 0,
          target: 'ref_history',
          deltaX: 0,
          deltaY: -10_000,
          maxSegments: 1,
          stopText: '',
        }),
        ...finals,
        browserCall('too_late_scroll', 'browser_scroll', {
          tabId: 0,
          target: 'ref_history',
          deltaX: 0,
          deltaY: -9_035,
          maxSegments: 1,
          stopText: '',
        }),
        browserCall('too_late_inspect', 'browser_inspect', { tabId: 0, mode: 'interactive' }),
      ],
      async (call) => ({
        output: JSON.stringify({
          ok: true,
          tabId: 7,
          data: {
            action: 'scroll',
            requestedDeltaApplied: call.callId !== 'unfinished_scroll',
            remainingDeltaX: 0,
            remainingDeltaY: call.callId === 'unfinished_scroll' ? -9_035 : 0,
            loadedMore: call.callId === 'unfinished_scroll',
            boundaryVerified: false,
          },
        }),
        attachmentIds: [],
      }),
      ({ taskId, appendMessage, now }) => {
        for (let i = 0; i < 3; i++) {
          const at = now();
          void appendMessage({
            id: `scroll_final_${i}`,
            kind: 'conversation',
            conversationId: 'conversation_1',
            taskId,
            role: 'assistant',
            status: 'complete',
            text: 'Done',
            attachmentIds: [],
            createdAt: at,
            updatedAt: at,
          });
        }
      },
    );
    expect(result.task.status).toBe('paused');
    expect(
      result.events.filter(
        (event) => event.type === 'status.changed' && event.reason.startsWith('completion_review:'),
      ),
    ).toHaveLength(2);
    expect(result.events.filter((event) => event.type === 'model.turn')).toHaveLength(3);
    expect(result.run.error?.recoveryAction).toBe('resume_task');
    expect(result.toolResults).toHaveLength(1);
  });

  it('rejects a premature final answer until an unfinished virtualized scroll is inspected and resumed', async () => {
    const calls: readonly AgentEvent[] = [
      browserCall('call_scroll_initial', 'browser_scroll', {
        tabId: 0,
        target: 'ref_history',
        deltaX: 0,
        deltaY: -10_000,
        maxSegments: 1,
        stopText: '',
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
        maxSegments: 1,
        stopText: '',
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
    expect(
      result.events.filter(
        (event) => event.type === 'status.changed' && event.reason.startsWith('completion_review:'),
      ),
    ).toHaveLength(1);
    expect(
      result.events.filter(
        (event) => event.type === 'status.changed' && event.taskStatus === 'completed',
      ),
    ).toHaveLength(1);
    expect(result.toolResults.map(({ callId }) => callId)).toEqual(
      expect.arrayContaining([
        'call_inspect_loaded_batch',
        'call_scroll_remaining',
        'call_inspect_completed_scroll',
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
    expect(JSON.parse(result.toolResults.at(-1)?.output ?? '')).toMatchObject({
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
    let triggerSupplement = async () => undefined;
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
        await triggerSupplement();
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
      ({ taskId, appendSupplement: persistSupplement, now }) => {
        triggerSupplement = async () => {
          const at = now();
          await persistSupplement({
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
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'supplement.applied',
        messageId: 'supplement_progress_detail',
      }),
    );
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
    await database.add('attachments', {
      id: 'attachment_screenshot',
      blob: new Blob(['image'], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: 5,
      width: 1,
      height: 1,
      source: 'viewport_capture',
      createdAt: dependencies.clock.now(),
    });
    let turn = 0;
    const inputs: AgentPlanInput[] = [];
    const planner = {
      plan: (input: AgentPlanInput) =>
        (async function* () {
          inputs.push(input);
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
    const release = vi.fn(async () => undefined);
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      fixture: fixturePort(),
      browser: browserPort({
        execute: vi.fn(async () => ({
          output: '{"ok":true,"data":{"mode":"screenshot"}}',
          attachmentIds: ['attachment_screenshot'],
        })),
        release,
      }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);
    const completed = result.toolResults[0];

    expect(completed).toMatchObject({
      callId: 'call_screenshot',
      attachmentIds: ['attachment_screenshot'],
    });
    expect(
      inputs[1]?.checkpoint.continuationItems.find(
        (item) => item.type === 'function_call_output_ref' && item.callId === 'call_screenshot',
      ),
    ).toMatchObject({
      type: 'function_call_output_ref',
      callId: 'call_screenshot',
      attachmentIds: ['attachment_screenshot'],
    });
    expect(
      await database.get('attachment-references', [
        'attachment_screenshot',
        [created.task.id, 'call_screenshot'],
      ]),
    ).toEqual({
      attachmentId: 'attachment_screenshot',
      referenceId: [created.task.id, 'call_screenshot'],
    });
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
    const inputs: AgentPlanInput[] = [];
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: (input: AgentPlanInput) =>
          (async function* () {
            inputs.push(input);
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
      fixture: fixturePort(),
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

    expect(result.toolResults[0]).toMatchObject({
      output: '{"ok":true,"data":{"full":"audit"}}',
      modelOutput: '{"ok":true,"verified":true}',
    });
    const continuationOutput = inputs[1]?.checkpoint.continuationItems.find(
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
    const inputs: AgentPlanInput[] = [];
    const planner = {
      plan: (input: AgentPlanInput) =>
        (async function* () {
          inputs.push(input);
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
    const executeBrowser = vi.fn(async (call_) => {
      if (call_.operation === 'capture_screenshot') {
        await database.add('attachments', {
          id: 'attachment_capture',
          blob: new Blob(['image'], { type: 'image/png' }),
          mimeType: 'image/png',
          byteSize: 5,
          width: 1,
          height: 1,
          source: 'viewport_capture',
          createdAt: dependencies.clock.now(),
        });
        return {
          output: '{"ok":true,"assetId":"attachment_capture"}',
          attachmentIds: ['attachment_capture'],
          modelAttachmentIds: [],
        };
      }
      return {
        output: '{"ok":true,"pasted":true}',
        attachmentIds: [],
      };
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      fixture: fixturePort(),
      browser: browserPort({
        execute: executeBrowser,
      }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);
    const completed = result.toolResults[0];
    const continuation = inputs[1]?.checkpoint.continuationItems.find(
      (item) => item.type === 'function_call_output_ref' && item.callId === 'call_capture',
    );

    expect(completed?.attachmentIds).toEqual(['attachment_capture']);
    expect(continuation).toMatchObject({
      type: 'function_call_output_ref',
      callId: 'call_capture',
      attachmentIds: [],
    });
    expect(
      await database.get('attachment-references', [
        'attachment_capture',
        [created.task.id, 'call_capture'],
      ]),
    ).toEqual({
      attachmentId: 'attachment_capture',
      referenceId: [created.task.id, 'call_capture'],
    });
    expect(executeBrowser).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operation: 'paste_image' }),
      expect.any(AbortSignal),
      expect.objectContaining({ availableAssetIds: ['attachment_capture'] }),
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
      expect(dispatchBoundary.events.at(-1)?.type).toBe('tool.dispatched');
      expect(dispatchBoundary.checkpoint?.pendingToolCall).toMatchObject({
        callId: 'call_open',
        executionState: 'may_have_dispatched',
      });
      return { output: '{"ok":true,"tabId":91}', attachmentIds: [] };
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      fixture: fixturePort(),
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
      'message.recorded',
      'status.changed',
      'status.changed',
      'tool.call',
      'tool.dispatched',
      'tool.result',
      'status.changed',
    ]);
    expect(result.toolResults[0]).toMatchObject({
      callId: 'call_open',
      toolName: 'browser_open_tab',
      output: '{"ok":true,"tabId":91}',
    });
    expect(result.checkpoint).toBeNull();
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
        expect(dispatchBoundary.events.at(-1)?.type).toBe('tool.dispatched');
        expect(dispatchBoundary.checkpoint?.pendingToolCall).toMatchObject({
          callId: 'call_exec',
          executionState: 'may_have_dispatched',
          executionId: expect.stringMatching(/^sandboxExecution_/),
        });
        return '{"code":0,"stdout":"done","stderr":"","truncated":false}';
      }
      return '{"code":0,"content":"skill","truncated":false}';
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      fixture: fixturePort(),
      browser: browserPort(),
      sandbox: {
        execute,
        recover: vi.fn(),
        async configurationKey() {
          return this;
        },
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.events.map(({ type }) => type)).toEqual([
      'message.recorded',
      'status.changed',
      'status.changed',
      'tool.call',
      'tool.result',
      'tool.call',
      'tool.dispatched',
      'tool.result',
      'status.changed',
    ]);
    expect(result.toolResults.map(({ toolName }) => toolName)).toEqual([
      'sandbox_read',
      'sandbox_exec',
    ]);
    expect(
      result.toolResults.filter((item) => 'callId' in item && item.callId === 'call_exec'),
    ).toMatchObject([{ callId: 'call_exec', toolName: 'sandbox_exec' }]);
    database.close();
  });

  it('recovers an exact Sandbox exec result without redispatching after interruption', async () => {
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
            yield sandboxCall('call_exec', 'sandbox_exec', {
              command: 'touch marker',
              cwd: null,
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
    const execute = vi.fn<SandboxExecutionPort['execute']>(async () => {
      throw new DOMException('Stopped after dispatch.', 'AbortError');
    });
    const recover = vi.fn<SandboxExecutionPort['recover']>(async () => ({
      status: 'finished',
      output: JSON.stringify({
        code: 0,
        stdout: 'done',
        stderr: '',
        truncated: false,
      }),
    }));
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner,
      fixture: fixturePort(),
      browser: browserPort(),
      sandbox: {
        execute,
        recover,
        async configurationKey() {
          return this;
        },
      },
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
          executionId: expect.stringMatching(/^sandboxExecution_/),
        },
      },
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith(
      expect.stringMatching(/^sandboxExecution_/),
      expect.any(AbortSignal),
    );
    expect(recovered.task.status).toBe('completed');
    expect(
      JSON.parse(
        recovered.toolResults.find(({ callId }) => callId === 'call_exec')?.output ?? '{}',
      ),
    ).toEqual({ code: 0, stdout: 'done', stderr: '', truncated: false });
    database.close();
  });

  it('redispatches a Sandbox exec with the same ID only after a not-found receipt', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('sandbox-not-found'));
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
      goal: 'Safely recover one undispatched command',
    });
    let turn = 0;
    const executionIds: string[] = [];
    const execute = vi.fn<SandboxExecutionPort['execute']>(async (_call, _signal, context) => {
      executionIds.push(context?.executionId ?? '');
      if (executionIds.length === 1) {
        throw new DOMException('Stopped after dispatch.', 'AbortError');
      }
      return JSON.stringify({
        code: 0,
        stdout: 'done',
        stderr: '',
        truncated: false,
      });
    });
    const recover = vi.fn<SandboxExecutionPort['recover']>(async () => ({
      status: 'not_found',
    }));
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            turn += 1;
            if (turn === 1) {
              yield sandboxCall('call_exec', 'sandbox_exec', {
                command: 'touch marker',
                cwd: null,
              });
            } else {
              yield {
                type: 'task.completed',
                reason: 'model_response_completed',
                messageId: 'message_answer',
              } as const;
            }
          })(),
      },
      fixture: fixturePort(),
      browser: browserPort(),
      sandbox: {
        execute,
        recover,
        async configurationKey() {
          return this;
        },
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(recover).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(executionIds[0]).toMatch(/^sandboxExecution_/);
    expect(executionIds[1]).toBe(executionIds[0]);
    expect(recovered.task.status).toBe('completed');
    database.close();
  });

  it('keeps a running Sandbox exec pending instead of redispatching it', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('sandbox-running'));
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
      goal: 'Wait for one running command without repeating it',
    });
    let turn = 0;
    const execute = vi.fn<SandboxExecutionPort['execute']>(async () => {
      throw new DOMException('Stopped after dispatch.', 'AbortError');
    });
    const recover = vi.fn<SandboxExecutionPort['recover']>(async () => ({
      status: 'running',
    }));
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            turn += 1;
            if (turn === 1) {
              yield sandboxCall('call_exec', 'sandbox_exec', {
                command: 'long-running-command',
                cwd: null,
              });
            } else {
              yield {
                type: 'task.completed',
                reason: 'model_response_completed',
                messageId: 'message_answer',
              } as const;
            }
          })(),
      },
      fixture: fixturePort(),
      browser: browserPort(),
      sandbox: {
        execute,
        recover,
        async configurationKey() {
          return this;
        },
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    const paused = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledOnce();
    expect(paused.task.status).toBe('paused');
    expect(paused.toolResults).toEqual([]);
    expect(paused.checkpoint?.pendingToolCall).toMatchObject({
      callId: 'call_exec',
      executionState: 'may_have_dispatched',
      executionId: expect.stringMatching(/^sandboxExecution_/),
    });
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
            yield sandboxCall('call_exec', 'sandbox_exec', {
              command: 'true',
              cwd: null,
            });
          })(),
      },
      fixture: fixturePort(),
      browser: browserPort(),
      sandbox: {
        async configurationKey() {
          return this;
        },
        execute: vi.fn(async () => {
          throw new SandboxClientError('AUTH', 'definitely_not_dispatched');
        }),
        recover: vi.fn(),
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('waiting_for_auth');
    expect(result.run.error).toMatchObject({
      code: 'AuthError',
      userMessage: 'Sandbox authentication is required. Update the Sandbox Token in Settings.',
    });
    expect(result.checkpoint?.pendingToolCall).toMatchObject({
      callId: 'call_exec',
      executionState: 'recorded',
    });
    database.close();
  });

  it('returns one transient Sandbox read failure to the model instead of pausing the task', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('sandbox-transient-read'),
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
      goal: 'Recover from one Sandbox read failure',
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
              yield sandboxCall('call_read', 'sandbox_read', {
                path: '/skills/example/SKILL.md',
                startLine: 1,
                maxLines: 50,
              });
            } else {
              yield {
                type: 'task.completed',
                reason: 'model_response_completed',
                messageId: 'message_answer',
              } as const;
            }
          })(),
      },
      fixture: fixturePort(),
      browser: browserPort(),
      sandbox: {
        async configurationKey() {
          return this;
        },
        execute: vi.fn(async () => {
          throw new SandboxClientError('UNAVAILABLE', 'definitely_not_dispatched');
        }),
        recover: vi.fn(),
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map(({ type }) => type)).not.toContain('task.paused');
    expect(JSON.parse(result.toolResults[0]?.output ?? '{}')).toEqual({
      ok: false,
      code: 'SANDBOX_UNAVAILABLE',
      message: 'The Sandbox is temporarily unavailable.',
      retryable: true,
    });
    database.close();
  });

  it('pauses with the pending Sandbox exec intact when transport fails after dispatch', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('sandbox-transient-exec'),
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
      goal: 'Do not repeat an ambiguous Sandbox command',
    });
    let turn = 0;
    const execute = vi.fn(async () => {
      throw new SandboxClientError('UNAVAILABLE', 'may_have_dispatched');
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            turn += 1;
            if (turn === 1) {
              yield sandboxCall('call_exec', 'sandbox_exec', {
                command: 'touch marker',
                cwd: null,
              });
            } else {
              yield {
                type: 'task.completed',
                reason: 'model_response_completed',
                messageId: 'message_answer',
              } as const;
            }
          })(),
      },
      fixture: fixturePort(),
      browser: browserPort(),
      sandbox: {
        execute,
        recover: vi.fn(),
        async configurationKey() {
          return this;
        },
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(execute).toHaveBeenCalledOnce();
    expect(result.task.status).toBe('paused');
    expect(result.run.error).toMatchObject({
      code: 'TransientProviderError',
      retryable: true,
    });
    expect(result.toolResults).toEqual([]);
    expect(result.checkpoint?.pendingToolCall).toMatchObject({
      callId: 'call_exec',
      executionState: 'may_have_dispatched',
      executionId: expect.stringMatching(/^sandboxExecution_/),
    });
    database.close();
  });

  it('enforces an independent 128-call Sandbox ceiling', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('sandbox-limit'));
    await seedExecutorConversation(database, 'Sandbox limit');
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
      fixture: fixturePort(),
      browser: browserPort(),
      sandbox: {
        execute,
        recover: vi.fn(),
        async configurationKey() {
          return this;
        },
      },
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('failed');
    expect(result.run.error).toMatchObject({
      code: 'ToolCallLimitError',
      userMessage: 'The task exceeded the Sandbox tool-call limit.',
    });
    expect(execute).toHaveBeenCalledTimes(128);
    expect(result.toolResults).toHaveLength(128);
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
      fixture: fixturePort(),
      browser: browserPort({ execute }),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    const contexts = execute.mock.calls.map(([, , context]) => context);
    expect(contexts.map((context) => context?.currentTabId)).toEqual([7, 7, 7]);
    expect(new Set(contexts.map((context) => context?.sessionOwnerId)).size).toBe(1);
    expect(contexts[0]?.sessionOwnerId).toMatch(/^runner_/);
    expect(result.checkpoint).toBeNull();
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
      fixture: fixturePort(),
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
    const ambiguous = recovered.toolResults.find(({ callId }) => callId === 'call_click');
    expect(JSON.parse(ambiguous?.output ?? '{}')).toMatchObject({
      ok: false,
      code: 'AMBIGUOUS_MUTATION',
      needsInspect: true,
    });
    expect(release).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('runs a pure model turn without invoking Fixture', async () => {
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
      fixture: fixturePort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map((event) => event.type)).toEqual([
      'message.recorded',
      'status.changed',
      'status.changed',
      'reasoning.summary',
      'status.changed',
    ]);
    expect(result.events.find(({ type }) => type === 'reasoning.summary')).toMatchObject({
      summary: 'Verified the available context.',
    });
    expect(plan).toHaveBeenCalledOnce();
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
            type: 'tool.call',
            call: {
              callId: 'call_extract',
              name: 'fixture_extract',
              argumentsJson:
                '{"urls":["https://example.com/a"],"query":"auth","extractDepth":"basic"}',
              arguments: {
                urls: ['https://example.com/a'],
                query: 'auth',
                extractDepth: 'basic',
              },
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
    const fixture = fixturePort({
      search: vi.fn(async () => {
        const pending = await commands.getSnapshot(created.task.id);
        expect(pending.checkpoint?.pendingToolCall).toMatchObject({
          callId: 'call_search',
          name: 'fixture_search',
        });
        expect(pending.checkpoint?.continuationItems.at(-1)).toMatchObject({
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
      fixture,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(result.events.map(({ type }) => type)).toEqual([
      'message.recorded',
      'status.changed',
      'status.changed',
      'tool.call',
      'tool.result',
      'tool.call',
      'tool.result',
      'status.changed',
    ]);
    expect(inputs.map(({ toolResults }) => toolResults.length)).toEqual([0, 1, 2]);
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults[0]).toMatchObject({
      callId: 'call_search',
      toolName: 'fixture_search',
      argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
    });
    expect(JSON.parse(result.toolResults[0]?.output ?? '')).toMatchObject({
      ok: true,
      results: [{ content: 'Authentication overview', source: 'search' }],
      truncated: false,
    });
    expect(result.toolResults[1]).toMatchObject({
      callId: 'call_extract',
      toolName: 'fixture_extract',
    });
    expect(fixture.search).toHaveBeenCalledOnce();
    expect(fixture.extract).toHaveBeenCalledOnce();
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
      seenResultCounts.push(input.toolResults.length);
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
    const fixture = fixturePort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      fixture,
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
      toolResults: [{ callId: 'call_search' }],
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);
    expect(recovered.task.status).toBe('completed');
    expect(seenResultCounts).toEqual([0, 1, 1]);
    expect(fixture.search).toHaveBeenCalledOnce();
    database.close();
  });

  it('executes a persisted pending Fixture call before asking the planner again', async () => {
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
    let fixtureCalls = 0;
    const fixture = fixturePort({
      search: vi.fn(async () => {
        fixtureCalls += 1;
        order.push(`fixture_${fixtureCalls}`);
        if (fixtureCalls === 1) throw providerErrorFromCode('ABORTED');
        return { results: [], truncated: false };
      }),
    });
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      fixture,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(executor.run(created.task.id, new AbortController().signal)).rejects.toMatchObject(
      { code: 'ABORTED' },
    );
    await expect(commands.getSnapshot(created.task.id)).resolves.toMatchObject({
      task: { status: 'planning' },
      toolResults: [],
      checkpoint: {
        pendingToolCall: { callId: 'call_pending', name: 'fixture_search' },
      },
    });

    const recovered = await executor.run(created.task.id, new AbortController().signal);

    expect(recovered.task.status).toBe('completed');
    expect(order).toEqual(['planner_1', 'fixture_1', 'fixture_2', 'planner_2']);
    expect(plan).toHaveBeenCalledTimes(2);
    database.close();
  });

  it('finishes a running tool before applying a supplement to the next planner turn', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('tool-supplement'));
    const repository = new IndexedDbTaskRepository(database);
    const conversations = new IndexedDbConversationRepository(database);
    const taskMessageReads = vi.spyOn(conversations, 'listTaskMessages');
    const dependencies = sources();
    const conversation = {
      id: 'conversation_1',
      tabId: 7,
      title: 'Research this',
      createdAt: 1_000,
      updatedAt: 1_000,
    } as const;
    const userMessage: TaskMessageDraft = {
      id: 'message_user',
      kind: 'conversation',
      conversationId: 'conversation_1',
      role: 'user',
      status: 'complete',
      text: 'Research this',
      attachmentIds: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      conversations,
    );
    const created = await commands.createSubmission({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Research this',
      conversation,
      createConversation: true,
      message: userMessage,
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
        const at = dependencies.clock.now();
        await repository.appendTaskMessage({
          eventId: dependencies.ids.create('event'),
          at,
          message: {
            id: 'message_answer',
            kind: 'conversation',
            conversationId: 'conversation_1',
            taskId: created.task.id,
            role: 'assistant',
            status: 'complete',
            text: 'Finished with the additional detail.',
            attachmentIds: [],
            createdAt: at,
            updatedAt: at,
          },
        });
        yield {
          type: 'task.completed',
          reason: 'model_response_completed',
          messageId: 'message_answer',
        };
      })();
    });
    const fixture = fixturePort({
      search: vi.fn(async () => {
        const firstAt = dependencies.clock.now();
        await commands.appendSupplement({
          id: 'supplement_during_tool',
          kind: 'supplement',
          conversationId: 'conversation_1',
          taskId: created.task.id,
          role: 'user',
          status: 'complete',
          text: 'Prioritize official sources.',
          attachmentIds: [],
          createdAt: firstAt,
          updatedAt: firstAt,
        });
        const secondAt = dependencies.clock.now();
        await commands.appendSupplement({
          id: 'supplement_during_tool_2',
          kind: 'supplement',
          conversationId: 'conversation_1',
          taskId: created.task.id,
          role: 'user',
          status: 'complete',
          text: 'Include the mobile layout.',
          attachmentIds: [],
          createdAt: secondAt,
          updatedAt: secondAt,
        });
        return { results: [], truncated: false };
      }),
    });
    const executor = new TaskExecutor({
      repository,
      conversations,
      planner: { plan },
      fixture,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(
      result.events
        .filter(({ type }) => type === 'supplement.applied')
        .map((event) => (event.type === 'supplement.applied' ? event.messageId : '')),
    ).toEqual(['supplement_during_tool', 'supplement_during_tool_2']);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(taskMessageReads).toHaveBeenCalledExactlyOnceWith(created.task.id);
    database.close();
  });

  it('atomically forwards pending supplements and their attachments into a recoverable task', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('completion-supplement'));
    const repository = new IndexedDbTaskRepository(database);
    const conversations = new IndexedDbConversationRepository(database);
    const dependencies = sources();
    const conversation = {
      id: 'conversation_1',
      tabId: 7,
      title: 'Answer this',
      createdAt: 1_000,
      updatedAt: 1_000,
    } as const;
    const userMessage: TaskMessageDraft = {
      id: 'message_user',
      kind: 'conversation',
      conversationId: 'conversation_1',
      role: 'user',
      status: 'complete',
      text: 'Answer this',
      attachmentIds: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const commands = new TaskCommandService(
      repository,
      dependencies.clock,
      dependencies.ids,
      conversations,
    );
    const created = await commands.createSubmission({
      conversationId: 'conversation_1',
      tabId: 7,
      goal: 'Answer this',
      conversation,
      createConversation: true,
      message: userMessage,
    });
    await database.put('attachments', {
      id: 'image_supplement',
      blob: new Blob(['image'], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: 5,
      width: null,
      height: null,
      source: 'file',
      createdAt: 1_000,
    });
    let addedAtCompletion = false;
    const save = repository.saveTransition.bind(repository);
    vi.spyOn(repository, 'saveTransition').mockImplementation(async (input) => {
      if (!addedAtCompletion && input.task.status === 'completed') {
        addedAtCompletion = true;
        const at = dependencies.clock.now();
        await commands.appendSupplement({
          id: 'supplement_during_commit',
          kind: 'supplement',
          conversationId: conversation.id,
          taskId: created.task.id,
          role: 'user',
          status: 'complete',
          text: '',
          attachmentIds: ['image_supplement'],
          createdAt: at,
          updatedAt: at,
        });
      }
      return save(input);
    });
    const plan = vi.fn(async function* () {
      const replyAt = dependencies.clock.now();
      await repository.appendTaskMessage({
        eventId: dependencies.ids.create('event'),
        at: replyAt,
        message: {
          id: 'message_answer',
          kind: 'conversation',
          conversationId: 'conversation_1',
          taskId: created.task.id,
          role: 'assistant',
          status: 'complete',
          text: 'First answer',
          attachmentIds: [],
          createdAt: replyAt,
          updatedAt: replyAt,
        },
      });
      const supplementAt = dependencies.clock.now();
      await commands.appendSupplement({
        id: 'supplement_during_model',
        kind: 'supplement',
        conversationId: 'conversation_1',
        taskId: created.task.id,
        role: 'user',
        status: 'complete',
        text: 'Add the missing detail.',
        attachmentIds: [],
        createdAt: supplementAt,
        updatedAt: supplementAt,
      });
      yield {
        type: 'task.completed',
        reason: 'model_response_completed',
        messageId: 'message_answer',
      } satisfies AgentEvent;
    });
    const executor = new TaskExecutor({
      repository,
      conversations,
      planner: { plan },
      fixture: fixturePort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);
    const assistantMessages = (await conversations.listMessages('conversation_1')).filter(
      ({ role }) => role === 'assistant',
    );

    expect(result.task.status).toBe('completed');
    expect(result.events.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        'message.recorded',
        'supplement.queued',
        'supplement.forwarded',
        'status.changed',
      ]),
    );
    expect(plan).toHaveBeenCalledTimes(1);
    expect(assistantMessages).toEqual([
      expect.objectContaining({
        id: 'message_answer',
        status: 'complete',
        text: 'First answer',
      }),
    ]);
    if (!result.nextTask) throw new Error('Expected a queued follow-up.');
    const { taskId, runId } = result.nextTask;
    const [recoverable] = await repository.listRecoverable(dependencies.clock.now());
    expect(recoverable).toMatchObject({
      id: taskId,
      latestRunId: runId,
      status: 'queued',
      ordinal: 2,
    });
    const followUp = await commands.getSnapshot(taskId);
    const messages = await conversations.listTaskMessages(taskId);
    expect(
      followUp.events
        .filter((event) => event.type === 'message.recorded')
        .map((event) => messages.find((message) => message.id === event.messageId)),
    ).toMatchObject([
      { role: 'user', text: 'Add the missing detail.', attachmentIds: [] },
      { role: 'user', text: '', attachmentIds: ['image_supplement'] },
    ]);
    database.close();
  });

  it('fails safely when the model repeats an already completed call ID', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('duplicate-tool-call'));
    await seedExecutorConversation(database, 'Duplicate tool call');
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
    const fixture = fixturePort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      fixture,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(turn).toBe(2);
    expect(result.task.status).toBe('failed');
    expect(result.run.error).toMatchObject({
      code: 'InvalidProviderResponse',
      retryable: false,
    });
    expect(
      (await new IndexedDbConversationRepository(database).listMessages('conversation_1')).filter(
        ({ role }) => role === 'assistant',
      ),
    ).toEqual([]);
    expect(fixture.search).toHaveBeenCalledOnce();
    database.close();
  });

  it('fails before a ninth completed Fixture call can execute', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('tool-call-limit'));
    await seedExecutorConversation(database, 'Fixture limit');
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
    const fixture = fixturePort();
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: { plan },
      fixture,
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(turn).toBe(9);
    expect(fixture.search).toHaveBeenCalledTimes(8);
    expect(result.task.status).toBe('failed');
    expect(result.run.error).toMatchObject({
      code: 'ToolCallLimitError',
      retryable: false,
    });
    expect(result.toolResults).toHaveLength(8);
    database.close();
  });

  it('allows 256 browser calls in one execution attempt and rejects the next call', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('browser-attempt-call-limit'),
    );
    await seedExecutorConversation(database, 'Browser limit');
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
        yield browserCall(`call_browser_${String(turn)}`, 'browser_list_tabs', {});
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
      fixture: fixturePort(),
      browser,
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    const result = await executor.run(created.task.id, new AbortController().signal);

    expect(turn).toBe(257);
    expect(browser.execute).toHaveBeenCalledTimes(256);
    expect(result.task.status).toBe('failed');
    expect(result.run.error).toMatchObject({
      code: 'ToolCallLimitError',
      retryable: false,
    });
    expect(result.checkpoint).toMatchObject({ browserToolCallsInAttempt: 256 });
    database.close();
  });

  it('resets the browser execution budget only after an explicit retry', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('browser-attempt-retry-budget'),
    );
    await seedExecutorConversation(database, 'Browser retry limit');
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
    const planningAt = dependencies.clock.now();
    if (created.checkpoint === null) throw new Error('Initial checkpoint is missing.');
    const exhaustedCheckpoint = {
      ...created.checkpoint,
      browserToolCallsInAttempt: 256,
    };
    await repository.saveTransition({
      task: {
        ...created.task,
        status: 'planning',
        lastEventSequence: created.task.lastEventSequence + 1,
        updatedAt: planningAt,
      },
      run: { ...created.run, status: 'planning' },
      events: [
        {
          id: 'event_exhausted_browser_attempt',
          taskId: created.task.id,
          runId: created.run.id,
          sequence: created.task.lastEventSequence + 1,
          type: 'status.changed',
          taskStatus: 'planning',
          runStatus: 'planning',
          reason: 'model_request_started',
          at: planningAt,
          error: null,
        },
      ],
      checkpoint: exhaustedCheckpoint,
    });
    let mode: 'exhausted' | 'retry' = 'exhausted';
    let retryTurn = 0;
    const plan = () =>
      (async function* () {
        if (mode === 'exhausted') {
          yield browserCall('call_over_budget', 'browser_list_tabs', {});
          return;
        }
        retryTurn += 1;
        if (retryTurn === 1) {
          yield browserCall('call_after_retry', 'browser_list_tabs', {});
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
      fixture: fixturePort(),
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
    expect(completed.checkpoint).toBeNull();
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
      fixture: fixturePort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({
      task: { status: 'waiting_for_auth' },
      run: {
        error: { code: 'AuthError', recoveryAction: 'update_credentials' },
      },
    });
    database.close();
  });

  it('fails durably when task input cannot be prepared instead of remaining stuck in planning', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('input-error-executor'));
    await seedExecutorConversation(database, 'Input preparation');
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
            throw Object.assign(new Error('private attachment detail'), {
              name: 'ModelInputPreparationError',
              stage: 'agent_context',
            });
          })(),
      },
      fixture: fixturePort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({
      task: { status: 'failed' },
      run: {
        error: {
          code: 'TaskInputError',
          userMessage: 'Task input could not be prepared (stage: agent_context).',
          evidenceRef: 'input_preparation:agent_context',
        },
      },
    });
    const failed = await repository.readTaskDetailWindow(created.task.id, 100);
    expect(JSON.stringify(failed)).not.toContain('private attachment detail');
    expect(
      (await new IndexedDbConversationRepository(database).listMessages('conversation_1')).filter(
        ({ role }) => role === 'assistant',
      ),
    ).toEqual([]);
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
    let attempts = 0;
    const executor = new TaskExecutor({
      repository,
      conversations: dependencies.conversations,
      planner: {
        plan: () =>
          (async function* () {
            yield* [];
            attempts += 1;
            throw providerErrorFromCode('INVALID_RESPONSE', {
              invalidResponseStage: 'model_turn',
            });
          })(),
      },
      fixture: fixturePort(),
      browser: browserPort(),
      clock: dependencies.clock,
      ids: dependencies.ids,
    });

    await expect(
      executor.run(created.task.id, new AbortController().signal),
    ).resolves.toMatchObject({ task: { status: 'failed' } });
    // This scripted host fixture has no model retry loop; SDK retries are covered separately.
    expect(attempts).toBe(1);
    expect(
      dependencies.conversations.appendMessage.mock.calls
        .map(([message]) => message)
        .filter(({ role }) => role === 'assistant'),
    ).toEqual([]);
    database.close();
  });

  it.each([
    ['AUTH', 'waiting_for_auth', 'AuthError'],
    ['RATE_LIMIT', 'paused', 'RateLimitError'],
    ['TRANSIENT', 'paused', 'TransientProviderError'],
    ['INVALID_RESPONSE', 'failed', 'InvalidProviderResponse'],
  ] as const)(
    'maps Fixture %s failures to a durable %s boundary',
    async (code, status, taskCode) => {
      const database = await openChatBrowserDatabase(createTestDatabaseName(`fixture-${code}`));
      await seedExecutorConversation(database, `Fixture ${code}`);
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
        goal: 'Handle Fixture failure',
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
        fixture: fixturePort({
          search: vi.fn(async () => {
            throw fixtureError(code);
          }),
        }),
        browser: browserPort(),
        clock: dependencies.clock,
        ids: dependencies.ids,
      });

      const result = await executor.run(created.task.id, new AbortController().signal);

      expect(result.task.status).toBe(status);
      expect(result.run.error).toMatchObject({ code: taskCode });
      if (code === 'AUTH') {
        expect(result.run.error?.userMessage).toMatch(/fixture/i);
      }
      expect(result.toolResults).toEqual([]);
      database.close();
    },
  );

  it('propagates an aborted Fixture request and leaves the task at its recoverable checkpoint', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('fixture-aborted'));
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
      goal: 'Abort Fixture request',
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
      fixture: fixturePort({
        search: vi.fn(async () => {
          throw fixtureError('ABORTED');
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
      toolResults: [],
      checkpoint: { pendingToolCall: { callId: 'call_aborted' } },
    });
    database.close();
  });
});
