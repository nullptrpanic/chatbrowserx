import type {
  CheckpointId,
  ConversationId,
  MessageId,
  TaskEventId,
  TaskId,
  TaskRunId,
  ToolResultId,
} from '../shared/ids';
import type { TaskError } from './task-errors';

export type TaskStatus =
  'queued' | 'planning' | 'waiting_for_auth' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface TaskLease {
  readonly ownerId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly generation: number;
}

export interface Task {
  readonly id: TaskId;
  readonly conversationId: ConversationId;
  readonly ordinal: number;
  readonly tabId: number | null;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly latestRunId: TaskRunId | null;
  readonly lastEventSequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type TaskRunStatus = TaskStatus;

export interface TaskRun {
  readonly id: TaskRunId;
  readonly taskId: TaskId;
  readonly attempt: number;
  readonly status: TaskRunStatus;
  readonly checkpointId: CheckpointId | null;
  readonly lease: TaskLease | null;
  readonly error: TaskError | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

interface TaskEventBase {
  readonly id: TaskEventId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly sequence: number;
  readonly at: number;
}

export type TaskEvent =
  | (TaskEventBase & { readonly type: 'message.recorded'; readonly messageId: MessageId })
  | (TaskEventBase & {
      readonly type: 'supplement.queued' | 'supplement.applied';
      readonly messageId: MessageId;
    })
  | (TaskEventBase & { readonly type: 'reasoning.summary'; readonly summary: string })
  | (TaskEventBase & { readonly type: 'model.turn'; readonly metrics: TaskModelTurnMetrics })
  | (TaskEventBase & {
      readonly type: 'tool.call';
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    })
  | (TaskEventBase & {
      readonly type: 'tool.result';
      readonly callId: string;
      readonly resultId: ToolResultId;
    })
  | (TaskEventBase & {
      readonly type: 'tool.dispatched';
      readonly callId: string;
    })
  | (TaskEventBase & {
      readonly type: 'status.changed';
      readonly taskStatus: TaskStatus;
      readonly runStatus: TaskRunStatus;
      readonly reason: string;
      readonly error: TaskError | null;
    })
  | (TaskEventBase & {
      readonly type: 'context.compacted';
      readonly releasedTextCharacters: number;
      readonly releasedImages: number;
    })
  | (TaskEventBase & { readonly type: 'context.cleared' });

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
