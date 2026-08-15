import type { ModelInputItem, ModelMessageContent, ModelRequest } from '../provider-types';
import { CODEX_MODEL, CODEX_RESPONSES_URL } from './codex-constants';

export interface BuildCodexRequestInput {
  readonly accessToken: string;
  readonly accountId: string;
  readonly request: ModelRequest;
}

export interface CodexHttpRequest {
  readonly url: typeof CODEX_RESPONSES_URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Maps one normalized content part to the fixed Responses API representation. */
function mapContentPart(content: ModelMessageContent): Readonly<Record<string, unknown>> {
  switch (content.type) {
    case 'input_text':
    case 'output_text':
      return { type: content.type, text: content.text };
    case 'input_image':
      return {
        type: 'input_image',
        image_url: content.imageUrl,
        detail: content.detail,
      };
  }
}

/** Maps one provider-neutral input item to a Responses API input item. */
function mapInputItem(item: ModelInputItem): Readonly<Record<string, unknown>> {
  switch (item.type) {
    case 'message':
      return {
        type: 'message',
        role: item.role,
        content: item.content.map(mapContentPart),
      };
    case 'function_call':
      return {
        type: 'function_call',
        call_id: item.callId,
        name: item.name,
        arguments: item.argumentsJson,
      };
    case 'function_call_output':
      return {
        type: 'function_call_output',
        call_id: item.callId,
        output: item.output,
      };
  }
}

/** Builds the only supported Codex URL, headers, and request body. */
export function buildCodexRequest(input: BuildCodexRequestInput): CodexHttpRequest {
  return {
    url: CODEX_RESPONSES_URL,
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      'ChatGPT-Account-ID': input.accountId,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: {
      model: CODEX_MODEL,
      instructions: input.request.systemPrompt,
      input: input.request.input.map(mapInputItem),
      tools: input.request.tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
      reasoning: { effort: input.request.reasoningEffort, summary: 'auto' },
    },
  };
}
