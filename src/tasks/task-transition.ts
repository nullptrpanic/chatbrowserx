import type { TaskError } from './task-errors';
import type { Task, TaskRun, TaskStatus } from './task-types';

export type TaskTransitionType =
  | 'planning.started'
  | 'planning.retrying'
  | 'reasoning.summary-recorded'
  | 'tool.call-recorded'
  | 'tool.execution-started'
  | 'tool.result-recorded'
  | 'task.supplements-applied'
  | 'task.context-compacted'
  | 'task.context-cleared'
  | 'task.auth-required'
  | 'task.paused'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled';

export interface TaskTransition {
  readonly type: TaskTransitionType;
  readonly at: number;
  readonly reason: string;
  readonly error?: TaskError;
}

const targetStatus: Readonly<Record<TaskTransitionType, TaskStatus>> = {
  'planning.started': 'planning',
  'planning.retrying': 'planning',
  'reasoning.summary-recorded': 'planning',
  'tool.call-recorded': 'planning',
  'tool.execution-started': 'planning',
  'tool.result-recorded': 'planning',
  'task.supplements-applied': 'planning',
  'task.context-compacted': 'planning',
  'task.context-cleared': 'cancelled',
  'task.auth-required': 'waiting_for_auth',
  'task.paused': 'paused',
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.cancelled': 'cancelled',
};

const waitingEvents = new Set<TaskTransitionType>([
  'task.auth-required',
  'task.paused',
  'task.failed',
  'task.cancelled',
]);
const allowed: Readonly<Record<TaskStatus, ReadonlySet<TaskTransitionType>>> = {
  queued: new Set(['planning.started', ...waitingEvents]),
  planning: new Set([
    'planning.retrying',
    'reasoning.summary-recorded',
    'tool.call-recorded',
    'tool.execution-started',
    'tool.result-recorded',
    'task.supplements-applied',
    'task.context-compacted',
    'task.completed',
    ...waitingEvents,
  ]),
  waiting_for_auth: new Set(['task.cancelled']),
  paused: new Set(['task.cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(['task.context-cleared']),
};

export interface TransitionedTaskRecords {
  readonly task: Task;
  readonly run: TaskRun;
}

/** Applies one in-attempt state transition to the logical task and current run together. */
export function transitionTask(
  task: Task,
  run: TaskRun,
  transition: TaskTransition,
): TransitionedTaskRecords {
  if (task.latestRunId !== run.id || run.taskId !== task.id) {
    throw new Error('Task transition does not target the latest run.');
  }
  if (!allowed[run.status].has(transition.type)) {
    throw new Error(`Illegal task transition from ${run.status} with ${transition.type}.`);
  }
  if (transition.at < task.updatedAt || transition.at < run.startedAt) {
    throw new Error('Task transition timestamp cannot move backwards.');
  }
  if (transition.reason.trim().length === 0) {
    throw new Error('Task transition reason is required.');
  }
  if (transition.type === 'task.failed' && transition.error === undefined) {
    throw new Error('Failed task transitions require a normalized error.');
  }

  const status = targetStatus[transition.type];
  const attemptEnded = status !== 'queued' && status !== 'planning';
  return {
    task: { ...task, status, updatedAt: transition.at },
    run: {
      ...run,
      status,
      error: transition.error ?? null,
      lease: attemptEnded ? null : run.lease,
      endedAt: attemptEnded ? (run.endedAt ?? transition.at) : null,
    },
  };
}
