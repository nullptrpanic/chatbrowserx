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
  readonly modelTurn?: TaskModelTurnMetrics | undefined;
  /** Exact supplements consumed at this Agent Loop boundary. */
  readonly supplementIds?: readonly string[] | undefined;
}

/** Numeric-only model telemetry attached to its durable task boundary. */
export interface TaskModelTurnMetrics {
  readonly inputItemCount: number;
  readonly elapsedMs: number;
  readonly firstEventMs: number;
  readonly firstTextMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningOutputTokens?: number;
}
