import type { ConversationId, TaskId, WorkSessionId } from '../shared/ids';
import type { TaskError } from './task-errors';

export type TaskStatus =
  'queued' | 'planning' | 'waiting_for_auth' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TaskLease {
  readonly ownerId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly generation: number;
}

export interface TaskRun {
  readonly id: TaskId;
  readonly workSessionId: WorkSessionId;
  readonly conversationId: ConversationId;
  readonly tabId: number | null;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly checkpointId: string | null;
  readonly lease: TaskLease | null;
  readonly lastError: TaskError | null;
}

export type TaskEventType =
  | 'planning.started'
  | 'reasoning.summary-recorded'
  | 'tool.call-recorded'
  | 'tool.result-recorded'
  | 'task.supplements-applied'
  | 'task.auth-required'
  | 'task.paused'
  | 'task.resumed'
  | 'task.retried'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled';

export interface TaskTransitionEvent {
  readonly type: TaskEventType;
  readonly at: number;
  readonly reason: string;
  readonly error?: TaskError;
}

export interface TaskEvent {
  readonly id: string;
  readonly taskId: TaskId;
  readonly sequence: number;
  readonly type: TaskEventType;
  readonly reason: string;
  readonly at: number;
  readonly error: TaskError | null;
  readonly reasoningSummary?: string | undefined;
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
