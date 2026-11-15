import type { AgentOutputItem } from '@openai/agents-core';

/** Provider-normalized progress consumed by the task runtime as the stream arrives. */
export type ModelActivity =
  | { readonly type: 'reasoning_summary_delta'; readonly key: string; readonly delta: string }
  | { readonly type: 'reasoning_summary_done'; readonly key: string; readonly text: string }
  | { readonly type: 'assistant_final_answer'; readonly itemId: string; readonly text?: string }
  | {
      readonly type: 'assistant_commentary';
      readonly itemId: string;
      readonly index: number;
      readonly text: string;
    }
  | {
      readonly type: 'hosted_tool_done';
      readonly index: number;
      readonly item: Extract<AgentOutputItem, { type: 'hosted_tool_call' }>;
    };

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly reasoningOutputTokens?: number;
}

export type ModelStreamEvent =
  | { readonly type: 'response.started'; readonly responseId: string }
  | {
      readonly type: 'reasoning.encrypted';
      readonly itemId: string;
      readonly encryptedContent: string;
      readonly summary: readonly {
        readonly type: 'summary_text';
        readonly text: string;
      }[];
    }
  | {
      readonly type: 'reasoning.summary';
      readonly itemId: string;
      readonly summaryIndex: number;
      readonly text: string;
    }
  | { readonly type: 'text.delta'; readonly delta: string }
  | {
      readonly type: 'tool.started';
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: 'tool.arguments.delta';
      readonly callId: string;
      readonly delta: string;
    }
  | {
      readonly type: 'tool.completed';
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | {
      readonly type: 'response.completed';
      readonly responseId: string;
      readonly usage: ModelUsage | null;
    };
