import type { Checkpoint } from '../tasks/checkpoint-types';
import type { TaskRun } from '../tasks/task-types';
import type {
  TavilyCrawlToolInput,
  TavilyExtractToolInput,
  TavilySearchToolInput,
} from './tools/tavily-tool-schema';
import type { ParsedBrowserToolCall } from './tools/browser-tool-schema';
import type { ParsedContextCommitToolCall } from './tools/context-commit-tool-schema';
import type { ModelUsage } from '../providers/stream-events';
import type { ModelOutputContinuationItem } from '../tasks/continuation-types';
import type { ContinuationItem } from '../tasks/continuation-types';

export interface AgentPlanInput {
  readonly task: TaskRun;
  readonly checkpoint: Checkpoint;
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
      readonly type: 'browser.call';
      readonly call: ParsedBrowserToolCall;
    })
  | (AgentOutcomeMetadata & {
      readonly type: 'context.commit';
      readonly call: ParsedContextCommitToolCall;
    })
  | (AgentOutcomeMetadata & {
      readonly type: 'tavily.call';
      readonly operation: 'search';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilySearchToolInput;
    })
  | (AgentOutcomeMetadata & {
      readonly type: 'tavily.call';
      readonly operation: 'extract';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilyExtractToolInput;
    })
  | (AgentOutcomeMetadata & {
      readonly type: 'tavily.call';
      readonly operation: 'crawl';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilyCrawlToolInput;
    })
  | (AgentOutcomeMetadata & {
      readonly type: 'task.completed';
      readonly reason: string;
      readonly messageId: string;
    });

export interface AgentPlanner {
  plan(input: AgentPlanInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
