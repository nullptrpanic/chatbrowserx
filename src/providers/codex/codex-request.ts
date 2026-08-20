import type { ModelInputItem, ModelMessageContent, ModelRequest } from '../provider-types';
import { providerErrorFromCode } from '../provider-errors';
import { CODEX_MODEL, CODEX_RESPONSES_URL } from './codex-constants';
import { toCodexToolName } from './codex-tool-name';

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
    case 'reasoning':
      return {
        type: 'reasoning',
        id: item.itemId,
        encrypted_content: item.encryptedContent,
        summary: item.summary,
      };
    case 'function_call':
      return {
        type: 'function_call',
        call_id: item.callId,
        name: toCodexToolName(item.name),
        arguments: item.argumentsJson,
      };
    case 'function_call_output':
      return {
        type: 'function_call_output',
        call_id: item.callId,
        output: typeof item.output === 'string' ? item.output : item.output.map(mapContentPart),
      };
  }
}

/** Builds the only supported Codex URL, headers, and request body. */
export function buildCodexRequest(input: BuildCodexRequestInput): CodexHttpRequest {
  const requestedToolChoice = input.request.toolChoice ?? 'auto';
  if (input.request.tools.length === 0 && requestedToolChoice !== 'auto') {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }

  const toolContract =
    input.request.tools.length === 0
      ? {}
      : {
          tools: input.request.tools.map((tool) => ({
            ...tool,
            name: toCodexToolName(tool.name),
          })),
          tool_choice:
            requestedToolChoice === 'auto'
              ? requestedToolChoice
              : (() => {
                  if (!input.request.tools.some((tool) => tool.name === requestedToolChoice.name)) {
                    throw providerErrorFromCode('INVALID_RESPONSE');
                  }
                  return {
                    type: requestedToolChoice.type,
                    name: toCodexToolName(requestedToolChoice.name),
                  };
                })(),
          parallel_tool_calls: false,
        };

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
      ...toolContract,
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: input.request.reasoningEffort, summary: 'auto' },
    },
  };
}
