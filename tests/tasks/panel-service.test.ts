import { describe, expect, it, vi } from 'vitest';
import { PanelService } from '../../src/tasks/panel-service';
import type { TaskRun } from '../../src/tasks/task-types';

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
      listByTab: vi.fn(async () => [conversation]),
      get: vi.fn(async (): Promise<typeof conversation | undefined> => conversation),
      create: vi.fn(async () => undefined),
      listMessages: vi.fn(async () => [
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
      listByConversation: vi.fn(async (): Promise<TaskRun[]> => [task]),
      listEvents: vi.fn(async () => [
        {
          id: 'event_1',
          taskId: task.id,
          sequence: 1,
          type: 'task.completed' as const,
          reason: 'done',
          at: 1_190,
          error: null,
        },
      ]),
      getCheckpoint: vi.fn(async (...arguments_: [string]) => {
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
    tabs: {
      get: vi.fn(async () => ({ id: 7, title: 'Example', url: 'https://example.com/form' })),
    },
    permissions: { contains: vi.fn(async () => true) },
    clock: { now: () => 2_000 },
    ids: { create: (prefix: string) => `${prefix}_new` },
    scheduleTask: vi.fn(async (...arguments_: [string]) => {
      void arguments_;
    }),
  };
  return { conversation, dependencies, task };
}

describe('PanelService', () => {
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

  it('returns persisted credentials only from the explicit settings query', async () => {
    const fixture = buildFixture();
    const service = new PanelService(fixture.dependencies);

    await expect(service.getSettings()).resolves.toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'zh-CN',
      codexAccessToken: 'secret-token',
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
      codexAccessToken: 'new-token',
    });
    await service.clearConversation(fixture.conversation.id);

    expect(fixture.dependencies.credentials.setCodexAccessToken).toHaveBeenCalledWith('new-token');
    expect(fixture.dependencies.conversations.clearConversation).toHaveBeenCalledWith(
      fixture.conversation.id,
    );
    expect(fixture.dependencies.attachments.deleteUnreferenced).toHaveBeenCalledWith(
      2_000 - 24 * 60 * 60 * 1_000,
    );
  });
});
