import type { TaskEventType, TaskRun, TaskStatus, TaskTransitionEvent } from './task-types';

const eventTargetStatus: Readonly<Record<TaskEventType, TaskStatus>> = {
  'planning.started': 'planning',
  'reasoning.summary-recorded': 'planning',
  'tool.call-recorded': 'planning',
  'tool.result-recorded': 'planning',
  'task.supplements-applied': 'planning',
  'task.auth-required': 'waiting_for_auth',
  'task.paused': 'paused',
  'task.resumed': 'queued',
  'task.retried': 'queued',
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.cancelled': 'cancelled',
};

const waitingEvents = new Set<TaskEventType>([
  'task.auth-required',
  'task.paused',
  'task.failed',
  'task.cancelled',
]);

const allowedEvents: Readonly<Record<TaskStatus, ReadonlySet<TaskEventType>>> = {
  queued: new Set(['planning.started', ...waitingEvents]),
  planning: new Set([
    'reasoning.summary-recorded',
    'tool.call-recorded',
    'tool.result-recorded',
    'task.supplements-applied',
    'task.completed',
    ...waitingEvents,
  ]),
  waiting_for_auth: new Set(['task.resumed', 'task.failed', 'task.cancelled']),
  paused: new Set(['task.resumed', 'task.failed', 'task.cancelled']),
  completed: new Set(),
  failed: new Set(['task.retried']),
  cancelled: new Set(),
};

/**
 * Applies one legal task event as an immutable status update and rejects stale or skipped states.
 */
export function transitionTask(task: TaskRun, event: TaskTransitionEvent): TaskRun {
  if (!allowedEvents[task.status].has(event.type)) {
    throw new Error(`Illegal task transition from ${task.status} with ${event.type}.`);
  }

  if (event.at < task.updatedAt) {
    throw new Error('Task transition timestamp cannot be earlier than the current task.');
  }

  if (event.reason.trim().length === 0) {
    throw new Error('Task transition reason is required.');
  }

  if (event.type === 'task.failed' && event.error === undefined) {
    throw new Error('Failed task transitions require a normalized error.');
  }

  const lastError =
    event.type === 'task.resumed' || event.type === 'task.retried'
      ? null
      : (event.error ?? task.lastError);

  return {
    ...task,
    status: eventTargetStatus[event.type],
    updatedAt: event.at,
    lastError,
  };
}
