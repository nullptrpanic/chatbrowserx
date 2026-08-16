import type { Checkpoint } from '../tasks/checkpoint-types';
import type { TaskRun } from '../tasks/task-types';

export interface AgentPlanInput {
  readonly task: TaskRun;
  readonly checkpoint: Checkpoint;
}

export type AgentEvent = { readonly type: 'task.completed'; readonly reason: string };

export interface AgentPlanner {
  plan(input: AgentPlanInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
