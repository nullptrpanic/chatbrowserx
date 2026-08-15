import { describe, expect, it } from 'vitest';
import { CODEX_MODEL, CODEX_RESPONSES_URL } from '../../../src/providers/codex/codex-constants';
import { buildCodexRequest } from '../../../src/providers/codex/codex-request';
import type { ModelRequest } from '../../../src/providers/provider-types';

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
      name: 'browser.act',
      argumentsJson: '{"type":"click"}',
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
      name: 'browser.act',
      description: 'Executes one bounded browser action.',
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
          name: 'browser.act',
          arguments: '{"type":"click"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"verified":true}',
        },
      ],
      tools: MODEL_REQUEST.tools,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
      reasoning: { effort: 'medium', summary: 'auto' },
    });
  });
});
