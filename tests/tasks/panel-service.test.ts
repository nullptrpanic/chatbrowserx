import { describe, expect, it, vi } from 'vitest';
import { PanelService } from '../../src/tasks/panel-service';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { TaskEvent, TaskRun } from '../../src/tasks/task-types';

/** Builds a complete Panel service dependency fixture with no secret-bearing output. */
function buildFixture() {
  const conversation = {
    id: 'conversation_1',
    tabId: 7,
    title: 'Book a room',
    createdAt: 1_000,
    updatedAt: 1_200,
  };
  const task = {
    id: 'task_1',
    conversationId: conversation.id,
    tabId: 7,
    goal: 'Book a room',
    status: 'completed' as const,
    createdAt: 1_010,
    updatedAt: 1_190,
    checkpointId: 'checkpoint_1',
    lease: null,
    lastError: null,
  };
  const checkpoint = {
    id: 'checkpoint_1',
    taskId: task.id,
    sequence: 1,
    taskStatus: task.status,
    completedToolResults: [],
    createdAt: 1_190,
  };
  const dependencies = {
    conversations: {
      listAll: vi.fn(async () => [conversation]),
      listByTab: vi.fn(async () => [conversation]),
      get: vi.fn(async (): Promise<typeof conversation | undefined> => conversation),
      create: vi.fn(async () => undefined),
      listMessages: vi.fn(async (): Promise<MessageRecord[]> => [
        {
          id: 'message_1',
          conversationId: conversation.id,
          taskId: task.id,
          role: 'user' as const,
          status: 'complete' as const,
          text: 'Book a room',
          attachmentIds: ['attachment_1'],
          createdAt: 1_010,
          updatedAt: 1_010,
        },
      ]),
      appendMessage: vi.fn(async () => undefined),
      updateMessage: vi.fn(async () => undefined),
      clearConversation: vi.fn(async () => undefined),
    },
    tasks: {
      listByConversation: vi.fn(async (conversationId: string): Promise<TaskRun[]> => {
        void conversationId;
        return [task];
      }),
      listEvents: vi.fn(async (taskId: string): Promise<TaskEvent[]> => {
        void taskId;
        return [
          {
            id: 'event_1',
            taskId: task.id,
            sequence: 1,
            type: 'task.completed' as const,
            reason: 'done',
            at: 1_190,
            error: null,
          },
        ];
      }),
      getCheckpoint: vi.fn(async (...arguments_: [string]): Promise<Checkpoint | undefined> => {
        void arguments_;
        return checkpoint;
      }),
    },
    attachments: {
      get: vi.fn(async () => ({
        id: 'attachment_1',
        blob: new Blob(['png'], { type: 'image/png' }),
        mimeType: 'image/png',
        byteSize: 3,
        width: 10,
        height: 10,
        source: 'file' as const,
        createdAt: 1_000,
        fileName: 'photo.png',
      })),
      deleteUnreferenced: vi.fn(async () => 0),
    },
    settings: {
      get: vi.fn(async () => ({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium' as const,
        systemPrompt: '',
        language: 'zh-CN' as const,
        historyMessageLimit: 50,
      })),
      save: vi.fn(async () => undefined),
    },
    credentials: {
      getCodexAccessToken: vi.fn(async () => 'secret-token'),
      setCodexAccessToken: vi.fn(async () => undefined),
    },
    commands: {
      create: vi.fn(async () => ({ task, checkpoint, events: [] })),
    },
    cancelTask: vi.fn(async () => ({ task, checkpoint, events: [] })),
    tabs: {
      get: vi.fn(async () => ({ id: 7, title: 'Example', url: 'https://example.com/form' })),
    },
    permissions: { contains: vi.fn(async () => true) },
    imagePreview: {
      open: vi.fn(async () => undefined),
    },
    clock: { now: () => 2_000 },
    ids: { create: (prefix: string) => `${prefix}_new` },
    scheduleTask: vi.fn(async (...arguments_: [string]) => {
      void arguments_;
    }),
  };
  return { conversation, dependencies, task };
}

describe('PanelService', () => {
  it('shares history across tabs while keeping the current page context separate', async () => {
    const fixture = buildFixture();
    const otherConversation = {
      id: 'conversation_tab_9',
      tabId: 9,
      title: 'Task from another tab',
      createdAt: 1_300,
      updatedAt: 1_400,
    };
    fixture.dependencies.conversations.listAll.mockResolvedValue([
      otherConversation,
      fixture.conversation,
    ]);
    fixture.dependencies.conversations.listByTab.mockResolvedValue([otherConversation]);
    fixture.dependencies.tasks.listByConversation.mockImplementation(async (conversationId) =>
      conversationId === fixture.conversation.id ? [fixture.task] : [],
    );
    fixture.dependencies.tabs.get.mockResolvedValue({
      id: 9,
      title: 'Other page',
      url: 'https://other.example/page',
    });
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(9, fixture.conversation.id);

    expect(snapshot.tab).toMatchObject({ id: 9, origin: 'https://other.example' });
    expect(snapshot.conversation?.id).toBe(fixture.conversation.id);
    expect(snapshot.conversations.map(({ id }) => id)).toEqual([
      otherConversation.id,
      fixture.conversation.id,
    ]);
  });

  it('continues a global conversation from a different current tab', async () => {
    const fixture = buildFixture();
    const service = new PanelService(fixture.dependencies);

    await service.submit({
      tabId: 9,
      conversationId: fixture.conversation.id,
      text: 'Continue from another page',
      attachmentIds: [],
    });

    expect(fixture.dependencies.commands.create).toHaveBeenCalledWith({
      conversationId: fixture.conversation.id,
      tabId: 9,
      goal: 'Continue from another page',
    });
  });

  it('falls back to the latest global conversation after another panel deletes the selection', async () => {
    const fixture = buildFixture();
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7, 'conversation_already_deleted');

    expect(snapshot.conversation?.id).toBe(fixture.conversation.id);
    expect(snapshot.messages).toHaveLength(1);
  });

  it('builds a complete sanitized snapshot without credential values or attachment bytes', async () => {
    const fixture = buildFixture();
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);

    expect(snapshot).toMatchObject({
      tab: { id: 7, origin: 'https://example.com', supported: true, hasPermission: true },
      conversation: { id: fixture.conversation.id, taskStatus: 'completed' },
      task: { id: fixture.task.id, sequence: 1 },
      settings: { hasCodexToken: true },
      attachments: [{ id: 'attachment_1', fileName: 'photo.png' }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-token');
    expect(JSON.stringify(snapshot)).not.toContain('blob');
    expect(snapshot.tab).not.toHaveProperty('debuggerAttached');
  });

  it('projects message task IDs and bounded task execution details for answer-level rendering', async () => {
    const fixture = buildFixture();
    const secondTask = {
      ...fixture.task,
      id: 'task_2',
      goal: 'Run tests',
      createdAt: 1_200,
      updatedAt: 1_300,
      checkpointId: 'checkpoint_2',
    };
    const longArguments = `{"cmd":"${'a'.repeat(20_100)}"}`;
    const longOutput = 'o'.repeat(100_100);
    const completedToolResults = Array.from({ length: 22 }, (_, index) => ({
      callId: `call_${index}`,
      toolName: index === 21 ? 'bash' : 'lookup',
      argumentsJson: index === 21 ? longArguments : '{}',
      output: index === 21 ? longOutput : `output_${index}`,
      resultRef: `result_${index}`,
    }));
    fixture.dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_user_1',
        conversationId: fixture.conversation.id,
        taskId: fixture.task.id,
        role: 'user',
        status: 'complete',
        text: 'First task',
        attachmentIds: [],
        createdAt: 1_010,
        updatedAt: 1_010,
      },
      {
        id: 'message_assistant_1',
        conversationId: fixture.conversation.id,
        taskId: fixture.task.id,
        role: 'assistant',
        status: 'complete',
        text: 'First answer',
        attachmentIds: [],
        createdAt: 1_100,
        updatedAt: 1_100,
      },
      {
        id: 'message_assistant_2',
        conversationId: fixture.conversation.id,
        taskId: secondTask.id,
        role: 'assistant',
        status: 'complete',
        text: 'Tests passed',
        attachmentIds: [],
        createdAt: 1_300,
        updatedAt: 1_300,
      },
    ]);
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([fixture.task, secondTask]);
    fixture.dependencies.tasks.listEvents.mockImplementation(async (taskId) => [
      {
        id: `event_${taskId}`,
        taskId,
        sequence: 1,
        type: 'task.completed',
        reason: 'done',
        at: taskId === secondTask.id ? 1_300 : 1_190,
        error: null,
      },
    ]);
    fixture.dependencies.tasks.getCheckpoint.mockImplementation(async (checkpointId) => ({
      id: checkpointId,
      taskId: checkpointId === 'checkpoint_2' ? secondTask.id : fixture.task.id,
      sequence: 1,
      taskStatus: 'completed',
      completedToolResults: checkpointId === 'checkpoint_2' ? completedToolResults : [],
      createdAt: checkpointId === 'checkpoint_2' ? 1_300 : 1_190,
    }));
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);

    expect(snapshot.messages.map(({ taskId }) => taskId)).toEqual([
      fixture.task.id,
      fixture.task.id,
      secondTask.id,
    ]);
    expect(snapshot.tasks.map(({ id }) => id)).toEqual([fixture.task.id, secondTask.id]);
    const bashTask = snapshot.tasks.find(({ id }) => id === secondTask.id);
    expect(bashTask?.completedToolResults).toHaveLength(20);
    expect(bashTask?.completedToolResults[0]?.callId).toBe('call_2');
    expect(bashTask?.completedToolResults.at(-1)).toMatchObject({
      callId: 'call_21',
      toolName: 'bash',
    });
    expect(bashTask?.completedToolResults.at(-1)?.argumentsJson).toHaveLength(20_000);
    expect(bashTask?.completedToolResults.at(-1)?.output).toHaveLength(100_000);
  });

  it('returns persisted credentials only from the explicit settings query', async () => {
    const fixture = buildFixture();
    const service = new PanelService(fixture.dependencies);

    await expect(service.getSettings()).resolves.toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'zh-CN',
      historyMessageLimit: 50,
      codexAccessToken: 'secret-token',
    });
  });

  it('materializes one persisted image for a page-wide preview', async () => {
    const fixture = buildFixture();
    const service = new PanelService(fixture.dependencies);

    await service.openImagePreview(9, 'attachment_1');

    expect(fixture.dependencies.imagePreview.open).toHaveBeenCalledWith(9, {
      src: 'data:image/png;base64,cG5n',
      alt: 'photo.png',
    });
  });

  it('creates a conversation, durable user message, task, and scheduler handoff in order', async () => {
    const fixture = buildFixture();
    fixture.dependencies.conversations.listByTab.mockResolvedValueOnce([]);
    fixture.dependencies.conversations.get.mockResolvedValueOnce(undefined);
    const order: string[] = [];
    fixture.dependencies.conversations.create.mockImplementationOnce(async () => {
      order.push('conversation');
    });
    fixture.dependencies.conversations.appendMessage.mockImplementationOnce(async () => {
      order.push('message');
    });
    fixture.dependencies.commands.create.mockImplementationOnce(async () => {
      order.push('task');
      return {
        task: fixture.task,
        checkpoint: await fixture.dependencies.tasks.getCheckpoint('checkpoint_1'),
        events: [],
      } as never;
    });
    fixture.dependencies.scheduleTask.mockImplementationOnce(async () => {
      order.push('schedule');
    });
    const service = new PanelService(fixture.dependencies);

    await service.submit({ tabId: 7, text: 'Book a room', attachmentIds: [] });

    expect(order).toEqual(['conversation', 'message', 'task', 'schedule']);
    expect(fixture.dependencies.conversations.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: fixture.task.id }),
    );
  });

  it('rejects a second task while the selected conversation still has unfinished work', async () => {
    const fixture = buildFixture();
    fixture.dependencies.tasks.listByConversation.mockResolvedValueOnce([
      { ...fixture.task, status: 'paused' },
    ]);
    const service = new PanelService(fixture.dependencies);

    await expect(
      service.submit({
        tabId: 7,
        conversationId: fixture.conversation.id,
        text: 'Start another task',
        attachmentIds: [],
      }),
    ).rejects.toThrow(/unfinished task/i);
    expect(fixture.dependencies.conversations.appendMessage).not.toHaveBeenCalled();
    expect(fixture.dependencies.commands.create).not.toHaveBeenCalled();
  });

  it('saves only supplied secrets and clears terminal history before garbage collection', async () => {
    const fixture = buildFixture();
    const service = new PanelService(fixture.dependencies);

    await service.saveSettings({
      reasoningEffort: 'high',
      systemPrompt: 'Be concise',
      language: 'en',
      historyMessageLimit: 24,
      codexAccessToken: 'new-token',
    });
    await service.clearConversation(fixture.conversation.id);

    expect(fixture.dependencies.credentials.setCodexAccessToken).toHaveBeenCalledWith('new-token');
    expect(fixture.dependencies.settings.save).toHaveBeenCalledWith(
      expect.objectContaining({ historyMessageLimit: 24 }),
    );
    expect(fixture.dependencies.conversations.clearConversation).toHaveBeenCalledWith(
      fixture.conversation.id,
    );
    expect(fixture.dependencies.attachments.deleteUnreferenced).toHaveBeenCalledWith(
      2_000 - 24 * 60 * 60 * 1_000,
    );
  });

  it('cancels unfinished work before deleting the complete conversation aggregate', async () => {
    const fixture = buildFixture();
    const runningTask = { ...fixture.task, status: 'planning' as const };
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([runningTask]);
    const order: string[] = [];
    fixture.dependencies.cancelTask.mockImplementation(async () => {
      order.push('cancel');
      return {
        task: { ...runningTask, status: 'cancelled' },
        checkpoint: { ...(await fixture.dependencies.tasks.getCheckpoint('checkpoint_1')) },
        events: [],
      } as never;
    });
    fixture.dependencies.conversations.clearConversation.mockImplementation(async () => {
      order.push('clear');
    });
    const service = new PanelService(fixture.dependencies);

    await service.clearConversation(fixture.conversation.id);

    expect(fixture.dependencies.cancelTask).toHaveBeenCalledWith(runningTask.id);
    expect(order).toEqual(['cancel', 'clear']);
  });
});
