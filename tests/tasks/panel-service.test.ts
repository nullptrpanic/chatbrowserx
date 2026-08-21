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
  const task: TaskRun = {
    id: 'task_1',
    workSessionId: 'workSession_1',
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
  const checkpoint: Checkpoint = {
    id: 'checkpoint_1',
    taskId: task.id,
    sequence: 1,
    taskStatus: task.status,
    completedToolResults: [],
    continuationItems: [{ type: 'message_ref' as const, messageId: 'message_1' }],
    pendingToolCall: null,
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
          kind: 'conversation',
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
      appendSupplement: vi.fn(async () => undefined),
      clearConversation: vi.fn(async () => undefined),
    },
    tasks: {
      listUnfinished: vi.fn(async (): Promise<TaskRun[]> => []),
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
      get: vi.fn(async (...arguments_: [string]) => {
        void arguments_;
        return task;
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
      getTavilyKey: vi.fn(async () => 'secret-tavily-key'),
      setTavilyKey: vi.fn(async () => undefined),
    },
    commands: {
      create: vi.fn(async () => ({ task, checkpoint, events: [] })),
      continueCancelled: vi.fn(async () => ({ task, checkpoint, events: [] })),
    },
    cancelTask: vi.fn(async () => ({ task, checkpoint, events: [] })),
    tabs: {
      get: vi.fn(async () => ({
        id: 7,
        title: 'Example',
        url: 'https://example.com/form',
        favIconUrl: 'https://example.com/favicon.ico',
      })),
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
  return { conversation, dependencies, task, checkpoint };
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
      favIconUrl: 'https://other.example/favicon.ico',
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
      userMessageId: 'message_new',
    });
  });

  it('persists the source page snapshot on each submitted user message', async () => {
    const fixture = buildFixture();
    fixture.dependencies.tabs.get.mockResolvedValue({
      id: 9,
      title: 'Median of Two Sorted Arrays',
      url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
      favIconUrl: 'https://leetcode.com/favicon.ico',
    });
    const service = new PanelService(fixture.dependencies);

    await service.submit({
      tabId: 9,
      conversationId: fixture.conversation.id,
      text: 'Fill in this solution',
      attachmentIds: [],
    });

    expect(fixture.dependencies.conversations.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePage: {
          title: 'Median of Two Sorted Arrays',
          url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
          favIconUrl: 'https://leetcode.com/favicon.ico',
        },
      }),
    );
  });

  it('drops a legacy source tab ID when projecting a persisted user message', async () => {
    const fixture = buildFixture();
    const legacySourcePage = {
      tabId: 7,
      title: 'Median of Two Sorted Arrays',
      url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
      favIconUrl: 'https://leetcode.com/favicon.ico',
    };
    fixture.dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_source',
        kind: 'conversation',
        conversationId: fixture.conversation.id,
        taskId: fixture.task.id,
        role: 'user',
        status: 'complete',
        text: 'Fill in this solution',
        attachmentIds: [],
        createdAt: 1_010,
        updatedAt: 1_010,
        sourcePage: legacySourcePage,
      } as MessageRecord,
    ]);
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);

    expect(snapshot.messages[0]?.sourcePage).toEqual({
      title: 'Median of Two Sorted Arrays',
      url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
      favIconUrl: 'https://leetcode.com/favicon.ico',
    });
  });

  it('continues the latest cancelled task in the same WorkSession', async () => {
    const fixture = buildFixture();
    const cancelledTask = { ...fixture.task, status: 'cancelled' as const };
    const continuedTask = {
      ...fixture.task,
      id: 'task_continued',
      status: 'queued' as const,
      tabId: 9,
    };
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([cancelledTask]);
    fixture.dependencies.commands.continueCancelled.mockResolvedValue({
      task: continuedTask,
      checkpoint: {
        id: 'checkpoint_continued',
        taskId: continuedTask.id,
        sequence: 0,
        taskStatus: 'queued',
        completedToolResults: [],
        continuationItems: [
          { type: 'message_ref', messageId: 'message_1' },
          { type: 'message_ref', messageId: 'message_new' },
        ],
        pendingToolCall: null,
        createdAt: 2_000,
      },
      events: [],
    });
    const service = new PanelService(fixture.dependencies);

    await service.submit({
      tabId: 9,
      conversationId: fixture.conversation.id,
      text: 'Continue after cancellation',
      attachmentIds: [],
    });

    expect(fixture.dependencies.commands.continueCancelled).toHaveBeenCalledWith({
      sourceTaskId: cancelledTask.id,
      tabId: 9,
      goal: 'Continue after cancellation',
      userMessageId: 'message_new',
    });
    expect(fixture.dependencies.commands.create).not.toHaveBeenCalled();
    expect(fixture.dependencies.scheduleTask).toHaveBeenCalledWith(continuedTask.id);
  });

  it('creates a fresh WorkSession after the cancelled task context was cleared', async () => {
    const fixture = buildFixture();
    const cancelledTask = { ...fixture.task, status: 'cancelled' as const };
    const freshTask = {
      ...fixture.task,
      id: 'task_fresh',
      workSessionId: 'workSession_fresh',
      status: 'queued' as const,
      tabId: 9,
    };
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([cancelledTask]);
    fixture.dependencies.tasks.listEvents.mockResolvedValue([
      {
        id: 'event_clear',
        taskId: cancelledTask.id,
        sequence: 1,
        type: 'task.context-cleared',
        reason: 'user_clear_task_context',
        at: 1_500,
        error: null,
      },
    ]);
    fixture.dependencies.commands.create.mockResolvedValue({
      task: freshTask,
      checkpoint: {
        id: 'checkpoint_fresh',
        taskId: freshTask.id,
        sequence: 0,
        taskStatus: 'queued',
        completedToolResults: [],
        continuationItems: [{ type: 'message_ref', messageId: 'message_new' }],
        pendingToolCall: null,
        createdAt: 2_000,
      },
      events: [],
    });
    const service = new PanelService(fixture.dependencies);

    await expect(service.getSnapshot(9, fixture.conversation.id)).resolves.toMatchObject({
      task: { id: cancelledTask.id, contextCleared: true },
    });

    await service.submit({
      tabId: 9,
      conversationId: fixture.conversation.id,
      text: 'Start from a clean task context',
      attachmentIds: [],
    });

    expect(fixture.dependencies.commands.continueCancelled).not.toHaveBeenCalled();
    expect(fixture.dependencies.commands.create).toHaveBeenCalledWith({
      conversationId: fixture.conversation.id,
      tabId: 9,
      goal: 'Start from a clean task context',
      userMessageId: 'message_new',
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
      settings: { hasCodexToken: true, hasTavilyKey: true },
      attachments: [{ id: 'attachment_1', fileName: 'photo.png' }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-token');
    expect(JSON.stringify(snapshot)).not.toContain('blob');
    expect(snapshot.tab).not.toHaveProperty('debuggerAttached');
  });

  it('projects a bounded reasoning summary with its corresponding task event', async () => {
    const fixture = buildFixture();
    fixture.dependencies.tasks.listEvents.mockResolvedValue([
      {
        id: 'event_reasoning',
        taskId: fixture.task.id,
        sequence: 1,
        type: 'reasoning.summary-recorded',
        reason: 'model_reasoning_summary_recorded',
        at: 1_180,
        error: null,
        reasoningSummary: 'r'.repeat(20_100),
      },
      {
        id: 'event_completed',
        taskId: fixture.task.id,
        sequence: 2,
        type: 'task.completed',
        reason: 'done',
        at: 1_190,
        error: null,
      },
    ]);
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);

    expect(snapshot.task?.events[0]).toMatchObject({
      type: 'reasoning.summary-recorded',
      reasoningSummary: 'r'.repeat(20_000),
    });
  });

  it('projects supplements under their running task without creating chat bubbles', async () => {
    const fixture = buildFixture();
    const runningTask = { ...fixture.task, status: 'planning' as const };
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([runningTask]);
    fixture.dependencies.tasks.getCheckpoint.mockResolvedValue({
      ...fixture.checkpoint,
      taskStatus: 'planning',
      continuationItems: [
        { type: 'message_ref', messageId: 'message_1' },
        { type: 'message_ref', messageId: 'supplement_1' },
      ],
    });
    fixture.dependencies.tasks.listEvents.mockResolvedValue([
      {
        id: 'event_supplements',
        taskId: runningTask.id,
        sequence: 1,
        type: 'task.supplements-applied',
        reason: 'user_supplements_applied',
        at: 1_150,
        error: null,
        supplementIds: ['supplement_1'],
      },
    ]);
    fixture.dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_1',
        kind: 'conversation',
        conversationId: fixture.conversation.id,
        taskId: runningTask.id,
        role: 'user',
        status: 'complete',
        text: 'Research this',
        attachmentIds: [],
        createdAt: 1_010,
        updatedAt: 1_010,
      },
      {
        id: 'supplement_1',
        kind: 'supplement',
        conversationId: fixture.conversation.id,
        taskId: runningTask.id,
        role: 'user',
        status: 'complete',
        text: 'Use official sources',
        attachmentIds: ['attachment_1'],
        createdAt: 1_100,
        updatedAt: 1_100,
      },
    ]);
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);

    expect(snapshot.messages.map(({ id }) => id)).toEqual(['message_1']);
    expect(snapshot.task?.supplements).toEqual([
      {
        id: 'supplement_1',
        text: 'Use official sources',
        attachmentIds: ['attachment_1'],
        createdAt: 1_100,
        detailIndex: 1,
        applicationState: 'applied',
      },
    ]);
    expect(snapshot.task?.events[0]?.supplementIds).toEqual(['supplement_1']);
    expect(snapshot.attachments).toEqual([
      expect.objectContaining({ id: 'attachment_1', fileName: 'photo.png' }),
    ]);
  });

  it('keeps a newly queued supplement pending until a WorkSession checkpoint references it', async () => {
    const fixture = buildFixture();
    const runningTask = { ...fixture.task, status: 'planning' as const };
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([runningTask]);
    fixture.dependencies.tasks.listEvents.mockResolvedValue([
      {
        id: 'event_other_supplement',
        taskId: runningTask.id,
        sequence: 1,
        type: 'task.supplements-applied',
        reason: 'user_supplements_applied',
        at: 1_200,
        error: null,
        supplementIds: ['another_supplement'],
      },
    ]);
    fixture.dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_1',
        kind: 'conversation',
        conversationId: fixture.conversation.id,
        taskId: runningTask.id,
        role: 'user',
        status: 'complete',
        text: 'Research this',
        attachmentIds: [],
        createdAt: 1_010,
        updatedAt: 1_010,
      },
      {
        id: 'supplement_pending',
        kind: 'supplement',
        conversationId: fixture.conversation.id,
        taskId: runningTask.id,
        role: 'user',
        status: 'complete',
        text: 'Use Go instead.',
        attachmentIds: [],
        createdAt: 1_100,
        updatedAt: 1_100,
      },
    ]);
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);

    expect(snapshot.task?.supplements).toEqual([
      expect.objectContaining({ id: 'supplement_pending', applicationState: 'pending' }),
    ]);
  });

  it('marks an earlier task supplement applied when a continued WorkSession references it', async () => {
    const fixture = buildFixture();
    const cancelledTask: TaskRun = {
      ...fixture.task,
      status: 'cancelled',
      checkpointId: 'checkpoint_cancelled',
    };
    const continuedTask: TaskRun = {
      ...fixture.task,
      id: 'task_continued',
      status: 'planning',
      createdAt: 1_200,
      updatedAt: 1_300,
      checkpointId: 'checkpoint_continued',
    };
    fixture.dependencies.tasks.get.mockResolvedValue(cancelledTask);
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([cancelledTask, continuedTask]);
    fixture.dependencies.tasks.listEvents.mockResolvedValue([]);
    fixture.dependencies.tasks.getCheckpoint.mockImplementation(async (checkpointId) =>
      checkpointId === 'checkpoint_continued'
        ? {
            ...fixture.checkpoint,
            id: checkpointId,
            taskId: continuedTask.id,
            taskStatus: continuedTask.status,
            continuationItems: [
              { type: 'message_ref', messageId: 'message_1' },
              { type: 'message_ref', messageId: 'supplement_from_cancelled' },
            ],
          }
        : {
            ...fixture.checkpoint,
            id: checkpointId,
            taskId: cancelledTask.id,
            taskStatus: cancelledTask.status,
          },
    );
    fixture.dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_1',
        kind: 'conversation',
        conversationId: fixture.conversation.id,
        taskId: cancelledTask.id,
        role: 'user',
        status: 'complete',
        text: 'Research this',
        attachmentIds: [],
        createdAt: 1_010,
        updatedAt: 1_010,
      },
      {
        id: 'supplement_from_cancelled',
        kind: 'supplement',
        conversationId: fixture.conversation.id,
        taskId: cancelledTask.id,
        role: 'user',
        status: 'complete',
        text: 'Use Go instead.',
        attachmentIds: [],
        createdAt: 1_100,
        updatedAt: 1_100,
      },
    ]);
    const service = new PanelService(fixture.dependencies);

    const details = await service.getTaskDetails(cancelledTask.id);

    expect(details.supplements).toEqual([
      expect.objectContaining({
        id: 'supplement_from_cancelled',
        applicationState: 'applied',
      }),
    ]);
  });

  it('projects each continued task as its cumulative WorkSession prefix with original event times', async () => {
    const fixture = buildFixture();
    const cancelledTask: TaskRun = {
      ...fixture.task,
      status: 'cancelled',
      createdAt: 1_000,
      updatedAt: 1_500,
      checkpointId: 'checkpoint_cancelled',
    };
    const continuedTask: TaskRun = {
      ...fixture.task,
      id: 'task_continued',
      status: 'completed',
      createdAt: 2_000,
      updatedAt: 2_500,
      checkpointId: 'checkpoint_continued',
    };
    const oldResult = {
      callId: 'call_old',
      toolName: 'browser_inspect',
      argumentsJson: '{"tabId":7}',
      output: '{"ok":true,"page":"old"}',
      resultRef: 'result_old',
      attachmentIds: [],
    };
    const newResult = {
      callId: 'call_new',
      toolName: 'browser_click',
      argumentsJson: '{"ref":"e2"}',
      output: '{"ok":true,"page":"new"}',
      resultRef: 'result_new',
      attachmentIds: [],
    };
    fixture.dependencies.tasks.get.mockImplementation(async (taskId) =>
      taskId === continuedTask.id ? continuedTask : cancelledTask,
    );
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([continuedTask, cancelledTask]);
    fixture.dependencies.tasks.listEvents.mockImplementation(async (taskId) =>
      taskId === cancelledTask.id
        ? [
            {
              id: 'event_old_result',
              taskId,
              sequence: 1,
              type: 'tool.result-recorded',
              reason: 'browser_inspect_result_recorded',
              at: 1_100,
              error: null,
            },
            {
              id: 'event_old_supplement',
              taskId,
              sequence: 2,
              type: 'task.supplements-applied',
              reason: 'user_supplements_applied',
              at: 1_300,
              error: null,
              supplementIds: ['supplement_old'],
            },
          ]
        : [
            {
              id: 'event_new_result',
              taskId,
              sequence: 1,
              type: 'tool.result-recorded',
              reason: 'browser_click_result_recorded',
              at: 2_100,
              error: null,
            },
            {
              id: 'event_new_supplement',
              taskId,
              sequence: 2,
              type: 'task.supplements-applied',
              reason: 'user_supplements_applied',
              at: 2_300,
              error: null,
              supplementIds: ['supplement_new'],
            },
          ],
    );
    fixture.dependencies.tasks.getCheckpoint.mockImplementation(async (checkpointId) =>
      checkpointId === cancelledTask.checkpointId
        ? {
            ...fixture.checkpoint,
            id: checkpointId,
            taskId: cancelledTask.id,
            sequence: 2,
            taskStatus: cancelledTask.status,
            completedToolResults: [oldResult],
            continuationItems: [
              { type: 'message_ref', messageId: 'message_1' },
              { type: 'message_ref', messageId: 'supplement_old' },
            ],
            createdAt: 1_500,
          }
        : {
            ...fixture.checkpoint,
            id: checkpointId,
            taskId: continuedTask.id,
            sequence: 2,
            taskStatus: continuedTask.status,
            completedToolResults: [oldResult, newResult],
            continuationItems: [
              { type: 'message_ref', messageId: 'message_1' },
              { type: 'message_ref', messageId: 'supplement_old' },
              { type: 'message_ref', messageId: 'supplement_new' },
            ],
            createdAt: 2_500,
          },
    );
    fixture.dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_1',
        kind: 'conversation',
        conversationId: fixture.conversation.id,
        taskId: cancelledTask.id,
        role: 'user',
        status: 'complete',
        text: 'Inspect this page',
        attachmentIds: [],
        createdAt: 1_010,
        updatedAt: 1_010,
      },
      {
        id: 'supplement_old',
        kind: 'supplement',
        conversationId: fixture.conversation.id,
        taskId: cancelledTask.id,
        role: 'user',
        status: 'complete',
        text: 'Use the old task context.',
        attachmentIds: [],
        createdAt: 1_250,
        updatedAt: 1_250,
      },
      {
        id: 'supplement_new',
        kind: 'supplement',
        conversationId: fixture.conversation.id,
        taskId: continuedTask.id,
        role: 'user',
        status: 'complete',
        text: 'Then continue from here.',
        attachmentIds: [],
        createdAt: 2_250,
        updatedAt: 2_250,
      },
    ]);
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);
    const [cancelledDetails, continuedDetails] = await Promise.all([
      service.getTaskDetails(cancelledTask.id),
      service.getTaskDetails(continuedTask.id),
    ]);

    const continuedSummary = snapshot.tasks.find(({ id }) => id === continuedTask.id);
    expect(continuedSummary?.events.map(({ type, at }) => ({ type, at }))).toEqual([
      { type: 'tool.result-recorded', at: 2_100 },
      { type: 'task.supplements-applied', at: 2_300 },
    ]);
    expect(continuedSummary?.supplements.map(({ id }) => id)).toEqual([
      'supplement_old',
      'supplement_new',
    ]);
    expect(
      cancelledDetails.events.map(({ sequence, type, at }) => ({ sequence, type, at })),
    ).toEqual([
      { sequence: 1, type: 'tool.result-recorded', at: 1_100 },
      { sequence: 2, type: 'task.supplements-applied', at: 1_300 },
    ]);
    expect(cancelledDetails.supplements.map(({ id }) => id)).toEqual(['supplement_old']);
    expect(
      continuedDetails.events.map(({ sequence, type, at }) => ({ sequence, type, at })),
    ).toEqual([
      { sequence: 1, type: 'tool.result-recorded', at: 1_100 },
      { sequence: 2, type: 'task.supplements-applied', at: 1_300 },
      { sequence: 1, type: 'tool.result-recorded', at: 2_100 },
      { sequence: 2, type: 'task.supplements-applied', at: 2_300 },
    ]);
    expect(
      continuedDetails.completedToolResults.map(({ callId, detailIndex }) => [callId, detailIndex]),
    ).toEqual([
      ['call_old', 1],
      ['call_new', 3],
    ]);
    expect(
      continuedDetails.supplements.map(({ id, detailIndex, createdAt }) => ({
        id,
        detailIndex,
        createdAt,
      })),
    ).toEqual([
      { id: 'supplement_old', detailIndex: 2, createdAt: 1_250 },
      { id: 'supplement_new', detailIndex: 4, createdAt: 2_250 },
    ]);
  });

  it('projects one continuous detail index across tool results and user supplements', async () => {
    const fixture = buildFixture();
    fixture.dependencies.tasks.listEvents.mockResolvedValue([
      {
        id: 'event_result_1',
        taskId: fixture.task.id,
        sequence: 1,
        type: 'tool.result-recorded',
        reason: 'browser_inspect_result_recorded',
        at: 1_100,
        error: null,
      },
      {
        id: 'event_supplement',
        taskId: fixture.task.id,
        sequence: 2,
        type: 'task.supplements-applied',
        reason: 'user_supplements_applied',
        at: 1_200,
        error: null,
        supplementIds: ['supplement_1'],
      },
      {
        id: 'event_result_2',
        taskId: fixture.task.id,
        sequence: 3,
        type: 'tool.result-recorded',
        reason: 'browser_click_result_recorded',
        at: 1_300,
        error: null,
      },
    ]);
    fixture.dependencies.tasks.getCheckpoint.mockResolvedValue({
      ...fixture.checkpoint,
      sequence: 3,
      completedToolResults: [
        {
          callId: 'call_1',
          toolName: 'browser_inspect',
          argumentsJson: '{}',
          output: '{"ok":true}',
          resultRef: 'result_1',
          attachmentIds: [],
        },
        {
          callId: 'call_2',
          toolName: 'browser_click',
          argumentsJson: '{"ref":"e2"}',
          output: '{"ok":true}',
          resultRef: 'result_2',
          attachmentIds: [],
        },
      ],
    });
    fixture.dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_1',
        kind: 'conversation',
        conversationId: fixture.conversation.id,
        taskId: fixture.task.id,
        role: 'user',
        status: 'complete',
        text: 'Book a room',
        attachmentIds: [],
        createdAt: 1_010,
        updatedAt: 1_010,
      },
      {
        id: 'supplement_1',
        kind: 'supplement',
        conversationId: fixture.conversation.id,
        taskId: fixture.task.id,
        role: 'user',
        status: 'complete',
        text: 'Prefer a room with natural light.',
        attachmentIds: [],
        createdAt: 1_150,
        updatedAt: 1_150,
      },
    ]);
    const service = new PanelService(fixture.dependencies);

    const details = await service.getTaskDetails(fixture.task.id);

    expect(details.detailItemCount).toBe(3);
    expect(
      details.completedToolResults.map(({ callId, detailIndex }) => [callId, detailIndex]),
    ).toEqual([
      ['call_1', 1],
      ['call_2', 3],
    ]);
    expect(details.supplements).toEqual([
      expect.objectContaining({ id: 'supplement_1', detailIndex: 2 }),
    ]);
  });

  it('persists a sanitized supplement for the current running task', async () => {
    const fixture = buildFixture();
    const runningTask = { ...fixture.task, status: 'queued' as const };
    fixture.dependencies.tasks.get.mockResolvedValue(runningTask);
    const service = new PanelService(fixture.dependencies);

    await expect(
      service.supplement({
        taskId: runningTask.id,
        text: ' Prioritize official sources. ',
        attachmentIds: [],
      }),
    ).resolves.toEqual({ accepted: true, id: 'supplement_new' });
    expect(fixture.dependencies.conversations.appendSupplement).toHaveBeenCalledWith({
      id: 'supplement_new',
      kind: 'supplement',
      conversationId: fixture.conversation.id,
      taskId: runningTask.id,
      role: 'user',
      status: 'complete',
      text: 'Prioritize official sources.',
      attachmentIds: [],
      createdAt: 2_000,
      updatedAt: 2_000,
    });
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
      attachmentIds: index === 21 ? ['attachment_tool'] : [],
    }));
    fixture.dependencies.conversations.listMessages.mockResolvedValue([
      {
        id: 'message_user_1',
        kind: 'conversation',
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
        kind: 'conversation',
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
        kind: 'conversation',
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
    fixture.dependencies.tasks.listEvents.mockImplementation(async (taskId) =>
      taskId === secondTask.id
        ? [
            ...completedToolResults.map((_, index): TaskEvent => ({
              id: `event_tool_${index}`,
              taskId,
              sequence: index + 1,
              type: 'tool.result-recorded',
              reason: 'tool_result_recorded',
              at: 1_200 + index,
              error: null,
            })),
            {
              id: `event_${taskId}`,
              taskId,
              sequence: 23,
              type: 'task.completed',
              reason: 'done',
              at: 1_300,
              error: null,
            },
          ]
        : [
            {
              id: `event_${taskId}`,
              taskId,
              sequence: 1,
              type: 'task.completed',
              reason: 'done',
              at: 1_190,
              error: null,
            },
          ],
    );
    fixture.dependencies.tasks.getCheckpoint.mockImplementation(async (checkpointId) => ({
      id: checkpointId,
      taskId: checkpointId === 'checkpoint_2' ? secondTask.id : fixture.task.id,
      sequence: checkpointId === 'checkpoint_2' ? 23 : 1,
      taskStatus: 'completed',
      completedToolResults: checkpointId === 'checkpoint_2' ? completedToolResults : [],
      continuationItems: [],
      pendingToolCall: null,
      createdAt: checkpointId === 'checkpoint_2' ? 1_300 : 1_190,
    }));
    fixture.dependencies.tasks.get.mockImplementation(async (taskId) =>
      taskId === secondTask.id ? secondTask : fixture.task,
    );
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);

    expect(snapshot.messages.map(({ taskId }) => taskId)).toEqual([
      fixture.task.id,
      fixture.task.id,
      secondTask.id,
    ]);
    expect(snapshot.tasks.map(({ id }) => id)).toEqual([fixture.task.id, secondTask.id]);
    const bashTask = snapshot.tasks.find(({ id }) => id === secondTask.id);
    expect(bashTask?.completedToolResults).toEqual([]);

    const details = await service.getTaskDetails(secondTask.id);

    expect(details.detailLevel).toBe('full');
    expect(details.completedToolResults).toHaveLength(22);
    expect(details.completedToolResults[0]?.callId).toBe('call_0');
    expect(details.completedToolResults.at(-1)).toMatchObject({
      callId: 'call_21',
      toolName: 'bash',
    });
    expect(details.completedToolResults.at(-1)?.argumentsJson).toHaveLength(20_000);
    expect(details.completedToolResults.at(-1)?.output).toHaveLength(100_000);
    expect(details.completedToolResults.at(-1)?.attachmentIds).toEqual(['attachment_tool']);
    expect(fixture.dependencies.tasks.get).toHaveBeenCalledWith(secondTask.id);
  });

  it('omits historical audit noise while retaining a legacy tool result', async () => {
    const fixture = buildFixture();
    const events = Array.from({ length: 442 }, (_, index): TaskEvent => ({
      id: `event_${index + 1}`,
      taskId: fixture.task.id,
      sequence: index + 1,
      type: index === 441 ? 'task.completed' : 'reasoning.summary-recorded',
      reason: index === 441 ? 'done' : 'progress',
      at: 1_000 + index,
      error: null,
    }));
    fixture.dependencies.tasks.listEvents.mockResolvedValue(events);
    fixture.dependencies.tasks.getCheckpoint.mockResolvedValue({
      ...fixture.checkpoint,
      sequence: 442,
      completedToolResults: [
        {
          callId: 'call_before_window',
          toolName: 'browser_inspect',
          argumentsJson: '{}',
          output: 'old output',
          resultRef: 'result_before_window',
          attachmentIds: [],
        },
      ],
    });
    const service = new PanelService(fixture.dependencies);

    const summary = await service.getSnapshot(7);
    const details = await service.getTaskDetails(fixture.task.id);

    expect(summary.task?.events).toHaveLength(100);
    expect(summary.task?.events[0]?.sequence).toBe(343);
    expect(summary.task?.completedToolCallCount).toBe(1);
    expect(details.events).toEqual([]);
    expect(details.completedToolResults).toHaveLength(1);
    expect(details.completedToolResults[0]?.callId).toBe('call_before_window');
  });

  it('returns the latest 100 tool results even when audit events surround every call', async () => {
    const fixture = buildFixture();
    const events = Array.from({ length: 120 }, (_, index) =>
      [
        ['reasoning.summary-recorded', 'model_reasoning_summary_recorded'],
        ['tool.call-recorded', 'browser_inspect_call_recorded'],
        ['tool.execution-started', 'browser_inspect_execution_started'],
        ['tool.result-recorded', 'browser_inspect_result_recorded'],
      ].map(([type, reason], eventIndex): TaskEvent => ({
        id: `event_${index + 1}_${eventIndex + 1}`,
        taskId: fixture.task.id,
        sequence: index * 4 + eventIndex + 1,
        type: type as TaskEvent['type'],
        reason: reason ?? 'progress',
        at: 1_000 + index * 4 + eventIndex,
        error: null,
      })),
    ).flat();
    const completedToolResults = Array.from({ length: 120 }, (_, index) => ({
      callId: `call_${index + 1}`,
      toolName: 'browser_inspect',
      argumentsJson: '{}',
      output: `output_${index + 1}`,
      resultRef: `result_${index + 1}`,
      attachmentIds: [],
    }));
    fixture.dependencies.tasks.listEvents.mockResolvedValue(events);
    fixture.dependencies.tasks.getCheckpoint.mockResolvedValue({
      ...fixture.checkpoint,
      sequence: 480,
      completedToolResults,
    });
    const service = new PanelService(fixture.dependencies);

    const summary = await service.getSnapshot(7);
    const details = await service.getTaskDetails(fixture.task.id);

    expect(summary.task?.completedToolResults).toEqual([]);
    expect(summary.task?.completedToolCallCount).toBe(120);
    expect(details.events).toHaveLength(100);
    expect(details.events[0]?.sequence).toBe(84);
    expect(details.events.every(({ type }) => type === 'tool.result-recorded')).toBe(true);
    expect(details.completedToolResults).toHaveLength(100);
    expect(details.completedToolResults[0]?.callId).toBe('call_21');
    expect(details.completedToolResults.at(-1)?.callId).toBe('call_120');
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
      tavilyKey: 'secret-tavily-key',
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
    ).rejects.toMatchObject({ code: 'TASK_ALREADY_RUNNING', message: '已有任务运行中' });
    expect(fixture.dependencies.conversations.appendMessage).not.toHaveBeenCalled();
    expect(fixture.dependencies.commands.create).not.toHaveBeenCalled();
  });

  it('rejects a new task when any other global conversation has unfinished work', async () => {
    const fixture = buildFixture();
    fixture.dependencies.tasks.listUnfinished.mockResolvedValue([
      {
        ...fixture.task,
        id: 'task_running_elsewhere',
        conversationId: 'conversation_elsewhere',
        status: 'planning',
      },
    ]);
    const service = new PanelService(fixture.dependencies);

    await expect(
      service.submit({ tabId: 7, text: 'Start a parallel task', attachmentIds: [] }),
    ).rejects.toMatchObject({
      code: 'TASK_ALREADY_RUNNING',
      message: '已有任务运行中',
    });
    expect(fixture.dependencies.conversations.create).not.toHaveBeenCalled();
    expect(fixture.dependencies.conversations.appendMessage).not.toHaveBeenCalled();
    expect(fixture.dependencies.commands.create).not.toHaveBeenCalled();
  });

  it('serializes concurrent submissions before either can create a second task', async () => {
    const fixture = buildFixture();
    let releaseCheck: (() => void) | undefined;
    fixture.dependencies.tasks.listUnfinished.mockImplementationOnce(
      () =>
        new Promise<TaskRun[]>((resolve) => {
          releaseCheck = () => resolve([]);
        }),
    );
    const service = new PanelService(fixture.dependencies);

    const first = service.submit({ tabId: 7, text: 'First task', attachmentIds: [] });
    await Promise.resolve();
    await expect(
      service.submit({ tabId: 7, text: 'Second task', attachmentIds: [] }),
    ).rejects.toMatchObject({ code: 'TASK_ALREADY_RUNNING' });
    releaseCheck?.();
    await first;

    expect(fixture.dependencies.commands.create).toHaveBeenCalledTimes(1);
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
      tavilyKey: 'new-tavily-key',
    });
    await service.clearConversation(fixture.conversation.id);

    expect(fixture.dependencies.credentials.setCodexAccessToken).toHaveBeenCalledWith('new-token');
    expect(fixture.dependencies.credentials.setTavilyKey).toHaveBeenCalledWith('new-tavily-key');
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
