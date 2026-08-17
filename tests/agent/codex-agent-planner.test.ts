import { describe, expect, it, vi } from 'vitest';
import { CodexAgentPlanner } from '../../src/agent/codex-agent-planner';
import type { AgentPlanInput } from '../../src/agent/execution-types';
import type { AttachmentRepository } from '../../src/persistence/attachment-repository';
import type { ConversationRepository } from '../../src/persistence/conversation-repository';
import type { SettingsStore } from '../../src/persistence/settings-store';
import type { TaskRepository } from '../../src/persistence/task-repository';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import type { ModelProvider, ModelRequest } from '../../src/providers/provider-types';
import type { ModelStreamEvent } from '../../src/providers/stream-events';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { TaskRun } from '../../src/tasks/task-types';

const TASK: TaskRun = {
  id: 'task_1',
  workSessionId: 'workSession_1',
  conversationId: 'conversation_1',
  tabId: 7,
  goal: 'Continue checkout',
  status: 'planning',
  createdAt: 100,
  updatedAt: 200,
  checkpointId: 'checkpoint_1',
  lease: null,
  lastError: null,
};

const CHECKPOINT: Checkpoint = {
  id: 'checkpoint_1',
  taskId: 'task_1',
  sequence: 1,
  taskStatus: 'planning',
  completedToolResults: [],
  continuationItems: [],
  pendingToolCall: null,
  createdAt: 200,
};

const PLAN_INPUT: AgentPlanInput = {
  task: TASK,
  checkpoint: CHECKPOINT,
};

const USER_MESSAGE: MessageRecord = {
  id: 'message_user',
  kind: 'conversation',
  conversationId: 'conversation_1',
  taskId: 'task_1',
  role: 'user',
  status: 'complete',
  text: 'Continue checkout',
  attachmentIds: [],
  createdAt: 100,
  updatedAt: 100,
};

/** Creates an injected Provider stream and captures its normalized request. */
function provider(events: () => AsyncGenerator<ModelStreamEvent>): {
  readonly instance: ModelProvider;
  readonly requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  return {
    requests,
    instance: {
      stream(request) {
        requests.push(request);
        return events();
      },
    },
  };
}

/** Creates storage ports and returns the message writes for assertions. */
function repositories(existingMessages: readonly MessageRecord[] = []): {
  readonly conversations: ConversationRepository;
  readonly attachments: AttachmentRepository;
  readonly tasks: Pick<TaskRepository, 'listByConversation'>;
  readonly messages: MessageRecord[];
  readonly appendMessage: ReturnType<typeof vi.fn>;
  readonly updateMessage: ReturnType<typeof vi.fn>;
} {
  const messages = [USER_MESSAGE, ...existingMessages];
  const appendMessage = vi.fn(async (message: MessageRecord) => {
    messages.push(message);
  });
  const updateMessage = vi.fn(async (message: MessageRecord) => {
    const index = messages.findIndex(({ id }) => id === message.id);
    if (index < 0) throw new Error('Message does not exist.');
    messages[index] = message;
  });
  return {
    messages,
    appendMessage,
    updateMessage,
    conversations: {
      create: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      listAll: vi.fn(async () => []),
      listByTab: vi.fn(async () => []),
      listMessages: vi.fn(async () => [...messages]),
      appendMessage,
      appendSupplement: vi.fn(async () => undefined),
      updateMessage,
      clearConversation: vi.fn(async () => undefined),
    },
    attachments: {
      put: vi.fn(),
      get: vi.fn(async () => undefined),
      addReference: vi.fn(async () => undefined),
      removeReference: vi.fn(async () => undefined),
      deleteUnreferenced: vi.fn(async () => 0),
    },
    tasks: {
      listByConversation: vi.fn(async () => [TASK]),
    },
  };
}

/** Creates fixed settings without exposing configurable Provider endpoints. */
function settings(): SettingsStore {
  return {
    get: vi.fn(async () => ({
      model: 'ignored-model-setting',
      reasoningEffort: 'medium' as const,
      systemPrompt: 'Custom safe preference.',
      language: 'system' as const,
      historyMessageLimit: 50,
    })),
    save: vi.fn(async () => undefined),
    reset: vi.fn(async () => ({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium' as const,
      systemPrompt: '',
      language: 'system' as const,
      historyMessageLimit: 50,
    })),
  };
}

/** Collects planner events from one model turn. */
async function collect(
  planner: CodexAgentPlanner,
  signal = new AbortController().signal,
  input = PLAN_INPUT,
) {
  const events = [];
  for await (const event of planner.plan(input, signal)) events.push(event);
  return events;
}

const SEARCH_ARGUMENTS = {
  query: 'browser reliability',
  searchDepth: 'advanced',
  topic: 'general',
  timeRange: 'month',
  maxResults: 5,
  includeDomains: [],
  excludeDomains: [],
} as const;

describe('CodexAgentPlanner', () => {
  it('persists streamed text and completes a text-only turn', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_1' };
      yield { type: 'text.delta', delta: 'Checkout ' };
      yield { type: 'text.delta', delta: 'is ready.' };
      yield { type: 'response.completed', responseId: 'resp_1', usage: null };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toEqual([
      { type: 'task.completed', reason: 'model_response_completed', messageId: 'message_1' },
    ]);
    expect(storage.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'message_1', status: 'streaming', text: '' }),
    );
    expect(storage.updateMessage).toHaveBeenCalledTimes(1);
    expect(storage.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete', text: 'Checkout is ready.' }),
    );
    expect(model.requests[0]).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: 'Custom safe preference.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue checkout' }],
        },
      ],
    });
    expect(model.requests[0]?.tools.map(({ name }) => name)).toEqual([
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
    ]);
  });

  it('emits a bounded provider-authored reasoning summary before the turn outcome', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_reasoning' };
      yield {
        type: 'reasoning.summary',
        itemId: 'reasoning_1',
        summaryIndex: 0,
        text: `  ${'evidence '.repeat(3_000)}  `,
      };
      yield { type: 'text.delta', delta: 'Done.' };
      yield { type: 'response.completed', responseId: 'resp_reasoning', usage: null };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    const events = await collect(planner);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'reasoning.summary' });
    expect(events[0]?.type === 'reasoning.summary' ? events[0].text : '').toHaveLength(20_000);
    expect(events[1]).toEqual({
      type: 'task.completed',
      reason: 'model_response_completed',
      messageId: 'message_1',
    });
  });

  it.each([
    ['tavily_search', SEARCH_ARGUMENTS, 'search'],
    [
      'tavily_extract',
      {
        urls: ['https://example.com/a'],
        query: 'authentication',
        extractDepth: 'basic',
      },
      'extract',
    ],
    [
      'tavily_crawl',
      {
        url: 'https://docs.example.com/',
        instructions: 'Find authentication docs.',
        maxDepth: 2,
        maxPages: 5,
      },
      'crawl',
    ],
  ] as const)(
    'returns one validated %s call without creating an empty assistant message',
    async (name, arguments_, operation) => {
      const argumentsJson = JSON.stringify(arguments_);
      const model = provider(async function* () {
        yield { type: 'response.started', responseId: 'resp_tool' };
        yield { type: 'tool.started', callId: 'call_1', name };
        yield { type: 'tool.arguments.delta', callId: 'call_1', delta: argumentsJson };
        yield { type: 'tool.completed', callId: 'call_1', name, argumentsJson };
        yield { type: 'response.completed', responseId: 'resp_tool', usage: null };
      });
      const storage = repositories();
      const planner = new CodexAgentPlanner({
        provider: model.instance,
        settings: settings(),
        conversations: storage.conversations,
        tasks: storage.tasks,
        attachments: storage.attachments,
        ids: { create: (prefix) => `${prefix}_1` },
        clock: { now: () => 500 },
      });

      await expect(collect(planner)).resolves.toEqual([
        {
          type: 'tavily.call',
          operation,
          callId: 'call_1',
          argumentsJson,
          arguments: arguments_,
        },
      ]);
      expect(storage.appendMessage).not.toHaveBeenCalled();
      expect(storage.updateMessage).not.toHaveBeenCalled();
    },
  );

  it('replays completed Tavily results before persisting a later final response', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_final' };
      yield { type: 'text.delta', delta: 'The research is complete.' };
      yield { type: 'response.completed', responseId: 'resp_final', usage: null };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });
    const argumentsJson = JSON.stringify(SEARCH_ARGUMENTS);

    await collect(planner, new AbortController().signal, {
      ...PLAN_INPUT,
      checkpoint: {
        ...CHECKPOINT,
        completedToolResults: [
          {
            callId: 'call_previous',
            toolName: 'tavily_search',
            argumentsJson,
            output: '{"ok":true,"results":[]}',
            resultRef: 'result_previous',
          },
        ],
      },
    });

    expect(model.requests[0]?.input.slice(-2)).toEqual([
      {
        type: 'function_call',
        callId: 'call_previous',
        name: 'tavily_search',
        argumentsJson,
      },
      {
        type: 'function_call_output',
        callId: 'call_previous',
        output: '{"ok":true,"results":[]}',
      },
    ]);
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'complete', text: 'The research is complete.' }),
    );
  });

  it('rejects unsupported tool output without creating an empty assistant message', async () => {
    const invalidModel = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_invalid' };
      yield { type: 'tool.started', callId: 'call_bad', name: 'browser_eval' };
      yield {
        type: 'tool.completed',
        callId: 'call_bad',
        name: 'browser_eval',
        argumentsJson: '{"code":"document.cookie"}',
      };
      yield { type: 'response.completed', responseId: 'resp_invalid', usage: null };
    });
    const invalidStorage = repositories();
    const invalidPlanner = new CodexAgentPlanner({
      provider: invalidModel.instance,
      settings: settings(),
      conversations: invalidStorage.conversations,
      tasks: invalidStorage.tasks,
      attachments: invalidStorage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(invalidPlanner)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(invalidStorage.appendMessage).not.toHaveBeenCalled();
    expect(invalidStorage.updateMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{secret-value'],
    ['invalid bounds', JSON.stringify({ ...SEARCH_ARGUMENTS, maxResults: 9 })],
  ])('rejects %s without echoing tool arguments', async (_label, argumentsJson) => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_invalid_arguments' };
      yield { type: 'tool.started', callId: 'call_bad', name: 'tavily_search' };
      yield {
        type: 'tool.completed',
        callId: 'call_bad',
        name: 'tavily_search',
        argumentsJson,
      };
      yield { type: 'response.completed', responseId: 'resp_invalid_arguments', usage: null };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    let thrown: unknown;
    try {
      await collect(planner);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(thrown)).not.toContain('secret-value');
    expect(storage.appendMessage).not.toHaveBeenCalled();
  });

  it('rejects multiple calls in one model response', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_multiple' };
      for (const callId of ['call_1', 'call_2']) {
        yield { type: 'tool.started', callId, name: 'tavily_search' } as const;
        yield {
          type: 'tool.completed',
          callId,
          name: 'tavily_search',
          argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
        } as const;
      }
      yield { type: 'response.completed', responseId: 'resp_multiple', usage: null };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(storage.appendMessage).not.toHaveBeenCalled();
  });

  it('marks provisional text as an error when a mixed tool response arrives', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_mixed' };
      yield { type: 'text.delta', delta: 'I will search.' };
      yield { type: 'tool.started', callId: 'call_1', name: 'tavily_search' };
      yield {
        type: 'tool.completed',
        callId: 'call_1',
        name: 'tavily_search',
        argumentsJson: JSON.stringify(SEARCH_ARGUMENTS),
      };
      yield { type: 'response.completed', responseId: 'resp_mixed', usage: null };
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error', text: 'I will search.' }),
    );
  });

  it('marks aborted output interrupted', async () => {
    const abortedModel = provider(async function* () {
      yield { type: 'text.delta', delta: 'partial' };
      throw providerErrorFromCode('ABORTED');
    });
    const abortedStorage = repositories();
    const abortedPlanner = new CodexAgentPlanner({
      provider: abortedModel.instance,
      settings: settings(),
      conversations: abortedStorage.conversations,
      tasks: abortedStorage.tasks,
      attachments: abortedStorage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(abortedPlanner)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(abortedStorage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'interrupted', text: 'partial' }),
    );
  });

  it("reuses a prior worker's stale streaming message for the replacement turn", async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_recovery' };
      yield { type: 'text.delta', delta: 'Recovered' };
      yield { type: 'response.completed', responseId: 'resp_recovery', usage: null };
    });
    const storage = repositories([
      {
        id: 'message_abandoned',
        kind: 'conversation',
        conversationId: 'conversation_1',
        taskId: 'task_1',
        role: 'assistant',
        status: 'streaming',
        text: 'partial from old worker',
        attachmentIds: [],
        createdAt: 300,
        updatedAt: 300,
      },
    ]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_replacement` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(storage.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'message_abandoned',
        status: 'interrupted',
        text: 'partial from old worker',
      }),
    );
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'message_abandoned', status: 'complete', text: 'Recovered' }),
    );
    expect(storage.appendMessage).not.toHaveBeenCalled();
    expect(storage.messages.filter(({ role }) => role === 'assistant')).toEqual([
      expect.objectContaining({ id: 'message_abandoned', status: 'complete', text: 'Recovered' }),
    ]);
  });

  it('reuses the interrupted reply when a paused task continues', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_resumed' };
      yield { type: 'text.delta', delta: 'Fresh answer after resume.' };
      yield { type: 'response.completed', responseId: 'resp_resumed', usage: null };
    });
    const storage = repositories([
      {
        id: 'message_paused',
        kind: 'conversation',
        conversationId: 'conversation_1',
        taskId: 'task_1',
        role: 'assistant',
        status: 'interrupted',
        text: 'Partial answer before pause.',
        attachmentIds: [],
        createdAt: 300,
        updatedAt: 400,
      },
    ]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_replacement` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(storage.appendMessage).not.toHaveBeenCalled();
    expect(storage.messages.filter(({ role }) => role === 'assistant')).toEqual([
      expect.objectContaining({
        id: 'message_paused',
        status: 'complete',
        text: 'Fresh answer after resume.',
      }),
    ]);
  });

  it('reuses an uncheckpointed complete reply when pause wins the completion race', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_pause_race' };
      yield { type: 'text.delta', delta: 'Replacement after pause.' };
      yield { type: 'response.completed', responseId: 'resp_pause_race', usage: null };
    });
    const storage = repositories([
      {
        id: 'message_pause_race',
        kind: 'conversation',
        conversationId: 'conversation_1',
        taskId: 'task_1',
        role: 'assistant',
        status: 'complete',
        text: 'Completed locally before the pause checkpoint.',
        attachmentIds: [],
        createdAt: 300,
        updatedAt: 400,
      },
    ]);
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_replacement` },
      clock: { now: () => 500 },
    });

    await collect(planner);

    expect(storage.appendMessage).not.toHaveBeenCalled();
    expect(storage.messages.filter(({ role }) => role === 'assistant')).toEqual([
      expect.objectContaining({
        id: 'message_pause_race',
        status: 'complete',
        text: 'Replacement after pause.',
      }),
    ]);
  });

  it('marks retryable partial Provider output interrupted instead of a terminal message error', async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_retryable' };
      yield { type: 'text.delta', delta: 'Partial answer' };
      throw providerErrorFromCode('TRANSIENT');
    });
    const storage = repositories();
    const planner = new CodexAgentPlanner({
      provider: model.instance,
      settings: settings(),
      conversations: storage.conversations,
      tasks: storage.tasks,
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_retryable` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).rejects.toMatchObject({ code: 'TRANSIENT' });
    expect(storage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'interrupted', text: 'Partial answer' }),
    );
  });
});
