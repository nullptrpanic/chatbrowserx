import type { Checkpoint } from '../tasks/checkpoint-types';
import type { Task, TaskEvent } from '../tasks/task-types';
import type { MaterializedToolResult } from '../tasks/tool-result-types';
import type { ModelUsage } from './model/model-stream-event';
import type { ModelOutputContinuationItem } from '../tasks/continuation-types';
import type { ContinuationItem } from '../tasks/continuation-types';
import type { ValidatedToolCall } from '../tools/types';

export interface AgentPlanInput {
  readonly task: Task;
  readonly events: readonly TaskEvent[];
  readonly checkpoint: Checkpoint;
  readonly toolResults: readonly MaterializedToolResult[];
}

/** Safe numeric metadata for one completed model response. */
export interface AgentModelTurn {
  readonly inputItemCount: number;
  readonly elapsedMs: number;
  readonly firstEventMs: number;
  readonly firstTextMs?: number;
  readonly usage: ModelUsage | null;
}

interface AgentOutcomeMetadata {
  readonly modelTurn?: AgentModelTurn;
  readonly modelOutputItems?: readonly ModelOutputContinuationItem[];
}

export type AgentEvent =
  | { readonly type: 'reasoning.summary'; readonly text: string }
  | {
      readonly type: 'context.compacted';
      readonly continuationItems: readonly ContinuationItem[];
    }
  | (AgentOutcomeMetadata & {
      readonly type: 'tool.call';
      readonly call: ValidatedToolCall;
    })
  | (AgentOutcomeMetadata & {
      readonly type: 'task.completed';
      readonly reason: string;
      readonly messageId: string;
    });

export interface AgentPlanner {
  plan(input: AgentPlanInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
