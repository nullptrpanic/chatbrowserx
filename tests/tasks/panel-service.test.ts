import { describe, expect, it, vi } from 'vitest';
import type { PersistedTaskArchive } from '../../src/persistence/task-repository';
import { PanelService } from '../../src/tasks/panel-service';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { Task, TaskEvent, TaskRun } from '../../src/tasks/task-types';
import type { MaterializedToolResult } from '../../src/tasks/tool-result-types';

/** Builds a complete Panel service dependency fixture with no secret-bearing output. */
function buildFixture() {
  const conversation = {
    id: 'conversation_1',
    tabId: 7,
    title: 'Book a room',
    createdAt: 1_000,
    updatedAt: 1_200,
  };
  const task: Task = {
    id: 'task_1',
    conversationId: conversation.id,
    ordinal: 1,
    tabId: 7,
    goal: 'Book a room',
    status: 'completed' as const,
    latestRunId: 'run_1',
    lastEventSequence: 1,
    createdAt: 1_010,
    updatedAt: 1_190,
  };
  const run: TaskRun = {
    id: 'run_1',
    taskId: task.id,
    attempt: 1,
    status: 'completed',
    checkpointId: null,
    lease: null,
    error: null,
    startedAt: 1_010,
    endedAt: 1_190,
  };
  const checkpoint: Checkpoint = {
    id: 'checkpoint_1',
    taskId: task.id,
    runId: run.id,
    continuationItems: [{ type: 'message_ref' as const, messageId: 'message_1' }],
    pendingToolCall: null,
    browserToolCallsInAttempt: 0,
    browserTargetTabId: 7,
    createdAt: 1_190,
  };
  const events: TaskEvent[] = [
    {
      id: 'event_1',
      taskId: task.id,
      runId: run.id,
      sequence: 1,
      type: 'status.changed',
      taskStatus: 'completed',
      runStatus: 'completed',
      reason: 'task.completed',
      at: 1_190,
      error: null,
    },
  ];
  const archive: PersistedTaskArchive = {
    task,
    runs: [run],
    events,
    toolResults: [],
  };
  const listMessages = vi.fn(async (_conversationId?: string): Promise<MessageRecord[]> => {
    void _conversationId;
    return [
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
    ];
  });
  const dependencies = {
    conversations: {
      listAll: vi.fn(async () => [conversation]),
      get: vi.fn(async (): Promise<typeof conversation | undefined> => conversation),
      listMessages,
      listRecentMessages: vi.fn(async (conversationId: string, limit: number) =>
        (await listMessages(conversationId)).slice(-limit),
      ),
      listTaskMessages: vi.fn(async (taskId: string) =>
        (await listMessages()).filter((message) => message.taskId === taskId),
      ),
      appendSupplement: vi.fn(async () => undefined),
      clearConversation: vi.fn(async () => undefined),
    },
    tasks: {
      listAll: vi.fn(async (): Promise<Task[]> => [task]),
      listByConversation: vi.fn(async (conversationId: string): Promise<Task[]> => {
        void conversationId;
        return [task];
      }),
      listEvents: vi.fn(async (taskId: string): Promise<TaskEvent[]> => {
        void taskId;
        return events;
      }),
      readTaskArchive: vi.fn(async (taskId: string) => (taskId === task.id ? archive : undefined)),
      readTaskArchives: vi.fn(async (taskIds: readonly string[]) =>
        taskIds.includes(task.id) ? [archive] : [],
      ),
      readTaskTimelines: vi.fn(async (taskIds: readonly string[]) =>
        taskIds.includes(task.id)
          ? [{ task: archive.task, runs: archive.runs, events: archive.events }]
          : [],
      ),
      readTaskDetailWindow: vi.fn(async (taskId: string) =>
        taskId === task.id ? archive : undefined,
      ),
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
        sandboxServer: '',
      })),
      save: vi.fn(async () => undefined),
    },
    credentials: {
      getCodexAccessToken: vi.fn(async () => 'secret-token'),
      setCodexAccessToken: vi.fn(async () => undefined),
      getTavilyKey: vi.fn(async () => 'secret-tavily-key'),
      setTavilyKey: vi.fn(async () => undefined),
      getSandboxToken: vi.fn(async (): Promise<string | undefined> => undefined),
      setSandboxToken: vi.fn(async () => undefined),
    },
    agent: {
      start: vi.fn(async () => ({
        task,
        run,
        checkpoint,
        events: [],
        toolResults: [],
      })),
      supplement: vi.fn(async () => undefined),
      cancel: vi.fn(async () => ({
        task,
        run,
        checkpoint,
        events: [],
        toolResults: [],
      })),
    },
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
    stateVersion: { get: () => 0, changed: vi.fn() },
  };
  return { conversation, dependencies, task, run, checkpoint, events, archive };
}

type PanelFixture = ReturnType<typeof buildFixture>;

/** Replaces the permanent task archive returned to both summary and detail projections. */
function useArchive(
  fixture: PanelFixture,
  overrides: Partial<PersistedTaskArchive>,
): PersistedTaskArchive {
  const archive: PersistedTaskArchive = {
    task: overrides.task ?? fixture.task,
    runs: overrides.runs ?? [fixture.run],
    events: overrides.events ?? fixture.events,
    toolResults: overrides.toolResults ?? [],
  };
  fixture.dependencies.tasks.readTaskArchive.mockImplementation(async (taskId) =>
    taskId === archive.task.id ? archive : undefined,
  );
  fixture.dependencies.tasks.readTaskArchives.mockImplementation(async (taskIds) =>
    taskIds.includes(archive.task.id) ? [archive] : [],
  );
  fixture.dependencies.tasks.readTaskTimelines.mockImplementation(async (taskIds) =>
    taskIds.includes(archive.task.id)
      ? [{ task: archive.task, runs: archive.runs, events: archive.events }]
      : [],
  );
  fixture.dependencies.tasks.readTaskDetailWindow.mockImplementation(async (taskId) =>
    taskId === archive.task.id ? archive : undefined,
  );
  return archive;
}

/** Creates one canonical permanent tool result for panel projection tests. */
function panelResult(
  fixture: PanelFixture,
  input: Pick<MaterializedToolResult, 'callId' | 'toolName' | 'argumentsJson' | 'output'> & {
    readonly resultId: string;
    readonly attachmentIds?: readonly string[];
  },
): MaterializedToolResult {
  return {
    id: input.resultId,
    taskId: fixture.task.id,
    runId: fixture.run.id,
    callId: input.callId,
    toolName: input.toolName,
    argumentsJson: input.argumentsJson,
    output: input.output,
    attachmentIds: input.attachmentIds ?? [],
    createdAt: 1_100,
  };
}

describe('PanelService', () => {
  it('reads all task summaries once instead of querying once per conversation', async () => {
    const fixture = buildFixture();
    const anotherConversation = {
      id: 'conversation_2',
      tabId: 8,
      title: 'Another task',
      createdAt: 900,
      updatedAt: 1_100,
    };
    fixture.dependencies.conversations.listAll.mockResolvedValue([
      anotherConversation,
      fixture.conversation,
    ]);
    const listAll = vi.fn(async () => [fixture.task]);
    const service = new PanelService({
      ...fixture.dependencies,
      tasks: { ...fixture.dependencies.tasks, listAll },
      stateVersion: { get: () => 17, changed: vi.fn() },
    });

    const snapshot = await service.getSnapshot(7, fixture.conversation.id);

    expect(listAll).toHaveBeenCalledOnce();
    expect(fixture.dependencies.tasks.listByConversation).not.toHaveBeenCalled();
    expect(snapshot.stateVersion).toBe(17);
    expect(snapshot.conversations).toMatchObject([
      { id: anotherConversation.id, taskStatus: null },
      { id: fixture.conversation.id, taskStatus: 'completed' },
    ]);
  });

  it('uses bounded message, timeline, and task-detail projections', async () => {
    const fixture = buildFixture();
    const service = new PanelService(fixture.dependencies);

    await service.getSnapshot(7, fixture.conversation.id);
    await service.getTaskDetails(fixture.task.id);

    expect(fixture.dependencies.conversations.listRecentMessages).toHaveBeenCalledWith(
      fixture.conversation.id,
      500,
    );
    expect(fixture.dependencies.conversations.listTaskMessages).toHaveBeenCalledWith(
      fixture.task.id,
    );
    expect(fixture.dependencies.tasks.readTaskTimelines).toHaveBeenCalledWith([fixture.task.id]);
    expect(fixture.dependencies.tasks.readTaskDetailWindow).toHaveBeenCalledWith(
      fixture.task.id,
      100,
    );
    expect(fixture.dependencies.tasks.readTaskArchives).not.toHaveBeenCalled();
    expect(fixture.dependencies.tasks.readTaskArchive).not.toHaveBeenCalled();
  });

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

    expect(snapshot.tab).toMatchObject({
      id: 9,
      origin: 'https://other.example',
    });
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

    expect(fixture.dependencies.agent.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        submission: expect.objectContaining({
          conversation: fixture.conversation,
          createConversation: false,
          tabId: 9,
          goal: 'Continue from another page',
          message: expect.objectContaining({
            id: 'message_new',
            conversationId: fixture.conversation.id,
            text: 'Continue from another page',
          }),
        }),
      }),
    );
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

    expect(fixture.dependencies.agent.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        submission: expect.objectContaining({
          message: expect.objectContaining({
            sourcePage: {
              title: 'Median of Two Sorted Arrays',
              url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/description/',
              favIconUrl: 'https://leetcode.com/favicon.ico',
            },
          }),
        }),
      }),
    );
  });

  it('persists a validated assistant reply reference without depending on recent-history limits', async () => {
    const fixture = buildFixture();
    const target: MessageRecord = {
      id: 'message_assistant_old',
      kind: 'conversation',
      conversationId: fixture.conversation.id,
      taskId: fixture.task.id,
      role: 'assistant',
      status: 'complete',
      text: 'The complete historical answer that the user selected.',
      attachmentIds: ['attachment_reply_image'],
      createdAt: 1_100,
      updatedAt: 1_100,
    };
    fixture.dependencies.conversations.listTaskMessages.mockResolvedValue([target]);
    const service = new PanelService(fixture.dependencies);

    await service.submit({
      tabId: 9,
      conversationId: fixture.conversation.id,
      text: 'Please explain the second point.',
      attachmentIds: [],
      replyTo: { messageId: target.id, taskId: target.taskId },
    });

    expect(fixture.dependencies.conversations.listTaskMessages).toHaveBeenCalledWith(target.taskId);
    expect(fixture.dependencies.agent.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        submission: expect.objectContaining({
          message: expect.objectContaining({
            replyTo: {
              messageId: target.id,
              taskId: target.taskId,
              excerpt: target.text,
              attachmentCount: 1,
              createdAt: target.createdAt,
            },
          }),
        }),
      }),
    );
  });

  it('continues the latest cancelled logical task with a new run', async () => {
    const fixture = buildFixture();
    const cancelledTask = { ...fixture.task, status: 'cancelled' as const };
    const continuedTask = {
      ...fixture.task,
      status: 'queued' as const,
      tabId: 9,
      latestRunId: 'run_continued',
    };
    const continuedRun: TaskRun = {
      ...fixture.run,
      id: 'run_continued',
      attempt: 2,
      status: 'queued',
      checkpointId: 'checkpoint_continued',
      endedAt: null,
    };
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([cancelledTask]);
    fixture.dependencies.agent.start.mockResolvedValue({
      task: continuedTask,
      run: continuedRun,
      checkpoint: {
        id: 'checkpoint_continued',
        taskId: continuedTask.id,
        runId: continuedRun.id,
        continuationItems: [
          { type: 'message_ref', messageId: 'message_1' },
          { type: 'message_ref', messageId: 'message_new' },
        ],
        pendingToolCall: null,
        browserToolCallsInAttempt: 0,
        browserTargetTabId: 9,
        createdAt: 2_000,
      },
      events: [],
      toolResults: [],
    });
    const service = new PanelService(fixture.dependencies);

    await service.submit({
      tabId: 9,
      conversationId: fixture.conversation.id,
      text: 'Continue after cancellation',
      attachmentIds: [],
    });

    expect(fixture.dependencies.agent.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'continue',
        submission: expect.objectContaining({
          sourceTaskId: cancelledTask.id,
          tabId: 9,
          conversation: fixture.conversation,
          message: expect.objectContaining({ id: 'message_new' }),
        }),
      }),
    );
    expect(fixture.dependencies.agent.start).toHaveBeenCalledOnce();
  });

  it('creates a fresh logical task after the cancelled task context was cleared', async () => {
    const fixture = buildFixture();
    const cancelledTask = { ...fixture.task, status: 'cancelled' as const };
    const freshTask = {
      ...fixture.task,
      id: 'task_fresh',
      ordinal: 2,
      status: 'queued' as const,
      tabId: 9,
      latestRunId: 'run_fresh',
    };
    const freshRun: TaskRun = {
      ...fixture.run,
      id: 'run_fresh',
      taskId: freshTask.id,
      status: 'queued',
      checkpointId: 'checkpoint_fresh',
      endedAt: null,
    };
    fixture.dependencies.tasks.listAll.mockResolvedValue([cancelledTask]);
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([cancelledTask]);
    const clearEvents: TaskEvent[] = [
      {
        id: 'event_clear',
        taskId: cancelledTask.id,
        runId: fixture.run.id,
        sequence: 1,
        type: 'context.cleared',
        at: 1_500,
      },
    ];
    fixture.dependencies.tasks.listEvents.mockResolvedValue(clearEvents);
    useArchive(fixture, { task: cancelledTask, events: clearEvents });
    fixture.dependencies.agent.start.mockResolvedValue({
      task: freshTask,
      run: freshRun,
      checkpoint: {
        id: 'checkpoint_fresh',
        taskId: freshTask.id,
        runId: freshRun.id,
        continuationItems: [{ type: 'message_ref', messageId: 'message_new' }],
        pendingToolCall: null,
        browserToolCallsInAttempt: 0,
        browserTargetTabId: 9,
        createdAt: 2_000,
      },
      events: [],
      toolResults: [],
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

    expect(fixture.dependencies.agent.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        submission: expect.objectContaining({
          conversationId: fixture.conversation.id,
          tabId: 9,
          goal: 'Start from a clean task context',
          message: expect.objectContaining({ id: 'message_new' }),
        }),
      }),
    );
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
      tab: {
        id: 7,
        origin: 'https://example.com',
        supported: true,
        hasPermission: true,
      },
      conversation: { id: fixture.conversation.id, taskStatus: 'completed' },
      task: { id: fixture.task.id, sequence: 1 },
      settings: { hasCodexToken: true, hasTavilyKey: true },
      attachments: [{ id: 'attachment_1', fileName: 'photo.png' }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-token');
    expect(JSON.stringify(snapshot)).not.toContain('blob');
    expect(snapshot.tab).not.toHaveProperty('debuggerAttached');
  });

  it('keeps summary snapshots to the latest status event without hidden reasoning text', async () => {
    const fixture = buildFixture();
    const events: TaskEvent[] = [
      {
        id: 'event_reasoning',
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: 1,
        type: 'reasoning.summary',
        summary: 'r'.repeat(20_100),
        at: 1_180,
      },
      {
        id: 'event_completed',
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: 2,
        type: 'status.changed',
        taskStatus: 'completed',
        runStatus: 'completed',
        reason: 'done',
        at: 1_190,
        error: null,
      },
    ];
    useArchive(fixture, {
      task: { ...fixture.task, lastEventSequence: 2 },
      events,
    });
    const service = new PanelService(fixture.dependencies);

    const snapshot = await service.getSnapshot(7);

    expect(snapshot.task?.events).toEqual([
      expect.objectContaining({
        type: 'done',
        sequence: 2,
      }),
    ]);
    expect(snapshot.task?.events[0]).not.toHaveProperty('reasoningSummary');
  });

  it('projects supplements under their running task without creating chat bubbles', async () => {
    const fixture = buildFixture();
    const runningTask = { ...fixture.task, status: 'planning' as const };
    fixture.dependencies.tasks.listAll.mockResolvedValue([runningTask]);
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([runningTask]);
    const supplementEvents: TaskEvent[] = [
      {
        id: 'event_supplements',
        taskId: runningTask.id,
        runId: fixture.run.id,
        sequence: 1,
        type: 'supplement.queued',
        messageId: 'supplement_1',
        at: 1_150,
      },
      {
        id: 'event_supplements_applied',
        taskId: runningTask.id,
        runId: fixture.run.id,
        sequence: 2,
        type: 'supplement.applied',
        messageId: 'supplement_1',
        at: 1_151,
      },
    ];
    useArchive(fixture, { task: runningTask, events: supplementEvents });
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
    const details = await service.getTaskDetails(runningTask.id);
    expect(details.supplements).toEqual([
      {
        id: 'supplement_1',
        text: 'Use official sources',
        attachmentIds: ['attachment_1'],
        createdAt: 1_100,
        detailIndex: 1,
        applicationState: 'applied',
      },
    ]);
    expect(details.events[0]?.supplementIds).toEqual(['supplement_1']);
    expect(snapshot.attachments).toEqual([
      expect.objectContaining({ id: 'attachment_1', fileName: 'photo.png' }),
    ]);
  });

  it('keeps a newly queued supplement pending until an applied event is recorded', async () => {
    const fixture = buildFixture();
    const runningTask = { ...fixture.task, status: 'planning' as const };
    fixture.dependencies.tasks.listAll.mockResolvedValue([runningTask]);
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([runningTask]);
    useArchive(fixture, {
      task: runningTask,
      events: [
        {
          id: 'event_other_supplement',
          taskId: runningTask.id,
          runId: fixture.run.id,
          sequence: 1,
          type: 'supplement.queued',
          messageId: 'supplement_pending',
          at: 1_200,
        },
      ],
    });
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
    const details = await service.getTaskDetails(runningTask.id);

    expect(snapshot.task?.supplements).toEqual([]);
    expect(details.supplements).toEqual([
      expect.objectContaining({
        id: 'supplement_pending',
        applicationState: 'pending',
      }),
    ]);
  });

  it('projects one continuous detail index across tool results and user supplements', async () => {
    const fixture = buildFixture();
    const first = panelResult(fixture, {
      callId: 'call_1',
      toolName: 'browser_inspect',
      argumentsJson: '{}',
      output: '{"ok":true}',
      resultId: 'result_1',
    });
    const second = panelResult(fixture, {
      callId: 'call_2',
      toolName: 'browser_click',
      argumentsJson: '{"ref":"e2"}',
      output: '{"ok":true}',
      resultId: 'result_2',
    });
    const events: TaskEvent[] = [
      {
        id: 'event_result_1',
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: 1,
        type: 'tool.result',
        callId: first.callId,
        resultId: first.id,
        at: 1_100,
      },
      {
        id: 'event_supplement',
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: 2,
        type: 'supplement.queued',
        messageId: 'supplement_1',
        at: 1_200,
      },
      {
        id: 'event_result_2',
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: 3,
        type: 'tool.result',
        callId: second.callId,
        resultId: second.id,
        at: 1_300,
      },
    ];
    useArchive(fixture, {
      task: { ...fixture.task, lastEventSequence: 3 },
      events,
      toolResults: [first, second],
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
    expect(details.toolResults.map(({ callId, detailIndex }) => [callId, detailIndex])).toEqual([
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
    expect(fixture.dependencies.agent.supplement).toHaveBeenCalledWith({
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
      ordinal: 2,
      goal: 'Run tests',
      latestRunId: 'run_2',
      lastEventSequence: 23,
      createdAt: 1_200,
      updatedAt: 1_300,
    };
    const secondRun: TaskRun = {
      ...fixture.run,
      id: 'run_2',
      taskId: secondTask.id,
      startedAt: 1_200,
      endedAt: 1_300,
    };
    const longArguments = `{"cmd":"${'a'.repeat(20_100)}"}`;
    const longOutput = 'o'.repeat(100_100);
    const toolResults: MaterializedToolResult[] = Array.from({ length: 22 }, (_, index) => ({
      id: `result_${index}`,
      taskId: secondTask.id,
      runId: secondRun.id,
      callId: `call_${index}`,
      toolName: index === 21 ? 'bash' : 'lookup',
      argumentsJson: index === 21 ? longArguments : '{}',
      output: index === 21 ? longOutput : `output_${index}`,
      resultId: `result_${index}`,
      attachmentIds: index === 21 ? ['attachment_tool'] : [],
      createdAt: 1_200 + index,
    }));
    const secondEvents: TaskEvent[] = [
      ...toolResults.map((result, index): TaskEvent => ({
        id: `event_tool_${index}`,
        taskId: secondTask.id,
        runId: secondRun.id,
        sequence: index + 1,
        type: 'tool.result',
        callId: result.callId,
        resultId: result.id,
        at: 1_200 + index,
      })),
      {
        id: `event_${secondTask.id}`,
        taskId: secondTask.id,
        runId: secondRun.id,
        sequence: 23,
        type: 'status.changed',
        taskStatus: 'completed',
        runStatus: 'completed',
        reason: 'done',
        at: 1_300,
        error: null,
      },
    ];
    const secondArchive: PersistedTaskArchive = {
      task: secondTask,
      runs: [secondRun],
      events: secondEvents,
      toolResults,
    };
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
    fixture.dependencies.tasks.listAll.mockResolvedValue([fixture.task, secondTask]);
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([fixture.task, secondTask]);
    fixture.dependencies.tasks.readTaskArchives.mockImplementation(async (taskIds) =>
      [fixture.archive, secondArchive].filter(({ task }) => taskIds.includes(task.id)),
    );
    fixture.dependencies.tasks.readTaskArchive.mockImplementation(async (taskId) =>
      taskId === secondTask.id
        ? secondArchive
        : taskId === fixture.task.id
          ? fixture.archive
          : undefined,
    );
    fixture.dependencies.tasks.readTaskTimelines.mockImplementation(async (taskIds) =>
      [fixture.archive, secondArchive]
        .filter(({ task }) => taskIds.includes(task.id))
        .map(({ task, runs, events }) => ({ task, runs, events })),
    );
    fixture.dependencies.tasks.readTaskDetailWindow.mockImplementation(async (taskId) =>
      taskId === secondTask.id
        ? secondArchive
        : taskId === fixture.task.id
          ? fixture.archive
          : undefined,
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
    expect(bashTask?.toolResults).toEqual([]);

    const details = await service.getTaskDetails(secondTask.id);

    expect(details.detailLevel).toBe('full');
    expect(details.toolResults).toHaveLength(22);
    expect(details.toolResults[0]?.callId).toBe('call_0');
    expect(details.toolResults.at(-1)).toMatchObject({
      callId: 'call_21',
      toolName: 'bash',
    });
    expect(details.toolResults.at(-1)?.argumentsJson).toHaveLength(20_000);
    expect(details.toolResults.at(-1)?.output).toHaveLength(100_000);
    expect(details.toolResults.at(-1)?.attachmentIds).toEqual(['attachment_tool']);
    expect(fixture.dependencies.tasks.readTaskDetailWindow).toHaveBeenCalledWith(
      secondTask.id,
      100,
    );
  });

  it('defers orphan tool-result validation until task details are requested', async () => {
    const fixture = buildFixture();
    const events: TaskEvent[] = [
      ...Array.from({ length: 441 }, (_, index): TaskEvent => ({
        id: `event_${index + 1}`,
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: index + 1,
        type: 'reasoning.summary',
        summary: 'progress',
        at: 1_000 + index,
      })),
      {
        id: 'event_442',
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: 442,
        type: 'status.changed',
        taskStatus: 'completed',
        runStatus: 'completed',
        reason: 'done',
        at: 1_442,
        error: null,
      },
    ];
    const result = panelResult(fixture, {
      callId: 'call_without_event',
      toolName: 'browser_inspect',
      argumentsJson: '{}',
      output: 'old output',
      resultId: 'result_without_event',
    });
    useArchive(fixture, {
      task: { ...fixture.task, lastEventSequence: 442 },
      events,
      toolResults: [result],
    });
    const service = new PanelService(fixture.dependencies);

    await expect(service.getSnapshot(7)).resolves.toMatchObject({
      task: { completedToolCallCount: 0, toolResults: [] },
    });
    await expect(service.getTaskDetails(fixture.task.id)).rejects.toThrow(
      'A permanent tool result is missing its TaskEvent association.',
    );
  });

  it('returns the latest 100 tool results even when audit events surround every call', async () => {
    const fixture = buildFixture();
    const toolResults: MaterializedToolResult[] = Array.from({ length: 120 }, (_, index) => ({
      id: `result_${index + 1}`,
      taskId: fixture.task.id,
      runId: fixture.run.id,
      callId: `call_${index + 1}`,
      toolName: 'browser_inspect',
      argumentsJson: '{}',
      output: `output_${index + 1}`,
      resultId: `result_${index + 1}`,
      attachmentIds: [],
      createdAt: 1_000 + index * 4 + 3,
    }));
    const events: TaskEvent[] = toolResults.flatMap((result, index): TaskEvent[] => [
      {
        id: `event_${index + 1}_1`,
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: index * 4 + 1,
        type: 'reasoning.summary',
        summary: 'Inspect the page.',
        at: 1_000 + index * 4,
      },
      {
        id: `event_${index + 1}_2`,
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: index * 4 + 2,
        type: 'tool.call',
        callId: result.callId,
        name: result.toolName,
        argumentsJson: result.argumentsJson,
        at: 1_000 + index * 4 + 1,
      },
      {
        id: `event_${index + 1}_3`,
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: index * 4 + 3,
        type: 'tool.dispatched',
        callId: result.callId,
        at: 1_000 + index * 4 + 2,
      },
      {
        id: `event_${index + 1}_4`,
        taskId: fixture.task.id,
        runId: fixture.run.id,
        sequence: index * 4 + 4,
        type: 'tool.result',
        callId: result.callId,
        resultId: result.id,
        at: 1_000 + index * 4 + 3,
      },
    ]);
    useArchive(fixture, {
      task: { ...fixture.task, lastEventSequence: 480 },
      events,
      toolResults,
    });
    const service = new PanelService(fixture.dependencies);

    const summary = await service.getSnapshot(7);
    const details = await service.getTaskDetails(fixture.task.id);

    expect(summary.task?.toolResults).toEqual([]);
    expect(summary.task?.completedToolCallCount).toBe(120);
    expect(details.events).toHaveLength(100);
    expect(details.events[0]?.sequence).toBe(84);
    expect(details.events.every(({ type }) => type === 'tool.result-recorded')).toBe(true);
    expect(details.toolResults).toHaveLength(100);
    expect(details.toolResults[0]?.callId).toBe('call_21');
    expect(details.toolResults.at(-1)?.callId).toBe('call_120');
  });

  it('returns persisted credentials only from the explicit settings query', async () => {
    const fixture = buildFixture();
    fixture.dependencies.credentials.getSandboxToken.mockResolvedValue('secret-sandbox-token');
    const service = new PanelService(fixture.dependencies);

    await expect(service.getSettings()).resolves.toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'zh-CN',
      historyMessageLimit: 50,
      sandboxServer: '',
      codexAccessToken: 'secret-token',
      tavilyKey: 'secret-tavily-key',
      sandboxToken: 'secret-sandbox-token',
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

  it('delegates one complete conversation submission through the Agent boundary', async () => {
    const fixture = buildFixture();
    fixture.dependencies.conversations.get.mockResolvedValueOnce(undefined);
    const order: string[] = [];
    fixture.dependencies.agent.start.mockImplementationOnce(async () => {
      order.push('agent.start');
      return {
        task: fixture.task,
        checkpoint: await fixture.dependencies.tasks.getCheckpoint('checkpoint_1'),
        events: [],
      } as never;
    });
    const service = new PanelService(fixture.dependencies);

    await service.submit({ tabId: 7, text: 'Book a room', attachmentIds: [] });

    expect(order).toEqual(['agent.start']);
    expect(fixture.dependencies.agent.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'create',
        submission: expect.objectContaining({
          createConversation: true,
          message: expect.objectContaining({ id: 'message_new' }),
        }),
      }),
    );
  });

  it('rejects a new task when any other global conversation has unfinished work', async () => {
    const fixture = buildFixture();
    fixture.dependencies.agent.start.mockRejectedValueOnce(
      Object.assign(new Error('已有任务运行中'), {
        code: 'TASK_ALREADY_RUNNING',
      }),
    );
    const service = new PanelService(fixture.dependencies);

    await expect(
      service.submit({
        tabId: 7,
        text: 'Start a parallel task',
        attachmentIds: [],
      }),
    ).rejects.toMatchObject({
      code: 'TASK_ALREADY_RUNNING',
      message: '已有任务运行中',
    });
    expect(fixture.dependencies.agent.start).toHaveBeenCalledTimes(1);
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

  it('saves optional Sandbox settings and credentials', async () => {
    const fixture = buildFixture();
    fixture.dependencies.settings.get.mockResolvedValue({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'zh-CN',
      historyMessageLimit: 50,
      sandboxServer: 'https://old-sandbox.example.com',
    });
    fixture.dependencies.credentials.getSandboxToken.mockResolvedValue('stored-sandbox-token');
    const service = new PanelService(fixture.dependencies);

    await service.saveSettings({
      reasoningEffort: 'high',
      systemPrompt: 'Be concise',
      language: 'en',
      historyMessageLimit: 24,
      sandboxServer: 'https://new-sandbox.example.com/root',
      sandboxToken: 'new-sandbox-token',
    });

    expect(fixture.dependencies.settings.save).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxServer: 'https://new-sandbox.example.com/root',
      }),
    );
    expect(fixture.dependencies.credentials.setSandboxToken).toHaveBeenCalledWith(
      'new-sandbox-token',
    );
  });

  it('cancels unfinished work before deleting the complete conversation aggregate', async () => {
    const fixture = buildFixture();
    const runningTask = { ...fixture.task, status: 'planning' as const };
    fixture.dependencies.tasks.listByConversation.mockResolvedValue([runningTask]);
    const order: string[] = [];
    fixture.dependencies.agent.cancel.mockImplementation(async () => {
      order.push('cancel');
      return {
        task: { ...runningTask, status: 'cancelled' },
        checkpoint: {
          ...(await fixture.dependencies.tasks.getCheckpoint('checkpoint_1')),
        },
        events: [],
      } as never;
    });
    fixture.dependencies.conversations.clearConversation.mockImplementation(async () => {
      order.push('clear');
    });
    const service = new PanelService(fixture.dependencies);

    await service.clearConversation(fixture.conversation.id);

    expect(fixture.dependencies.agent.cancel).toHaveBeenCalledWith(runningTask.id);
    expect(order).toEqual(['cancel', 'clear']);
  });
});
