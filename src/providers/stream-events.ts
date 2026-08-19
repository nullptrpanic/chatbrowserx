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
