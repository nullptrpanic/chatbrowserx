import type { ConversationId, TaskId } from '../shared/ids';
import type { TaskError } from './task-errors';

export type TaskStatus =
  | 'queued'
  | 'observing'
  | 'planning'
  | 'acting'
  | 'verifying'
  | 'checkpointed'
  | 'waiting_for_tab'
  | 'waiting_for_auth'
  | 'waiting_for_confirmation'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BrowserActionKind =
  | 'click'
  | 'type'
  | 'clear'
  | 'select'
  | 'check'
  | 'hover'
  | 'pressKey'
  | 'scroll'
  | 'drag'
  | 'waitFor';

export interface TaskBudget {
  readonly browserActionsLimit: number;
  readonly browserActionsUsed: number;
  readonly actionAttemptsLimit: number;
  readonly replansLimit: number;
  readonly replansUsed: number;
  readonly wallClockLimitMs: number;
}

export interface TaskLease {
  readonly ownerId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly generation: number;
}

export interface TaskRun {
  readonly id: TaskId;
  readonly conversationId: ConversationId;
  readonly tabId: number | null;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly checkpointId: string | null;
  readonly lease: TaskLease | null;
  readonly budget: TaskBudget;
  readonly lastError: TaskError | null;
}

export type TaskEventType =
  | 'observation.started'
  | 'planning.started'
  | 'planning.rejected'
  | 'tool.result-recorded'
  | 'action.intent-recorded'
  | 'action.evidence-recorded'
  | 'action.verified'
  | 'action.verification-failed'
  | 'task.tab-missing'
  | 'task.auth-required'
  | 'task.confirmation-required'
  | 'task.paused'
  | 'task.budget-exhausted'
  | 'task.resumed'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled';

export interface TaskTransitionEvent {
  readonly type: TaskEventType;
  readonly at: number;
  readonly reason: string;
  readonly error?: TaskError;
  readonly boundTabId?: number;
}

export interface TaskEvent {
  readonly id: string;
  readonly taskId: TaskId;
  readonly sequence: number;
  readonly type: TaskEventType;
  readonly reason: string;
  readonly at: number;
  readonly error: TaskError | null;
  readonly actionId?: string;
  readonly actionDigest?: string;
  readonly evidenceRef?: string;
  readonly boundTabId?: number;
}

/**
 * Returns whether events use positive, strictly increasing sequence numbers for one task.
 */
export function hasStrictlyIncreasingTaskEventSequence(events: readonly TaskEvent[]): boolean {
  let previousSequence = 0;
  const taskId = events[0]?.taskId;

  for (const event of events) {
    if (
      event.sequence <= previousSequence ||
      !Number.isInteger(event.sequence) ||
      event.taskId !== taskId
    ) {
      return false;
    }

    previousSequence = event.sequence;
  }

  return true;
}
