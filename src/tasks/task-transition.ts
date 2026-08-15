import type { TaskEventType, TaskRun, TaskStatus, TaskTransitionEvent } from './task-types';

const eventTargetStatus: Readonly<Record<TaskEventType, TaskStatus>> = {
  'observation.started': 'observing',
  'planning.started': 'planning',
  'planning.rejected': 'observing',
  'tool.result-recorded': 'checkpointed',
  'action.intent-recorded': 'acting',
  'action.evidence-recorded': 'verifying',
  'action.verified': 'checkpointed',
  'action.verification-failed': 'observing',
  'task.tab-missing': 'waiting_for_tab',
  'task.auth-required': 'waiting_for_auth',
  'task.confirmation-required': 'waiting_for_confirmation',
  'task.paused': 'paused',
  'task.budget-exhausted': 'paused',
  'task.resumed': 'queued',
  'task.completed': 'completed',
  'task.failed': 'failed',
  'task.cancelled': 'cancelled',
};

const waitingEvents = new Set<TaskEventType>([
  'task.tab-missing',
  'task.auth-required',
  'task.confirmation-required',
  'task.paused',
  'task.budget-exhausted',
  'task.failed',
  'task.cancelled',
]);

const allowedEvents: Readonly<Record<TaskStatus, ReadonlySet<TaskEventType>>> = {
  queued: new Set(['observation.started', 'action.intent-recorded', ...waitingEvents]),
  observing: new Set(['planning.started', ...waitingEvents]),
  planning: new Set([
    'planning.rejected',
    'tool.result-recorded',
    'action.intent-recorded',
    'task.completed',
    ...waitingEvents,
  ]),
  acting: new Set([
    'action.intent-recorded',
    'action.evidence-recorded',
    'action.verified',
    'action.verification-failed',
    ...waitingEvents,
  ]),
  verifying: new Set([
    'action.intent-recorded',
    'action.verified',
    'action.verification-failed',
    'observation.started',
    ...waitingEvents,
  ]),
  checkpointed: new Set([
    'observation.started',
    'planning.started',
    'task.completed',
    ...waitingEvents,
  ]),
  waiting_for_tab: new Set(['task.resumed', 'task.failed', 'task.cancelled']),
  waiting_for_auth: new Set(['task.resumed', 'task.failed', 'task.cancelled']),
  waiting_for_confirmation: new Set(['task.resumed', 'task.failed', 'task.cancelled']),
  paused: new Set(['task.resumed', 'task.failed', 'task.cancelled']),
  completed: new Set(),
  failed: new Set(),
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

  if (
    event.boundTabId !== undefined &&
    event.type !== 'action.verified' &&
    event.type !== 'task.resumed'
  ) {
    throw new Error('Only verification or explicit resume may bind a task tab.');
  }
  if (
    event.boundTabId !== undefined &&
    (!Number.isInteger(event.boundTabId) || event.boundTabId < 0)
  ) {
    throw new Error('Bound task tab must be a non-negative integer.');
  }

  const lastError = event.type === 'task.resumed' ? null : (event.error ?? task.lastError);
  const tabId = event.type === 'task.tab-missing' ? null : (event.boundTabId ?? task.tabId);

  return {
    ...task,
    tabId,
    status: eventTargetStatus[event.type],
    updatedAt: event.at,
    lastError,
  };
}
