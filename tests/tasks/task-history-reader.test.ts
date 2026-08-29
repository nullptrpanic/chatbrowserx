import { describe, expect, it, vi } from 'vitest';
import { TaskHistoryReader } from '../../src/tasks/task-history-reader';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { Task, TaskEvent } from '../../src/tasks/task-types';
import type { MaterializedToolResult } from '../../src/tasks/tool-result-types';

const conversationId = 'conversation_1';
const currentTaskId = 'task_3';

function task(id: string, ordinal: number): Task {
  return {
    id,
    conversationId,
    ordinal,
    tabId: 7,
    goal: `goal ${ordinal}`,
    status: ordinal === 3 ? 'planning' : 'completed',
    latestRunId: `run_${ordinal}`,
    lastEventSequence: 4,
    createdAt: ordinal * 100,
    updatedAt: ordinal * 100 + 50,
  };
}

const messages: MessageRecord[] = [
  {
    id: 'message_2',
    kind: 'conversation',
    conversationId,
    taskId: 'task_2',
    role: 'user',
    status: 'complete',
    text: 'inspect the previous page traffic',
    attachmentIds: [],
    createdAt: 200,
    updatedAt: 200,
  },
  {
    id: 'supplement_2',
    kind: 'supplement',
    conversationId,
    taskId: 'task_2',
    role: 'user',
    status: 'complete',
    text: 'include request bodies',
    attachmentIds: [],
    createdAt: 220,
    updatedAt: 220,
  },
];

const events: TaskEvent[] = [
  {
    id: 'event_1',
    taskId: 'task_2',
    runId: 'run_2',
    sequence: 1,
    at: 200,
    type: 'message.recorded',
    messageId: 'message_2',
  },
  {
    id: 'event_2',
    taskId: 'task_2',
    runId: 'run_2',
    sequence: 2,
    at: 210,
    type: 'tool.call',
    callId: 'call_2',
    name: 'browser_network_get',
    argumentsJson: '{"requestId":"request_2"}',
  },
  {
    id: 'event_3',
    taskId: 'task_2',
    runId: 'run_2',
    sequence: 3,
    at: 220,
    type: 'supplement.queued',
    messageId: 'supplement_2',
  },
  {
    id: 'event_4',
    taskId: 'task_2',
    runId: 'run_2',
    sequence: 4,
    at: 230,
    type: 'tool.result',
    callId: 'call_2',
    resultId: 'result_2',
  },
];

const results: MaterializedToolResult[] = [
  {
    id: 'result_2',
    taskId: 'task_2',
    runId: 'run_2',
    callId: 'call_2',
    toolName: 'browser_network_get',
    argumentsJson: '{"requestId":"request_2"}',
    output: '0123456789',
    attachmentIds: [],
    createdAt: 230,
  },
];

function reader(
  input: {
    readonly tasks?: readonly Task[];
    readonly archiveTask?: Task;
    readonly archiveEvents?: readonly TaskEvent[];
    readonly archiveResults?: readonly MaterializedToolResult[];
    readonly messages?: readonly MessageRecord[];
    readonly extraResults?: readonly MaterializedToolResult[];
    readonly getToolResult?: (resultId: string) => Promise<MaterializedToolResult | undefined>;
  } = {},
) {
  const archiveTask = input.archiveTask ?? task('task_2', 2);
  const allTasks = input.tasks ?? [task('task_1', 1), archiveTask, task('task_3', 3)];
  const archiveResults = input.archiveResults ?? results;
  const readableResults = [...archiveResults, ...(input.extraResults ?? [])];
  return new TaskHistoryReader({
    tasks: {
      listByConversation: async () => [...allTasks],
      listEvents: async (taskId) =>
        taskId === archiveTask.id ? [...(input.archiveEvents ?? events)] : [],
      getToolResult:
        input.getToolResult ??
        (async (resultId) => readableResults.find(({ id }) => id === resultId)),
      get: async (taskId) => allTasks.find(({ id }) => id === taskId),
    },
    conversations: {
      listTaskMessages: async (taskId) =>
        (input.messages ?? messages).filter((message) => message.taskId === taskId),
    },
  });
}

describe('TaskHistoryReader', () => {
  it('reads the previous logical task in stable event order with cursor counts', async () => {
    const first = await reader().readHistory(
      { conversationId, currentTaskId },
      { offset: 1, cursor: '', limit: 2 },
    );
    expect(first).toMatchObject({
      ok: true,
      task: { id: 'task_2', ordinal: 2 },
      returnedCount: 2,
      consumedCount: 2,
      totalCount: 4,
      remainingCount: 2,
      hasMore: true,
      items: [
        {
          sequence: 1,
          type: 'message',
          text: 'inspect the previous page traffic',
        },
        { sequence: 2, type: 'tool_call', name: 'browser_network_get' },
      ],
    });
    if (!first.ok || first.nextCursor === null) throw new Error('Expected another page.');

    const second = await reader().readHistory(
      { conversationId, currentTaskId },
      { offset: 1, cursor: first.nextCursor, limit: 2 },
    );
    expect(second).toMatchObject({
      ok: true,
      returnedCount: 2,
      consumedCount: 4,
      totalCount: 4,
      remainingCount: 0,
      nextCursor: null,
      hasMore: false,
      items: [
        { sequence: 3, type: 'supplement', text: 'include request bodies' },
        {
          sequence: 4,
          type: 'tool_result',
          resultId: 'result_2',
          preview: '0123456789',
        },
      ],
    });
  });

  it('projects chained reply references with stable task and message identifiers', async () => {
    const previous = { ...task('task_2', 2), lastEventSequence: 1 };
    const replyMessage: MessageRecord = {
      id: 'message_reply_chain',
      kind: 'conversation',
      conversationId,
      taskId: previous.id,
      role: 'user',
      status: 'complete',
      text: 'Follow up on the older answer',
      attachmentIds: [],
      replyTo: {
        messageId: 'assistant_task_1',
        taskId: 'task_1',
        excerpt: 'Older answer',
        attachmentCount: 0,
        createdAt: 100,
      },
      createdAt: 200,
      updatedAt: 200,
    };

    await expect(
      reader({
        tasks: [task('task_1', 1), previous, task('task_3', 3)],
        archiveTask: previous,
        archiveEvents: [
          {
            id: 'event_reply_chain',
            taskId: previous.id,
            runId: 'run_2',
            sequence: 1,
            at: 200,
            type: 'message.recorded',
            messageId: replyMessage.id,
          },
        ],
        archiveResults: [],
        messages: [replyMessage],
      }).readHistory({ conversationId, currentTaskId }, { offset: 1, cursor: '', limit: 20 }),
    ).resolves.toMatchObject({
      ok: true,
      items: [
        {
          type: 'message',
          messageId: replyMessage.id,
          replyTo: { messageId: 'assistant_task_1', taskId: 'task_1' },
        },
      ],
    });
  });

  it('reads an exact historical task by its stable task identifier', async () => {
    const history = reader();

    const first = await history.readTaskHistory(
      { conversationId, currentTaskId },
      { taskId: 'task_2', cursor: '', limit: 2 },
    );
    expect(first).toMatchObject({
      ok: true,
      task: { id: 'task_2', ordinal: 2 },
      returnedCount: 2,
      hasMore: true,
    });
    if (!first.ok || first.nextCursor === null) throw new Error('Expected another page.');

    await expect(
      history.readTaskHistory(
        { conversationId, currentTaskId },
        { taskId: 'task_2', cursor: first.nextCursor, limit: 2 },
      ),
    ).resolves.toMatchObject({
      ok: true,
      task: { id: 'task_2' },
      returnedCount: 2,
      hasMore: false,
    });
  });

  it('does not expose a current, non-terminal, or foreign task through an absolute read', async () => {
    const foreignTask = { ...task('task_foreign', 1), conversationId: 'conversation_foreign' };
    const pendingTask = { ...task('task_pending', 2), status: 'planning' as const };
    const history = reader({
      tasks: [task('task_1', 1), pendingTask, task('task_3', 3), foreignTask],
    });

    await expect(
      history.readTaskHistory(
        { conversationId, currentTaskId },
        { taskId: currentTaskId, cursor: '', limit: 20 },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'HISTORY_NOT_FOUND' });
    await expect(
      history.readTaskHistory(
        { conversationId, currentTaskId },
        { taskId: pendingTask.id, cursor: '', limit: 20 },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'HISTORY_NOT_FOUND' });
    await expect(
      history.readTaskHistory(
        { conversationId, currentTaskId },
        { taskId: foreignTask.id, cursor: '', limit: 20 },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'HISTORY_NOT_FOUND' });
  });

  it('loads tool-result bodies only for the current history page', async () => {
    const getToolResult = vi.fn(async (resultId: string) =>
      results.find(({ id }) => id === resultId),
    );
    const history = reader({ getToolResult });

    const first = await history.readHistory(
      { conversationId, currentTaskId },
      { offset: 1, cursor: '', limit: 2 },
    );
    expect(first).toMatchObject({ ok: true, returnedCount: 2, hasMore: true });
    expect(getToolResult).not.toHaveBeenCalled();
    if (!first.ok || first.nextCursor === null) throw new Error('Expected another page.');

    await history.readHistory(
      { conversationId, currentTaskId },
      { offset: 1, cursor: first.nextCursor, limit: 2 },
    );
    expect(getToolResult).toHaveBeenCalledOnce();
    expect(getToolResult).toHaveBeenCalledWith('result_2');
  });

  it('rejects a cursor used with a different offset', async () => {
    const first = await reader().readHistory(
      { conversationId, currentTaskId },
      { offset: 1, cursor: '', limit: 1 },
    );
    if (!first.ok || first.nextCursor === null) throw new Error('Expected another page.');
    await expect(
      reader().readHistory(
        { conversationId, currentTaskId },
        { offset: 2, cursor: first.nextCursor, limit: 1 },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_CURSOR',
      retryable: false,
    });
  });

  it('reads exact result ranges and rejects cross-conversation ownership', async () => {
    await expect(
      reader().readResult(
        { conversationId, currentTaskId },
        { resultId: 'result_2', offset: 3, limit: 4 },
      ),
    ).resolves.toEqual({
      ok: true,
      resultId: 'result_2',
      taskId: 'task_2',
      toolName: 'browser_network_get',
      content: '3456',
      offset: 3,
      returnedCount: 4,
      consumedCount: 7,
      totalCount: 10,
      remainingCount: 3,
      nextOffset: 7,
      hasMore: true,
    });
  });

  it('reports an empty complete page when a task has no model-visible events', async () => {
    const previous = { ...task('task_2', 2), lastEventSequence: 2 };
    const hiddenEvents: TaskEvent[] = [
      {
        id: 'hidden_turn',
        taskId: previous.id,
        runId: 'run_2',
        sequence: 1,
        at: 200,
        type: 'model.turn',
        metrics: { inputItemCount: 1, elapsedMs: 5, firstEventMs: 1 },
      },
      {
        id: 'hidden_dispatch',
        taskId: previous.id,
        runId: 'run_2',
        sequence: 2,
        at: 201,
        type: 'tool.dispatched',
        callId: 'call_hidden',
      },
    ];

    await expect(
      reader({
        archiveTask: previous,
        archiveEvents: hiddenEvents,
        archiveResults: [],
        messages: [],
      }).readHistory({ conversationId, currentTaskId }, { offset: 1, cursor: '', limit: 50 }),
    ).resolves.toMatchObject({
      ok: true,
      items: [],
      returnedCount: 0,
      consumedCount: 0,
      totalCount: 0,
      remainingCount: 0,
      nextCursor: null,
      hasMore: false,
    });
  });

  it('paginates 125 visible events with exact total and remaining counts', async () => {
    const previous = { ...task('task_2', 2), lastEventSequence: 125 };
    const summaries: TaskEvent[] = Array.from({ length: 125 }, (_, index) => ({
      id: `summary_${String(index + 1)}`,
      taskId: previous.id,
      runId: 'run_2',
      sequence: index + 1,
      at: 200 + index,
      type: 'reasoning.summary' as const,
      summary: `summary ${String(index + 1)}`,
    }));
    const history = reader({
      archiveTask: previous,
      archiveEvents: summaries,
      archiveResults: [],
      messages: [],
    });
    const first = await history.readHistory(
      { conversationId, currentTaskId },
      { offset: 1, cursor: '', limit: 100 },
    );
    expect(first).toMatchObject({
      ok: true,
      returnedCount: 100,
      consumedCount: 100,
      totalCount: 125,
      remainingCount: 25,
      hasMore: true,
    });
    if (!first.ok || first.nextCursor === null) throw new Error('Expected another page.');
    await expect(
      history.readHistory(
        { conversationId, currentTaskId },
        { offset: 1, cursor: first.nextCursor, limit: 100 },
      ),
    ).resolves.toMatchObject({
      ok: true,
      returnedCount: 25,
      consumedCount: 125,
      totalCount: 125,
      remainingCount: 0,
      nextCursor: null,
      hasMore: false,
    });
  });

  it('excludes the active task and skips unfinished earlier tasks from offsets', async () => {
    const unfinished = { ...task('task_2', 2), status: 'paused' as const };
    const older = { ...task('task_1', 1), lastEventSequence: 0 };
    await expect(
      reader({
        tasks: [older, unfinished, task('task_3', 3)],
        archiveTask: older,
        archiveEvents: [],
        archiveResults: [],
        messages: [],
      }).readHistory({ conversationId, currentTaskId }, { offset: 1, cursor: '', limit: 50 }),
    ).resolves.toMatchObject({ ok: true, task: { id: older.id, ordinal: 1 } });
  });

  it('rejects tool results owned by another conversation or the active task', async () => {
    const baseResult = results[0];
    if (baseResult === undefined) throw new Error('Result fixture is incomplete.');
    const foreignTask: Task = {
      ...task('task_foreign', 4),
      conversationId: 'conversation_foreign',
    };
    const foreignResult: MaterializedToolResult = {
      ...baseResult,
      id: 'result_foreign',
      taskId: foreignTask.id,
    };
    const activeResult: MaterializedToolResult = {
      ...baseResult,
      id: 'result_active',
      taskId: currentTaskId,
      runId: 'run_3',
    };
    const history = reader({
      tasks: [task('task_1', 1), task('task_2', 2), task('task_3', 3), foreignTask],
      extraResults: [foreignResult, activeResult],
    });

    await expect(
      history.readResult(
        { conversationId, currentTaskId },
        { resultId: foreignResult.id, offset: 0, limit: 10 },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'RESULT_NOT_FOUND' });
    await expect(
      history.readResult(
        { conversationId, currentTaskId },
        { resultId: activeResult.id, offset: 0, limit: 10 },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'RESULT_NOT_FOUND' });
  });

  it('rejects permanent messages that have no event association', async () => {
    const baseMessage = messages[0];
    if (baseMessage === undefined) throw new Error('Message fixture is incomplete.');
    const orphan: MessageRecord = {
      ...baseMessage,
      id: 'message_orphan',
      text: 'not referenced by an event',
    };
    await expect(
      reader({ messages: [...messages, orphan] }).readHistory(
        { conversationId, currentTaskId },
        { offset: 1, cursor: '', limit: 50 },
      ),
    ).rejects.toThrow('Task history record association is invalid.');
  });
});
