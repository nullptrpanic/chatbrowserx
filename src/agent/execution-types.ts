import type { BrowserActionRequest } from '../browser/contracts/action';
import type { BrowserActionEvidence } from '../browser/contracts/evidence';
import type { PageObservation } from '../browser/contracts/observation';
import type {
  VerificationRequest,
  VerificationResult,
} from '../browser/verify/verification-engine';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type { TaskRun } from '../tasks/task-types';
import type {
  TavilyCrawlToolInput,
  TavilyExtractToolInput,
  TavilySearchToolInput,
} from './tools/tavily-tool-schema';
import type {
  TavilyCrawlInput,
  TavilyExtractInput,
  TavilyResultSet,
  TavilySearchInput,
} from '../providers/tavily/tavily-types';

export interface AgentPlanInput {
  readonly task: TaskRun;
  readonly checkpoint: Checkpoint;
  readonly observation: PageObservation;
  readonly visualImageUrl?: string | null;
}

export type AgentEvent =
  | {
      readonly type: 'browser.action';
      readonly action: BrowserActionRequest;
      readonly callId?: string;
      readonly argumentsJson?: string;
    }
  | {
      readonly type: 'tavily.call';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly operation: 'search';
      readonly arguments: TavilySearchToolInput;
    }
  | {
      readonly type: 'tavily.call';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly operation: 'extract';
      readonly arguments: TavilyExtractToolInput;
    }
  | {
      readonly type: 'tavily.call';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly operation: 'crawl';
      readonly arguments: TavilyCrawlToolInput;
    }
  | { readonly type: 'task.completed'; readonly reason: string };

export interface AgentPlanner {
  plan(input: AgentPlanInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export interface BrowserExecutionPort {
  observe(input: { readonly tabId: number; readonly ownerId: string }): Promise<PageObservation>;
  execute(input: {
    readonly ownerId: string;
    readonly outcomeId: string;
    readonly action: BrowserActionRequest;
  }): Promise<BrowserActionEvidence>;
  verify(input: VerificationRequest): Promise<VerificationResult>;
  recordVerification(input: {
    readonly outcomeId: string;
    readonly evidence: BrowserActionEvidence;
    readonly verification: VerificationResult;
  }): Promise<void>;
  release(tabId: number, ownerId: string): Promise<void>;
}

export interface TavilyExecutionPort {
  search(input: TavilySearchInput, signal: AbortSignal): Promise<TavilyResultSet>;
  extract(input: TavilyExtractInput, signal: AbortSignal): Promise<TavilyResultSet>;
  crawl(input: TavilyCrawlInput, signal: AbortSignal): Promise<TavilyResultSet>;
}
