import { describe, expect, it } from 'vitest';
import { CODEX_MODEL, CODEX_RESPONSES_URL } from '../../../src/providers/codex/codex-constants';
import { buildCodexRequest } from '../../../src/providers/codex/codex-request';
import type { ModelRequest } from '../../../src/providers/provider-types';

const GENERIC_TOOL_NAMES = ['lookup', 'lookup_record', 'lookup-record'] as const;

const MODEL_REQUEST: ModelRequest = {
  model: 'caller-supplied-model-is-ignored',
  reasoningEffort: 'medium',
  systemPrompt: 'Use only approved tools.',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Open the result.' },
        { type: 'input_image', imageUrl: 'data:image/png;base64,AAAA', detail: 'high' },
      ],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'I will inspect it.' }],
    },
    {
      type: 'function_call',
      callId: 'call_1',
      name: 'lookup_record',
      argumentsJson: '{"id":"record_1"}',
    },
    {
      type: 'function_call_output',
      callId: 'call_1',
      output: '{"verified":true}',
    },
  ],
  tools: [
    {
      type: 'function',
      name: 'lookup_record',
      description: 'Looks up one record.',
      parameters: {
        type: 'object',
        properties: { type: { type: 'string' } },
        required: ['type'],
        additionalProperties: false,
      },
      strict: true,
    },
  ],
};

describe('buildCodexRequest', () => {
  it('omits the tool contract entirely when no tools are registered', () => {
    const request = buildCodexRequest({
      accessToken: 'synthetic-token-value',
      accountId: 'acct_123',
      request: {
        ...MODEL_REQUEST,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Hello.' }],
          },
        ],
        tools: [],
      },
    });

    expect(request.body).not.toHaveProperty('tools');
    expect(request.body).not.toHaveProperty('tool_choice');
    expect(request.body).not.toHaveProperty('parallel_tool_calls');
    expect(JSON.stringify(request.body).length).toBeLessThan(1_024);
  });

  it('builds the single fixed Codex HTTP contract and maps normalized input', () => {
    const request = buildCodexRequest({
      accessToken: 'synthetic-token-value',
      accountId: 'acct_123',
      request: MODEL_REQUEST,
    });

    expect(request.url).toBe(CODEX_RESPONSES_URL);
    expect(request.headers).toEqual({
      Authorization: 'Bearer synthetic-token-value',
      'ChatGPT-Account-ID': 'acct_123',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    });
    expect(request.headers).not.toHaveProperty('OpenAI-Beta');
    expect(request.body).toEqual({
      model: CODEX_MODEL,
      instructions: 'Use only approved tools.',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Open the result.' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
          ],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect it.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup_record',
          arguments: '{"id":"record_1"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"verified":true}',
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'lookup_record',
          description: 'Looks up one record.',
          parameters: {
            type: 'object',
            properties: { type: { type: 'string' } },
            required: ['type'],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
    });
  });

  it('preserves generic tool names that satisfy the provider wire grammar', () => {
    const definitions = GENERIC_TOOL_NAMES.map((name) => ({
      type: 'function' as const,
      name,
      description: `${name} description`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      strict: true as const,
    }));
    const request = buildCodexRequest({
      accessToken: 'synthetic-token-value',
      accountId: 'acct_123',
      request: {
        ...MODEL_REQUEST,
        tools: definitions,
        input: GENERIC_TOOL_NAMES.map((name, index) => ({
          type: 'function_call' as const,
          callId: `call_${String(index)}`,
          name,
          argumentsJson: '{}',
        })),
      },
    });
    const body = request.body as {
      readonly tools: readonly { readonly name: string }[];
      readonly input: readonly { readonly name: string }[];
    };

    expect(body.tools.map((tool) => tool.name)).toEqual(GENERIC_TOOL_NAMES);
    expect(body.input.map((item) => item.name)).toEqual(GENERIC_TOOL_NAMES);
    expect(body.tools.every((tool) => /^[a-zA-Z0-9_-]+$/.test(tool.name))).toBe(true);
  });
});
