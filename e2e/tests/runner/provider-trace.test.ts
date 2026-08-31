import { describe, expect, it } from 'vitest';
import { summarizeResponsesRequestBody } from '../../runner/provider-trace';

describe('live Responses API trace sanitization', () => {
  it('retains only structural request evidence and validates function-call pairing', () => {
    const activeUserText = 'Read the exact private conversation.';
    const tools = [
      {
        type: 'function',
        name: 'browser_inspect',
        description: 'private schema description',
        parameters: {
          type: 'object',
          properties: { mode: { type: 'string', enum: ['interactive'] } },
          required: ['mode'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: 'browser_click',
        description: 'another private schema description',
        parameters: {
          type: 'object',
          properties: { target: { type: 'string' } },
          required: ['target'],
          additionalProperties: false,
        },
      },
    ];
    const summary = summarizeResponsesRequestBody(
      {
        model: 'gpt-5.6-terra',
        instructions: 'private system instructions',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: activeUserText },
              {
                type: 'input_text',
                text: 'Task page metadata (untrusted): {"tabId":0}',
              },
            ],
          },
          {
            type: 'function_call',
            call_id: 'private_call_id',
            name: 'browser_inspect',
            arguments: '{"private":"arguments"}',
          },
          {
            type: 'function_call_output',
            call_id: 'private_call_id',
            output: '{"private":"tool output"}',
          },
          {
            type: 'reasoning',
            id: 'private_reasoning_id',
            encrypted_content: 'private-encrypted-reasoning',
            summary: [],
          },
        ],
        tools,
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
      },
      activeUserText,
    );

    expect(summary).toMatchObject({
      bodyValid: true,
      model: 'gpt-5.6-terra',
      store: false,
      stream: true,
      parallelToolCalls: false,
      includesEncryptedReasoning: true,
      activeUserRequestOccurrences: 1,
      functionCallCount: 1,
      functionOutputCount: 1,
      orphanFunctionOutputCount: 0,
      unpairedFunctionCallCount: 0,
      duplicateFunctionCallIds: false,
      encryptedReasoningInputCount: 1,
      toolDefinitionCharacters: tools.reduce(
        (total, tool) => total + JSON.stringify(tool).length,
        0,
      ),
      toolDefinitionFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/u),
    });
    expect(summary.inputItems).toEqual([
      {
        position: 0,
        type: 'message',
        role: 'user',
        contentTypes: ['input_text', 'input_text'],
        textCharacters:
          activeUserText.length + 'Task page metadata (untrusted): {"tabId":0}'.length,
        matchesActiveUserRequest: true,
      },
      {
        position: 1,
        type: 'function_call',
        toolName: 'browser_inspect',
        argumentCharacters: 23,
      },
      {
        position: 2,
        type: 'function_call_output',
        outputCharacters: 25,
      },
      { position: 3, type: 'reasoning', encryptedContentCharacters: 27 },
    ]);
    expect(JSON.stringify(summary)).not.toContain('private');
    expect(JSON.stringify(summary)).not.toContain(activeUserText);
  });

  it('fingerprints the complete ordered tool contract without retaining its contents', () => {
    const first = summarizeResponsesRequestBody(
      {
        input: [],
        tools: [{ type: 'function', name: 'browser_inspect', description: 'first' }],
      },
      'request',
    );
    const same = summarizeResponsesRequestBody(
      {
        input: [],
        tools: [{ type: 'function', name: 'browser_inspect', description: 'first' }],
      },
      'request',
    );
    const changed = summarizeResponsesRequestBody(
      {
        input: [],
        tools: [{ type: 'function', name: 'browser_inspect', description: 'second' }],
      },
      'request',
    );

    expect(first.toolDefinitionFingerprint).toBe(same.toolDefinitionFingerprint);
    expect(changed.toolDefinitionFingerprint).not.toBe(first.toolDefinitionFingerprint);
    expect(first.toolDefinitionFingerprint).not.toContain('first');
  });

  it('counts duplicate active request items even when they share one message', () => {
    const activeUserText = 'Do not send this twice.';
    const summary = summarizeResponsesRequestBody(
      {
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: activeUserText },
              { type: 'input_text', text: activeUserText },
            ],
          },
        ],
      },
      activeUserText,
    );

    expect(summary.activeUserRequestOccurrences).toBe(2);
  });

  it('reports duplicated calls and orphaned outputs without retaining call IDs', () => {
    const summary = summarizeResponsesRequestBody(
      {
        input: [
          {
            type: 'function_call',
            call_id: 'same-secret-id',
            name: 'browser_click',
            arguments: '{}',
          },
          {
            type: 'function_call',
            call_id: 'same-secret-id',
            name: 'browser_click',
            arguments: '{}',
          },
          {
            type: 'function_call_output',
            call_id: 'orphan-secret-id',
            output: '{}',
          },
        ],
      },
      'unmatched active request',
    );

    expect(summary).toMatchObject({
      bodyValid: true,
      activeUserRequestOccurrences: 0,
      duplicateFunctionCallIds: true,
      orphanFunctionOutputCount: 1,
      unpairedFunctionCallCount: 2,
    });
    expect(JSON.stringify(summary)).not.toContain('same-secret-id');
    expect(JSON.stringify(summary)).not.toContain('orphan-secret-id');
  });

  it('returns a bounded invalid summary for malformed bodies', () => {
    expect(summarizeResponsesRequestBody(null, 'request')).toMatchObject({
      bodyValid: false,
      inputItems: [],
      activeUserRequestOccurrences: 0,
    });
  });
});
