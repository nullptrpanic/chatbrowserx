import type { ModelStreamEvent } from './stream-events';

export type ModelReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ModelMessageContent =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'output_text'; readonly text: string }
  | {
      readonly type: 'input_image';
      readonly imageUrl: string;
      readonly detail: 'auto' | 'low' | 'high';
    };

export type ModelInputItem =
  | {
      readonly type: 'message';
      readonly role: 'user' | 'assistant';
      readonly content: readonly ModelMessageContent[];
    }
  | {
      readonly type: 'function_call';
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    }
  | {
      readonly type: 'function_call_output';
      readonly callId: string;
      readonly output: string;
    };

export interface ModelToolDefinition {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export interface ModelRequest {
  readonly model: string;
  readonly reasoningEffort: ModelReasoningEffort;
  readonly systemPrompt: string;
  readonly input: readonly ModelInputItem[];
  readonly tools: readonly ModelToolDefinition[];
}

export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
