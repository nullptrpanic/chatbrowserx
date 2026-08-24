import type { TaskId } from '../shared/ids';
import type { ContinuationItem, PendingToolCall } from './continuation-types';
import type { TaskStatus } from './task-types';

export interface CompletedToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly argumentsJson: string;
  readonly output: string;
  /** Optional smaller representation replayed to the model instead of the audit output. */
  readonly modelOutput?: string;
  readonly resultRef: string;
  /** Durable Blob references used to reconstruct multimodal tool output on demand. */
  readonly attachmentIds?: readonly string[];
}

export interface Checkpoint {
  readonly id: string;
  readonly taskId: TaskId;
  readonly sequence: number;
  readonly taskStatus: TaskStatus;
  readonly completedToolResults: readonly CompletedToolResult[];
  readonly continuationItems: readonly ContinuationItem[];
  readonly pendingToolCall: PendingToolCall | null;
  /** Input tokens reported by the most recently completed model turn. */
  readonly lastModelInputTokens?: number;
  /** Browser calls charged to the current run attempt; absent only on legacy checkpoints. */
  readonly browserToolCallsInAttempt?: number;
  /** Durable browser target for this task; absent only on checkpoints written before this field. */
  readonly browserTargetTabId?: number | null;
  readonly createdAt: number;
}
