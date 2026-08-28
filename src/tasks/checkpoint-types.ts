import type { CheckpointId, TaskId, TaskRunId } from '../shared/ids';
import type { ContinuationItem, PendingToolCall } from './continuation-types';

export interface Checkpoint {
  readonly id: CheckpointId;
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
  readonly continuationItems: readonly ContinuationItem[];
  readonly pendingToolCall: PendingToolCall | null;
  /** Input tokens reported by the most recently completed model turn. */
  readonly lastModelInputTokens?: number;
  /** Browser calls charged to the current run attempt. */
  readonly browserToolCallsInAttempt: number;
  readonly browserTargetTabId: number | null;
  readonly createdAt: number;
}
