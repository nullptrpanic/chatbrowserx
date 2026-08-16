import { describe, expect, it, vi } from 'vitest';
import { CodexAgentPlanner } from '../../src/agent/codex-agent-planner';
import type { AgentPlanInput } from '../../src/agent/execution-types';
import type { AttachmentRepository } from '../../src/persistence/attachment-repository';
import type { ConversationRepository } from '../../src/persistence/conversation-repository';
import type { SettingsStore } from '../../src/persistence/settings-store';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import type { ModelProvider, ModelRequest } from '../../src/providers/provider-types';
import type { ModelStreamEvent } from '../../src/providers/stream-events';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { TaskRun } from '../../src/tasks/task-types';

const TASK: TaskRun = {
  id: 'task_1',
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
  createdAt: 200,
};

const PLAN_INPUT: AgentPlanInput = {
  task: TASK,
  checkpoint: CHECKPOINT,
};

const USER_MESSAGE: MessageRecord = {
  id: 'message_user',
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
  readonly appendMessage: ReturnType<typeof vi.fn>;
  readonly updateMessage: ReturnType<typeof vi.fn>;
} {
  const appendMessage = vi.fn(async () => undefined);
  const updateMessage = vi.fn(async () => undefined);
  return {
    appendMessage,
    updateMessage,
    conversations: {
      create: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      listByTab: vi.fn(async () => []),
      listMessages: vi.fn(async () => [USER_MESSAGE, ...existingMessages]),
      appendMessage,
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
    })),
    save: vi.fn(async () => undefined),
    reset: vi.fn(async () => ({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium' as const,
      systemPrompt: '',
      language: 'system' as const,
    })),
  };
}

/** Collects planner events from one model turn. */
async function collect(planner: CodexAgentPlanner, signal = new AbortController().signal) {
  const events = [];
  for await (const event of planner.plan(PLAN_INPUT, signal)) events.push(event);
  return events;
}

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
      attachments: storage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(planner)).resolves.toEqual([
      { type: 'task.completed', reason: 'model_response_completed' },
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
    expect(model.requests[0]?.tools).toEqual([]);
  });

  it('rejects unsolicited tool output because this runtime registers no concrete tools', async () => {
    const invalidModel = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_invalid' };
      yield { type: 'tool.started', callId: 'call_bad', name: 'browser.eval' };
      yield {
        type: 'tool.completed',
        callId: 'call_bad',
        name: 'browser.eval',
        argumentsJson: '{"code":"document.cookie"}',
      };
      yield { type: 'response.completed', responseId: 'resp_invalid', usage: null };
    });
    const invalidStorage = repositories();
    const invalidPlanner = new CodexAgentPlanner({
      provider: invalidModel.instance,
      settings: settings(),
      conversations: invalidStorage.conversations,
      attachments: invalidStorage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(invalidPlanner)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(invalidStorage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error' }),
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
      attachments: abortedStorage.attachments,
      ids: { create: (prefix) => `${prefix}_1` },
      clock: { now: () => 500 },
    });

    await expect(collect(abortedPlanner)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(abortedStorage.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'interrupted', text: 'partial' }),
    );
  });

  it("marks a prior worker's streaming message interrupted before replacing its turn", async () => {
    const model = provider(async function* () {
      yield { type: 'response.started', responseId: 'resp_recovery' };
      yield { type: 'text.delta', delta: 'Recovered' };
      yield { type: 'response.completed', responseId: 'resp_recovery', usage: null };
    });
    const storage = repositories([
      {
        id: 'message_abandoned',
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
      expect.objectContaining({ id: 'message_replacement', status: 'complete', text: 'Recovered' }),
    );
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
