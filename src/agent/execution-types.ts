import type { Checkpoint } from '../tasks/checkpoint-types';
import type { TaskRun } from '../tasks/task-types';
import type {
  TavilyCrawlToolInput,
  TavilyExtractToolInput,
  TavilySearchToolInput,
} from './tools/tavily-tool-schema';
import type { ParsedBrowserToolCall } from './tools/browser-tool-schema';

export interface AgentPlanInput {
  readonly task: TaskRun;
  readonly checkpoint: Checkpoint;
}

export type AgentEvent =
  | { readonly type: 'reasoning.summary'; readonly text: string }
  | { readonly type: 'browser.call'; readonly call: ParsedBrowserToolCall }
  | {
      readonly type: 'tavily.call';
      readonly operation: 'search';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilySearchToolInput;
    }
  | {
      readonly type: 'tavily.call';
      readonly operation: 'extract';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilyExtractToolInput;
    }
  | {
      readonly type: 'tavily.call';
      readonly operation: 'crawl';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilyCrawlToolInput;
    }
  | {
      readonly type: 'task.completed';
      readonly reason: string;
      readonly messageId: string;
    };

export interface AgentPlanner {
  plan(input: AgentPlanInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
