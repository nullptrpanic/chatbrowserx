import type { ModelToolChoice, ModelToolDefinition } from '../../tools/model-tool';
import type { ModelStreamEvent } from './model-stream-event';

export type { ModelToolChoice, ModelToolDefinition } from '../../tools/model-tool';

export type ModelReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type ModelMessageContent =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'output_text'; readonly text: string }
  | {
      readonly type: 'input_image';
      readonly imageUrl: string;
      readonly detail: 'auto' | 'low' | 'high' | 'original';
    };

export type ModelFunctionOutput =
  string | readonly Extract<ModelMessageContent, { readonly type: 'input_text' | 'input_image' }>[];

export type ModelInputItem =
  | {
      readonly type: 'message';
      readonly role: 'user' | 'assistant';
      readonly content: readonly ModelMessageContent[];
    }
  | {
      readonly type: 'reasoning';
      readonly itemId: string;
      readonly encryptedContent: string;
      readonly summary: readonly {
        readonly type: 'summary_text';
        readonly text: string;
      }[];
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
      readonly output: ModelFunctionOutput;
    }
  | {
      readonly type: 'compaction';
      readonly itemId: string;
      readonly encryptedContent: string;
    };

export interface ModelRequest {
  readonly model: string;
  readonly reasoningEffort: ModelReasoningEffort;
  readonly systemPrompt: string;
  readonly input: readonly ModelInputItem[];
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: ModelToolChoice;
}

export interface ModelProviderPort {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}
