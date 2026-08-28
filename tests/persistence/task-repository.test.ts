import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import {
  IndexedDbTaskRepository,
  TaskRepositoryBusyError,
} from '../../src/persistence/task-repository';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import type { Conversation } from '../../src/tasks/conversation-types';
import type { MessageRecord } from '../../src/tasks/message-types';
import type { Task, TaskEvent, TaskRun } from '../../src/tasks/task-types';
import type { ToolResult } from '../../src/tasks/tool-result-types';
import { createTestDatabaseName } from './test-helpers';

interface SubmissionFixture {
  readonly conversation: Conversation;
  readonly message: MessageRecord;
  readonly task: Task;
  readonly run: TaskRun;
  readonly events: readonly TaskEvent[];
  readonly checkpoint: Checkpoint;
}

function submissionFixture(
  suffix: string,
  input: {
    readonly conversationId?: string;
    readonly ordinal?: number;
    readonly createdAt?: number;
  } = {},
): SubmissionFixture {
  const conversationId = input.conversationId ?? `conversation_${suffix}`;
  const createdAt = input.createdAt ?? 100;
  const taskId = `task_${suffix}`;
  const runId = `run_${suffix}_1`;
  const messageId = `message_${suffix}`;
  const checkpointId = `checkpoint_${suffix}_1`;
  return {
    conversation: {
      id: conversationId,
      tabId: 7,
      title: `Conversation ${suffix}`,
      createdAt,
      updatedAt: createdAt,
    },
    message: {
      id: messageId,
      kind: 'conversation',
      conversationId,
      taskId,
      role: 'user',
      status: 'complete',
      text: `Goal ${suffix}`,
      attachmentIds: [],
      createdAt,
      updatedAt: createdAt,
    },
    task: {
      id: taskId,
      conversationId,
      ordinal: input.ordinal ?? 99,
      tabId: 7,
      goal: `Goal ${suffix}`,
      status: 'queued',
      latestRunId: runId,
      lastEventSequence: 2,
      createdAt,
      updatedAt: createdAt,
    },
    run: {
      id: runId,
      taskId,
      attempt: 1,
      status: 'queued',
      checkpointId,
      lease: null,
      error: null,
      startedAt: createdAt,
      endedAt: null,
    },
    events: [
      {
        id: `event_${suffix}_1`,
        taskId,
        runId,
        sequence: 1,
        at: createdAt,
        type: 'message.recorded',
        messageId,
      },
      {
        id: `event_${suffix}_2`,
        taskId,
        runId,
        sequence: 2,
        at: createdAt,
        type: 'status.changed',
        taskStatus: 'queued',
        runStatus: 'queued',
        reason: 'task.queued',
        error: null,
      },
    ],
    checkpoint: {
      id: checkpointId,
      taskId,
      runId,
      continuationItems: [{ type: 'message_ref', messageId }],
      pendingToolCall: null,
      browserToolCallsInAttempt: 0,
      browserTargetTabId: 7,
      createdAt,
    },
  };
}

function createSubmission(
  repository: IndexedDbTaskRepository,
  fixture: SubmissionFixture,
  createConversation = true,
): Promise<Task> {
  return repository.createSubmission({ ...fixture, createConversation });
}

async function completeTask(
  repository: IndexedDbTaskRepository,
  fixture: SubmissionFixture,
  persistedTask: Task,
  at = fixture.task.createdAt + 10,
): Promise<void> {
  const event: TaskEvent = {
    id: `event_${fixture.task.id}_completed`,
    taskId: persistedTask.id,
    runId: fixture.run.id,
    sequence: persistedTask.lastEventSequence + 1,
    at,
    type: 'status.changed',
    taskStatus: 'completed',
    runStatus: 'completed',
    reason: 'model_response_completed',
    error: null,
  };
  await repository.saveTransition({
    task: {
      ...persistedTask,
      status: 'completed',
      lastEventSequence: event.sequence,
      updatedAt: at,
    },
    run: {
      ...fixture.run,
      status: 'completed',
      checkpointId: null,
      endedAt: at,
    },
    events: [event],
    checkpoint: fixture.checkpoint,
    deleteCheckpoint: true,
  });
}

describe('IndexedDbTaskRepository', () => {
  it('allocates the task ordinal in the submission transaction', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('task-ordinal'));
    const repository = new IndexedDbTaskRepository(database);
    const first = submissionFixture('first', {
      conversationId: 'conversation_shared',
      ordinal: 42,
    });
    const storedFirst = await createSubmission(repository, first);
    expect(storedFirst.ordinal).toBe(1);
    await completeTask(repository, first, storedFirst);

    const second = submissionFixture('second', {
      conversationId: first.conversation.id,
      ordinal: 1,
      createdAt: 200,
    });
    const storedSecond = await createSubmission(repository, second, false);
    expect(storedSecond.ordinal).toBe(2);
    expect(
      (await repository.listByConversation(first.conversation.id)).map(({ ordinal }) => ordinal),
    ).toEqual([1, 2]);
    database.close();
  });

  it('rejects another unfinished task in the same global transaction boundary', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('single-running-task'));
    const repository = new IndexedDbTaskRepository(database);
    await createSubmission(repository, submissionFixture('active'));
    await expect(createSubmission(repository, submissionFixture('blocked'))).rejects.toBeInstanceOf(
      TaskRepositoryBusyError,
    );
    expect(await repository.listAll()).toHaveLength(1);
    database.close();
  });

  it('rejects resuming a terminal task while another task is unfinished', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('single-running-resume'));
    const repository = new IndexedDbTaskRepository(database);
    const resumable = submissionFixture('resumable');
    const storedResumable = await createSubmission(repository, resumable);
    const cancelledAt = 120;
    const cancelEvent: TaskEvent = {
      id: 'event_resumable_cancelled',
      taskId: storedResumable.id,
      runId: resumable.run.id,
      sequence: 3,
      at: cancelledAt,
      type: 'status.changed',
      taskStatus: 'cancelled',
      runStatus: 'cancelled',
      reason: 'user_cancel',
      error: null,
    };
    const cancelledTask: Task = {
      ...storedResumable,
      status: 'cancelled',
      lastEventSequence: 3,
      updatedAt: cancelledAt,
    };
    await repository.saveTransition({
      task: cancelledTask,
      run: {
        ...resumable.run,
        status: 'cancelled',
        endedAt: cancelledAt,
      },
      events: [cancelEvent],
      checkpoint: resumable.checkpoint,
    });
    await createSubmission(repository, submissionFixture('other-active'));

    const resumedAt = 200;
    const nextRun: TaskRun = {
      id: 'run_resumable_2',
      taskId: cancelledTask.id,
      attempt: 2,
      status: 'queued',
      checkpointId: 'checkpoint_resumable_2',
      lease: null,
      error: null,
      startedAt: resumedAt,
      endedAt: null,
    };
    const nextTask: Task = {
      ...cancelledTask,
      status: 'queued',
      latestRunId: nextRun.id,
      lastEventSequence: 4,
      updatedAt: resumedAt,
    };
    const nextEvent: TaskEvent = {
      id: 'event_resumable_queued',
      taskId: cancelledTask.id,
      runId: nextRun.id,
      sequence: 4,
      at: resumedAt,
      type: 'status.changed',
      taskStatus: 'queued',
      runStatus: 'queued',
      reason: 'user_resume',
      error: null,
    };
    const nextCheckpoint: Checkpoint = {
      ...resumable.checkpoint,
      id: 'checkpoint_resumable_2',
      runId: nextRun.id,
      createdAt: resumedAt,
    };

    await expect(
      repository.startRun(nextTask, nextRun, nextEvent, nextCheckpoint),
    ).rejects.toBeInstanceOf(TaskRepositoryBusyError);
    expect(await repository.get(cancelledTask.id)).toEqual(cancelledTask);
    database.close();
  });

  it('moves resumable state to the new run and removes the previous checkpoint', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('checkpoint-transfer'));
    const repository = new IndexedDbTaskRepository(database);
    const initial = submissionFixture('resume');
    const stored = await createSubmission(repository, initial);
    const cancelEvent: TaskEvent = {
      id: 'event_resume_cancelled',
      taskId: stored.id,
      runId: initial.run.id,
      sequence: 3,
      at: 120,
      type: 'status.changed',
      taskStatus: 'cancelled',
      runStatus: 'cancelled',
      reason: 'user_cancel',
      error: null,
    };
    const cancelledTask: Task = {
      ...stored,
      status: 'cancelled',
      lastEventSequence: 3,
      updatedAt: 120,
    };
    const cancelledRun: TaskRun = {
      ...initial.run,
      status: 'cancelled',
      endedAt: 120,
    };
    await repository.saveTransition({
      task: cancelledTask,
      run: cancelledRun,
      events: [cancelEvent],
      checkpoint: initial.checkpoint,
    });

    const continuedMessage: MessageRecord = {
      ...initial.message,
      id: 'message_resume_2',
      text: 'Continue with one more detail',
      createdAt: 130,
      updatedAt: 130,
    };
    const nextRun: TaskRun = {
      id: 'run_resume_2',
      taskId: stored.id,
      attempt: 2,
      status: 'queued',
      checkpointId: 'checkpoint_resume_2',
      lease: null,
      error: null,
      startedAt: 130,
      endedAt: null,
    };
    const nextTask: Task = {
      ...cancelledTask,
      status: 'queued',
      latestRunId: nextRun.id,
      lastEventSequence: 5,
      updatedAt: 130,
    };
    const nextEvents: TaskEvent[] = [
      {
        id: 'event_resume_4',
        taskId: stored.id,
        runId: nextRun.id,
        sequence: 4,
        at: 130,
        type: 'message.recorded',
        messageId: continuedMessage.id,
      },
      {
        id: 'event_resume_5',
        taskId: stored.id,
        runId: nextRun.id,
        sequence: 5,
        at: 130,
        type: 'status.changed',
        taskStatus: 'queued',
        runStatus: 'queued',
        reason: 'task.queued',
        error: null,
      },
    ];
    const nextCheckpoint: Checkpoint = {
      ...initial.checkpoint,
      id: 'checkpoint_resume_2',
      runId: nextRun.id,
      continuationItems: [
        ...initial.checkpoint.continuationItems,
        { type: 'message_ref', messageId: continuedMessage.id },
      ],
      createdAt: 130,
    };
    await repository.createSubmission({
      conversation: initial.conversation,
      createConversation: false,
      message: continuedMessage,
      task: nextTask,
      run: nextRun,
      events: nextEvents,
      checkpoint: nextCheckpoint,
      continuationSourceTaskId: stored.id,
    });

    expect(await repository.getCheckpoint(initial.checkpoint.id)).toBeUndefined();
    expect(await repository.getRun(initial.run.id)).toMatchObject({
      checkpointId: null,
    });
    expect(await repository.readActiveRuntimeSnapshot(stored.id)).toMatchObject({
      task: { latestRunId: nextRun.id, lastEventSequence: 5 },
      run: { id: nextRun.id, attempt: 2 },
      checkpoint: { id: nextCheckpoint.id },
    });
    database.close();
  });

  it('commits a tool result, event, and attachment reference atomically', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('tool-result-atomic'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('tool');
    const stored = await createSubmission(repository, fixture);
    await database.add('attachments', {
      id: 'attachment_tool',
      blob: new Blob(['image'], { type: 'image/png' }),
      mimeType: 'image/png',
      byteSize: 5,
      width: 1,
      height: 1,
      source: 'viewport_capture',
      createdAt: 105,
    });
    const callEvent: TaskEvent = {
      id: 'event_tool_call',
      taskId: stored.id,
      runId: fixture.run.id,
      sequence: 3,
      at: 110,
      type: 'tool.call',
      callId: 'call_tool',
      name: 'browser_capture_screenshot',
      argumentsJson: '{}',
    };
    const planningTask: Task = {
      ...stored,
      status: 'planning',
      lastEventSequence: 3,
      updatedAt: 110,
    };
    const planningRun: TaskRun = { ...fixture.run, status: 'planning' };
    const pendingCheckpoint: Checkpoint = {
      ...fixture.checkpoint,
      pendingToolCall: {
        callId: 'call_tool',
        name: 'browser_capture_screenshot',
        argumentsJson: '{}',
        executionState: 'recorded',
      },
    };
    await repository.saveTransition({
      task: planningTask,
      run: planningRun,
      events: [callEvent],
      checkpoint: pendingCheckpoint,
    });

    const result: ToolResult = {
      id: 'result_tool',
      taskId: stored.id,
      runId: fixture.run.id,
      callId: 'call_tool',
      toolName: 'browser_capture_screenshot',
      output: '{"ok":true}',
      attachmentIds: ['attachment_tool'],
      createdAt: 120,
    };
    const resultEvent: TaskEvent = {
      id: 'event_tool_result',
      taskId: stored.id,
      runId: fixture.run.id,
      sequence: 4,
      at: 120,
      type: 'tool.result',
      callId: result.callId,
      resultId: result.id,
    };
    await repository.saveTransition({
      task: { ...planningTask, lastEventSequence: 4, updatedAt: 120 },
      run: planningRun,
      events: [resultEvent],
      checkpoint: {
        ...pendingCheckpoint,
        continuationItems: [
          ...pendingCheckpoint.continuationItems,
          {
            type: 'function_call_output_ref',
            callId: result.callId,
            resultId: result.id,
            attachmentIds: result.attachmentIds,
          },
        ],
        pendingToolCall: null,
      },
      toolResults: [result],
    });

    expect(await repository.listToolResults(stored.id)).toEqual([result]);
    expect(await database.get('attachment-references', ['attachment_tool', result.id])).toEqual({
      attachmentId: 'attachment_tool',
      referenceId: result.id,
    });
    expect((await repository.readActiveRuntimeSnapshot(stored.id))?.toolResults).toMatchObject([
      {
        id: result.id,
        callId: result.callId,
        argumentsJson: '{}',
        output: result.output,
      },
    ]);
    database.close();
  });

  it('reads only events newer than the executor snapshot without loading tool results', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('runtime-delta'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('runtime_delta');
    const stored = await createSubmission(repository, fixture);
    const event: TaskEvent = {
      id: 'event_runtime_delta_3',
      taskId: stored.id,
      runId: fixture.run.id,
      sequence: 3,
      at: 110,
      type: 'status.changed',
      taskStatus: 'planning',
      runStatus: 'planning',
      reason: 'model_request_started',
      error: null,
    };
    await repository.saveTransition({
      task: {
        ...stored,
        status: 'planning',
        lastEventSequence: 3,
        updatedAt: 110,
      },
      run: { ...fixture.run, status: 'planning' },
      events: [event],
      checkpoint: fixture.checkpoint,
    });

    await expect(repository.readActiveRuntimeDelta(stored.id, 2)).resolves.toEqual({
      task: expect.objectContaining({ id: stored.id, lastEventSequence: 3 }),
      run: expect.objectContaining({ id: fixture.run.id, status: 'planning' }),
      checkpoint: fixture.checkpoint,
      events: [event],
    });
    database.close();
  });

  it('reads only message events for bounded conversation history ordering', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('message-events'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('message_events');
    const stored = await createSubmission(repository, fixture);

    await expect(repository.readTaskMessageEvents([stored.id])).resolves.toEqual([
      fixture.events[0],
    ]);
    database.close();
  });

  it('resolves a pending tool call in a later run of the same task', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('cross-run-tool-result'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('cross_run_tool');
    const stored = await createSubmission(repository, fixture);
    const callEvent: TaskEvent = {
      id: 'event_cross_run_tool_call',
      taskId: stored.id,
      runId: fixture.run.id,
      sequence: 3,
      at: 110,
      type: 'tool.call',
      callId: 'call_cross_run_tool',
      name: 'browser_click',
      argumentsJson: '{"ref":"node_1"}',
    };
    const pendingToolCall = {
      callId: callEvent.callId,
      name: callEvent.name,
      argumentsJson: callEvent.argumentsJson,
      executionState: 'recorded' as const,
    };
    await repository.saveTransition({
      task: {
        ...stored,
        status: 'planning',
        lastEventSequence: 3,
        updatedAt: 110,
      },
      run: { ...fixture.run, status: 'planning' },
      events: [callEvent],
      checkpoint: { ...fixture.checkpoint, pendingToolCall },
    });

    const pauseEvent: TaskEvent = {
      id: 'event_cross_run_tool_paused',
      taskId: stored.id,
      runId: fixture.run.id,
      sequence: 4,
      at: 115,
      type: 'status.changed',
      taskStatus: 'paused',
      runStatus: 'paused',
      reason: 'user_pause',
      error: null,
    };
    await repository.saveTransition({
      task: {
        ...stored,
        status: 'paused',
        lastEventSequence: 4,
        updatedAt: 115,
      },
      run: { ...fixture.run, status: 'paused', endedAt: 115 },
      events: [pauseEvent],
      checkpoint: { ...fixture.checkpoint, pendingToolCall },
    });

    const nextRun: TaskRun = {
      id: 'run_cross_run_tool_2',
      taskId: stored.id,
      attempt: 2,
      status: 'queued',
      checkpointId: 'checkpoint_cross_run_tool_2',
      lease: null,
      error: null,
      startedAt: 120,
      endedAt: null,
    };
    const queuedEvent: TaskEvent = {
      id: 'event_cross_run_tool_queued',
      taskId: stored.id,
      runId: nextRun.id,
      sequence: 5,
      at: 120,
      type: 'status.changed',
      taskStatus: 'queued',
      runStatus: 'queued',
      reason: 'user_resume',
      error: null,
    };
    const nextCheckpoint: Checkpoint = {
      ...fixture.checkpoint,
      id: 'checkpoint_cross_run_tool_2',
      runId: nextRun.id,
      pendingToolCall,
      createdAt: 120,
    };
    const queuedTask: Task = {
      ...stored,
      status: 'queued',
      latestRunId: nextRun.id,
      lastEventSequence: 5,
      updatedAt: 120,
    };
    await repository.startRun(queuedTask, nextRun, queuedEvent, nextCheckpoint);

    const planningEvent: TaskEvent = {
      id: 'event_cross_run_tool_planning',
      taskId: stored.id,
      runId: nextRun.id,
      sequence: 6,
      at: 125,
      type: 'status.changed',
      taskStatus: 'planning',
      runStatus: 'planning',
      reason: 'runner_started',
      error: null,
    };
    const planningTask: Task = {
      ...queuedTask,
      status: 'planning',
      lastEventSequence: 6,
      updatedAt: 125,
    };
    const planningRun: TaskRun = { ...nextRun, status: 'planning' };
    await repository.saveTransition({
      task: planningTask,
      run: planningRun,
      events: [planningEvent],
      checkpoint: nextCheckpoint,
    });

    const result: ToolResult = {
      id: 'result_cross_run_tool',
      taskId: stored.id,
      runId: nextRun.id,
      callId: callEvent.callId,
      toolName: callEvent.name,
      output: '{"ok":true}',
      attachmentIds: [],
      createdAt: 130,
    };
    const resultEvent: TaskEvent = {
      id: 'event_cross_run_tool_result',
      taskId: stored.id,
      runId: nextRun.id,
      sequence: 7,
      at: 130,
      type: 'tool.result',
      callId: result.callId,
      resultId: result.id,
    };
    await repository.saveTransition({
      task: { ...planningTask, lastEventSequence: 7, updatedAt: 130 },
      run: planningRun,
      events: [resultEvent],
      checkpoint: {
        ...nextCheckpoint,
        continuationItems: [
          ...nextCheckpoint.continuationItems,
          {
            type: 'function_call_output_ref',
            callId: result.callId,
            resultId: result.id,
            attachmentIds: [],
          },
        ],
        pendingToolCall: null,
      },
      toolResults: [result],
    });

    expect((await repository.readTaskArchive(stored.id))?.toolResults).toMatchObject([
      {
        id: result.id,
        runId: nextRun.id,
        callId: result.callId,
        argumentsJson: callEvent.argumentsJson,
        output: result.output,
      },
    ]);
    database.close();
  });

  it('rolls back an orphan tool result without leaving canonical output', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('orphan-result'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('orphan');
    const stored = await createSubmission(repository, fixture);
    const result: ToolResult = {
      id: 'result_orphan',
      taskId: stored.id,
      runId: fixture.run.id,
      callId: 'missing_call',
      toolName: 'browser_click',
      output: '{}',
      attachmentIds: [],
      createdAt: 110,
    };
    const event: TaskEvent = {
      id: 'event_orphan_result',
      taskId: stored.id,
      runId: fixture.run.id,
      sequence: 3,
      at: 110,
      type: 'tool.result',
      callId: result.callId,
      resultId: result.id,
    };
    await expect(
      repository.saveTransition({
        task: {
          ...stored,
          status: 'planning',
          lastEventSequence: 3,
          updatedAt: 110,
        },
        run: { ...fixture.run, status: 'planning' },
        events: [event],
        checkpoint: fixture.checkpoint,
        toolResults: [result],
      }),
    ).rejects.toThrow('recorded tool call');
    expect(await repository.listToolResults(stored.id)).toEqual([]);
    expect(await repository.listEvents(stored.id)).toHaveLength(2);
    database.close();
  });

  it('reads permanent task timelines without materializing tool-result payloads', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('task-timeline'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('timeline');
    const stored = await createSubmission(repository, fixture);
    await database.add('tool-results', {
      id: 'result_not_needed_by_timeline',
      taskId: stored.id,
      runId: fixture.run.id,
      callId: 'call_not_needed_by_timeline',
      toolName: 'browser_inspect',
      output: 'x'.repeat(120_000),
      attachmentIds: [],
      createdAt: 110,
    });

    await expect(repository.readTaskTimelines([stored.id])).resolves.toEqual([
      {
        task: stored,
        runs: [fixture.run],
        events: fixture.events,
      },
    ]);
    database.close();
  });

  it('materializes result bodies only for the retained task-detail window', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('task-detail-window'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('detail-window');
    const stored = await createSubmission(repository, fixture);
    const events: TaskEvent[] = [
      {
        id: 'event_detail_call_1',
        taskId: stored.id,
        runId: fixture.run.id,
        sequence: 3,
        at: 110,
        type: 'tool.call',
        callId: 'call_detail_1',
        name: 'browser_inspect',
        argumentsJson: '{"mode":"interactive"}',
      },
      {
        id: 'event_detail_result_1',
        taskId: stored.id,
        runId: fixture.run.id,
        sequence: 4,
        at: 120,
        type: 'tool.result',
        callId: 'call_detail_1',
        resultId: 'result_detail_1',
      },
      {
        id: 'event_detail_call_2',
        taskId: stored.id,
        runId: fixture.run.id,
        sequence: 5,
        at: 130,
        type: 'tool.call',
        callId: 'call_detail_2',
        name: 'browser_scroll',
        argumentsJson: '{"deltaY":600}',
      },
      {
        id: 'event_detail_result_2',
        taskId: stored.id,
        runId: fixture.run.id,
        sequence: 6,
        at: 140,
        type: 'tool.result',
        callId: 'call_detail_2',
        resultId: 'result_detail_2',
      },
    ];
    await database.put('tasks', {
      ...stored,
      lastEventSequence: 6,
      updatedAt: 140,
    });
    for (const event of events) await database.add('task-events', event);
    for (const result of [
      {
        id: 'result_detail_1',
        callId: 'call_detail_1',
        toolName: 'browser_inspect',
        output: 'first result body',
        createdAt: 120,
      },
      {
        id: 'result_detail_2',
        callId: 'call_detail_2',
        toolName: 'browser_scroll',
        output: 'second result body',
        createdAt: 140,
      },
    ] satisfies readonly Pick<
      ToolResult,
      'id' | 'callId' | 'toolName' | 'output' | 'createdAt'
    >[]) {
      await database.add('tool-results', {
        ...result,
        taskId: stored.id,
        runId: fixture.run.id,
        attachmentIds: [],
      });
    }

    const window = await repository.readTaskDetailWindow(stored.id, 1);

    expect(window?.events).toHaveLength(6);
    expect(window?.toolResults).toEqual([
      expect.objectContaining({
        id: 'result_detail_2',
        argumentsJson: '{"deltaY":600}',
        output: 'second result body',
      }),
    ]);
    database.close();
  });

  it('rejects an orphaned stored result while materializing permanent history', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('corrupt-result-read'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('corrupt-read');
    const stored = await createSubmission(repository, fixture);
    const callEvent: TaskEvent = {
      id: 'event_corrupt_call',
      taskId: stored.id,
      runId: fixture.run.id,
      sequence: 3,
      at: 110,
      type: 'tool.call',
      callId: 'call_corrupt',
      name: 'browser_inspect',
      argumentsJson: '{}',
    };
    await repository.saveTransition({
      task: {
        ...stored,
        status: 'planning',
        lastEventSequence: 3,
        updatedAt: 110,
      },
      run: { ...fixture.run, status: 'planning' },
      events: [callEvent],
      checkpoint: fixture.checkpoint,
    });
    await database.add('tool-results', {
      id: 'result_without_event',
      taskId: stored.id,
      runId: fixture.run.id,
      callId: callEvent.callId,
      toolName: callEvent.name,
      output: '{}',
      attachmentIds: [],
      createdAt: 120,
    });

    await expect(repository.readTaskArchive(stored.id)).rejects.toThrow(
      'Task tool-result records are inconsistent.',
    );
    database.close();
  });

  it('keeps completed archive facts readable after deleting the runtime checkpoint', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('archive-no-checkpoint'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('archive');
    const stored = await createSubmission(repository, fixture);
    await completeTask(repository, fixture, stored);

    expect((await repository.readActiveRuntimeSnapshot(stored.id))?.checkpoint).toBeUndefined();
    expect(await repository.readTaskArchive(stored.id)).toMatchObject({
      task: { id: stored.id, status: 'completed', lastEventSequence: 3 },
      runs: [{ id: fixture.run.id, status: 'completed', checkpointId: null }],
      events: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }],
    });
    database.close();
  });

  it('completes from supplement events after compaction removes the message reference', async () => {
    const database = await openChatBrowserDatabase(
      createTestDatabaseName('completed-supplement-events'),
    );
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('supplement-events');
    const stored = await createSubmission(repository, fixture);
    const supplement: MessageRecord = {
      id: 'supplement_applied_before_compaction',
      kind: 'supplement',
      conversationId: fixture.conversation.id,
      taskId: stored.id,
      role: 'user',
      status: 'complete',
      text: 'Keep this requirement.',
      attachmentIds: [],
      createdAt: 110,
      updatedAt: 110,
    };
    await repository.appendTaskMessage({
      message: supplement,
      eventId: 'event_supplement_queued',
      at: 110,
    });
    const events: TaskEvent[] = [
      {
        id: 'event_supplement_applied',
        taskId: stored.id,
        runId: fixture.run.id,
        sequence: 4,
        at: 120,
        type: 'supplement.applied',
        messageId: supplement.id,
      },
      {
        id: 'event_completed_after_compaction',
        taskId: stored.id,
        runId: fixture.run.id,
        sequence: 5,
        at: 130,
        type: 'status.changed',
        taskStatus: 'completed',
        runStatus: 'completed',
        reason: 'model_response_completed',
        error: null,
      },
    ];
    await repository.saveTransition({
      task: {
        ...stored,
        status: 'completed',
        lastEventSequence: 5,
        updatedAt: 130,
      },
      run: {
        ...fixture.run,
        status: 'completed',
        checkpointId: null,
        endedAt: 130,
      },
      events,
      checkpoint: {
        ...fixture.checkpoint,
        continuationItems: [
          {
            type: 'compaction',
            itemId: 'compacted_without_supplement_ref',
            encryptedContent: 'opaque',
          },
        ],
      },
      deleteCheckpoint: true,
    });

    expect((await repository.readTaskArchive(stored.id))?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'supplement.applied',
          messageId: supplement.id,
        }),
      ]),
    );
    database.close();
  });

  it('uses latest-run leases as fencing tokens for recovery', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('leases'));
    const repository = new IndexedDbTaskRepository(database);
    const fixture = submissionFixture('lease');
    const stored = await createSubmission(repository, fixture);
    const first = await repository.tryAcquireLease({
      taskId: stored.id,
      ownerId: 'owner_a',
      now: 100,
      durationMs: 50,
    });
    expect(first?.generation).toBe(1);
    await expect(
      repository.tryAcquireLease({
        taskId: stored.id,
        ownerId: 'owner_b',
        now: 120,
        durationMs: 50,
      }),
    ).resolves.toBeNull();
    await repository.releaseLease(stored.id, 'owner_a', first?.generation ?? 0);
    expect(
      await repository.tryAcquireLease({
        taskId: stored.id,
        ownerId: 'owner_b',
        now: 130,
        durationMs: 50,
      }),
    ).toMatchObject({ ownerId: 'owner_b', generation: 1 });
    database.close();
  });
});
