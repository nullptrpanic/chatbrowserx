import type { Checkpoint } from '../tasks/checkpoint-types';
import type { Task, TaskEvent } from '../tasks/task-types';
import type { MaterializedToolResult } from '../tasks/tool-result-types';
import type { ModelUsage } from '../providers/model-events';
import type { ModelOutputContinuationItem } from '../tasks/continuation-types';
import type { ValidatedToolCall } from '../tools/types';
import type { AgentSession } from '../tasks/agent-session-types';
import type { TaskSnapshot } from '../tasks/task-command-service';
import type { AgentOutputItem } from '@openai/agents-core';

export interface AgentPlanInput {
  readonly task: Task;
  readonly events: readonly TaskEvent[];
  readonly checkpoint: Checkpoint;
  readonly toolResults: readonly MaterializedToolResult[];
}

/** Safe numeric metadata for one completed model response. */
export interface AgentModelTurn {
  readonly kind?: 'generation' | 'compaction';
  readonly inputItemCount: number;
  readonly elapsedMs: number;
  readonly firstEventMs: number;
  readonly firstTextMs?: number;
  readonly usage: ModelUsage | null;
}

interface AgentOutcomeMetadata {
  readonly session?: AgentSession;
  readonly modelTurn?: AgentModelTurn;
  readonly modelOutputItems?: readonly ModelOutputContinuationItem[];
}

export type AgentEvent =
  | {
      readonly type: 'tool.hosted';
      readonly item: Extract<AgentOutputItem, { type: 'hosted_tool_call' }>;
      readonly session: AgentSession;
    }
  | {
      readonly type: 'context.compaction';
      readonly phase: 'started' | 'completed' | 'failed';
      readonly session: AgentSession;
      readonly modelTurn?: AgentModelTurn;
    }
  | {
      readonly type: 'session.updated';
      readonly session: AgentSession;
      readonly reason: string;
      readonly modelTurn?: AgentModelTurn;
    }
  | { readonly type: 'reasoning.summary'; readonly text: string }
  | (AgentOutcomeMetadata & {
      readonly type: 'tool.call';
      readonly call: ValidatedToolCall;
    })
  | (AgentOutcomeMetadata & {
      readonly type: 'task.completed';
      readonly reason: string;
      readonly messageId: string;
    });

export interface AgentRunHooks {
  prepare(): Promise<AgentPlanInput>;
  observe(event: AgentEvent): Promise<TaskSnapshot>;
}

/** A framework owns iteration; the host owns durable effects and task lifecycle. */
export interface AgentRuntimePort {
  run(hooks: AgentRunHooks, signal: AbortSignal): Promise<void>;
}
