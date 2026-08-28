import type { ConversationId } from '../shared/ids';
import type { IdGenerator } from '../shared/ids';
import type { Clock } from '../shared/time';
import type { Task, TaskRun } from './task-types';

export interface CreateTaskInput {
  readonly conversationId: ConversationId;
  readonly tabId: number;
  readonly goal: string;
  readonly ordinal?: number;
}

export interface TaskFactoryDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface InitialTaskRecords {
  readonly task: Task;
  readonly run: TaskRun;
}

/** Creates one logical task and its first execution attempt. */
export function createTaskRecords(
  input: CreateTaskInput,
  dependencies: TaskFactoryDependencies,
): InitialTaskRecords {
  const task = createTask(input, dependencies);
  const runId = createId(dependencies.ids, 'taskRun');
  return {
    task: { ...task, latestRunId: runId },
    run: {
      id: runId,
      taskId: task.id,
      attempt: 1,
      status: 'queued',
      checkpointId: null,
      lease: null,
      error: null,
      startedAt: task.createdAt,
      endedAt: null,
    },
  };
}

/** Creates the stable logical task record independently from execution attempts. */
export function createTask(input: CreateTaskInput, dependencies: TaskFactoryDependencies): Task {
  const conversationId = input.conversationId.trim();
  const goal = input.goal.trim();
  const ordinal = input.ordinal ?? 1;

  if (conversationId.length === 0) throw new Error('Conversation ID is required.');
  if (!Number.isInteger(input.tabId) || input.tabId < 0) {
    throw new Error('Tab ID must be a non-negative integer.');
  }
  if (goal.length === 0 || goal.length > 20_000) {
    throw new Error('Task goal must contain between 1 and 20,000 characters.');
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error('Task ordinal must be a positive integer.');
  }

  const now = dependencies.clock.now();
  return {
    id: createId(dependencies.ids, 'task'),
    conversationId,
    ordinal,
    tabId: input.tabId,
    goal,
    status: 'queued',
    latestRunId: null,
    lastEventSequence: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Creates a fresh attempt for resume, retry, or cancelled-task continuation. */
export function createTaskRun(
  task: Task,
  attempt: number,
  dependencies: TaskFactoryDependencies,
): TaskRun {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('Task run attempt must be a positive integer.');
  }
  return {
    id: createId(dependencies.ids, 'taskRun'),
    taskId: task.id,
    attempt,
    status: 'queued',
    checkpointId: null,
    lease: null,
    error: null,
    startedAt: dependencies.clock.now(),
    endedAt: null,
  };
}

function createId(ids: IdGenerator, prefix: string): string {
  const id = ids.create(prefix).trim();
  if (id.length === 0) throw new Error(`${prefix} ID generator returned an empty identifier.`);
  return id;
}
