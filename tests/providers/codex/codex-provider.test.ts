import { describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../../../src/providers/codex/codex-provider';
import {
  CODEX_COMPACT_URL,
  CODEX_RESPONSES_URL,
} from '../../../src/providers/codex/codex-constants';
import type { CredentialStore } from '../../../src/persistence/credential-store';
import type { ModelRequest } from '../../../src/providers/provider-types';
import type { ModelStreamEvent } from '../../../src/providers/stream-events';

/** Builds an unsigned synthetic JWT that cannot be used as a real credential. */
function jwt(payload: Readonly<Record<string, unknown>>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

/** Creates the minimal trusted credential boundary used by provider tests. */
function credentialStore(token?: string): CredentialStore {
  return {
    initialize: vi.fn(async () => undefined),
    getCodexAccessToken: vi.fn(async () => token),
    setCodexAccessToken: vi.fn(async () => undefined),
    getTavilyKey: vi.fn(async () => undefined),
    setTavilyKey: vi.fn(async () => undefined),
  };
}

/** Collects a normalized provider stream. */
async function collect(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/** Returns an SSE response using standard event names and JSON payloads. */
function sseBody(events: readonly { readonly event: string; readonly data: unknown }[]): string {
  return `${events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')}data: [DONE]\n\n`;
}

/** Returns an SSE response using standard event names and JSON payloads. */
function sseResponse(
  events: readonly { readonly event: string; readonly data: unknown }[],
): Response {
  const body = sseBody(events);
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const REQUEST: ModelRequest = {
  model: 'gpt-5.6-terra',
  reasoningEffort: 'high',
  systemPrompt: 'Stay bounded.',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Click the result.' }],
    },
  ],
  tools: [],
};

const ACCESS_TOKEN = jwt({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' },
});

describe('CodexProvider', () => {
  it('compacts through the fixed unary endpoint and returns only the opaque boundary', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Click the result.' }],
              },
              {
                type: 'compaction',
                id: 'cmp_1',
                encrypted_content: 'opaque-compacted-context',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const provider = new CodexProvider(credentialStore(ACCESS_TOKEN), fetchMock);

    await expect(provider.compact(REQUEST, new AbortController().signal)).resolves.toEqual({
      itemId: 'cmp_1',
      encryptedContent: 'opaque-compacted-context',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      CODEX_COMPACT_URL,
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('store');
    expect(body).not.toHaveProperty('stream');
  });

  it.each([
    { output: [] },
    {
      output: [
        { type: 'compaction', id: 'cmp_1', encrypted_content: 'first' },
        { type: 'compaction', id: 'cmp_2', encrypted_content: 'second' },
      ],
    },
    {
      output: [
        { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' },
        { type: 'message', role: 'user', content: [] },
      ],
    },
    {
      output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: '' }],
    },
  ])('rejects malformed native compact output %#', async (payload) => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await expect(provider.compact(REQUEST, new AbortController().signal)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('treats a compact response body read failure as transient', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('synthetic connection reset'));
      },
    });
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(
        async () =>
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await expect(provider.compact(REQUEST, new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSIENT',
      retryable: true,
    });
  });

  it('streams valid SSE when the fixed endpoint omits Content-Type', async () => {
    const events = [
      {
        event: 'response.created',
        data: {
          type: 'response.created',
          response: { id: 'resp_without_content_type' },
        },
      },
      {
        event: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'Ready' },
      },
      {
        event: 'response.completed',
        data: {
          type: 'response.completed',
          response: { id: 'resp_without_content_type' },
        },
      },
    ];
    const response = new Response(new TextEncoder().encode(sseBody(events)), {
      status: 200,
    });
    expect(response.headers.get('Content-Type')).toBeNull();
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () => response),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_without_content_type' },
      { type: 'text.delta', delta: 'Ready' },
      {
        type: 'response.completed',
        responseId: 'resp_without_content_type',
        usage: null,
      },
    ]);
  });

  it('rejects an explicitly non-SSE successful response', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(
        async () =>
          new Response(new TextEncoder().encode('{}'), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('calls the fetch port without rebinding its receiver', async () => {
    let calledWithoutReceiver = false;
    const receiverSensitiveFetch = function (
      this: unknown,
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> {
      void _input;
      void _init;
      calledWithoutReceiver = this === undefined;
      if (!calledWithoutReceiver) {
        return Promise.reject(new TypeError('Illegal invocation'));
      }
      return Promise.resolve(
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_receiver' },
            },
          },
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Ready' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_receiver' },
            },
          },
        ]),
      );
    };
    const provider = new CodexProvider(credentialStore(ACCESS_TOKEN), receiverSensitiveFetch);

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual(
      expect.arrayContaining([{ type: 'text.delta', delta: 'Ready' }]),
    );
    expect(calledWithoutReceiver).toBe(true);
  });

  it('streams text and one complete function call using current Responses events', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        {
          event: 'response.created',
          data: { type: 'response.created', response: { id: 'resp_123' } },
        },
        {
          event: 'response.output_text.delta',
          data: { type: 'response.output_text.delta', delta: 'Working' },
        },
        {
          event: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            item: {
              id: 'item_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'lookup_record',
              arguments: '',
            },
          },
        },
        {
          event: 'response.function_call_arguments.delta',
          data: {
            type: 'response.function_call_arguments.delta',
            item_id: 'item_1',
            delta: '{"type":"click"}',
          },
        },
        {
          event: 'response.function_call_arguments.done',
          data: {
            type: 'response.function_call_arguments.done',
            item_id: 'item_1',
            arguments: '{"type":"click"}',
          },
        },
        {
          event: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            item: {
              id: 'item_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'lookup_record',
              arguments: '{"type":"click"}',
            },
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: {
              id: 'resp_123',
              usage: {
                input_tokens: 30,
                output_tokens: 12,
                total_tokens: 42,
                input_tokens_details: {
                  cached_tokens: 20,
                  cache_write_tokens: 4,
                },
                output_tokens_details: { reasoning_tokens: 7 },
              },
            },
          },
        },
      ]),
    );
    const provider = new CodexProvider(credentialStore(ACCESS_TOKEN), fetchMock);
    const controller = new AbortController();

    await expect(collect(provider.stream(REQUEST, controller.signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_123' },
      { type: 'text.delta', delta: 'Working' },
      { type: 'tool.started', callId: 'call_1', name: 'lookup_record' },
      {
        type: 'tool.arguments.delta',
        callId: 'call_1',
        delta: '{"type":"click"}',
      },
      {
        type: 'tool.completed',
        callId: 'call_1',
        name: 'lookup_record',
        argumentsJson: '{"type":"click"}',
      },
      {
        type: 'response.completed',
        responseId: 'resp_123',
        usage: {
          inputTokens: 30,
          outputTokens: 12,
          totalTokens: 42,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 4,
          reasoningOutputTokens: 7,
        },
      },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      CODEX_RESPONSES_URL,
      expect.objectContaining({
        method: 'POST',
        signal: controller.signal,
        headers: expect.objectContaining({
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'ChatGPT-Account-ID': 'acct_test',
        }),
      }),
    );
  });

  it('rejects conflicting canonical function-call arguments', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_tool_conflict' },
            },
          },
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              item: {
                id: 'item_tool_conflict',
                type: 'function_call',
                call_id: 'call_tool_conflict',
                name: 'lookup_record',
                arguments: '',
              },
            },
          },
          {
            event: 'response.function_call_arguments.done',
            data: {
              type: 'response.function_call_arguments.done',
              item_id: 'item_tool_conflict',
              arguments: '{"value":"first"}',
            },
          },
          {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              item: {
                id: 'item_tool_conflict',
                type: 'function_call',
                call_id: 'call_tool_conflict',
                name: 'lookup_record',
                arguments: '{"value":"different"}',
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_tool_conflict' },
            },
          },
        ]),
      ),
    );

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('normalizes a completed Responses reasoning summary without exposing raw reasoning', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_reasoning' },
            },
          },
          {
            event: 'response.reasoning_summary_text.done',
            data: {
              type: 'response.reasoning_summary_text.done',
              item_id: 'reasoning_1',
              summary_index: 0,
              text: 'Compared the available evidence before answering.',
            },
          },
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Ready' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_reasoning' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_reasoning' },
      {
        type: 'reasoning.summary',
        itemId: 'reasoning_1',
        summaryIndex: 0,
        text: 'Compared the available evidence before answering.',
      },
      { type: 'text.delta', delta: 'Ready' },
      { type: 'response.completed', responseId: 'resp_reasoning', usage: null },
    ]);
  });

  it('returns encrypted reasoning only as an opaque continuation item', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_reasoning_continuation' },
            },
          },
          {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'reasoning_continuation_1',
                type: 'reasoning',
                encrypted_content: 'opaque-encrypted-content',
                summary: [{ type: 'summary_text', text: 'Checked the current page.' }],
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_reasoning_continuation' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_reasoning_continuation' },
      {
        type: 'reasoning.encrypted',
        itemId: 'reasoning_continuation_1',
        encryptedContent: 'opaque-encrypted-content',
        summary: [{ type: 'summary_text', text: 'Checked the current page.' }],
      },
      {
        type: 'response.completed',
        responseId: 'resp_reasoning_continuation',
        usage: null,
      },
    ]);
  });

  it('uses the finalized refusal when no refusal delta was delivered', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_refusal_done' },
            },
          },
          {
            event: 'response.refusal.done',
            data: {
              type: 'response.refusal.done',
              item_id: 'message_refusal',
              output_index: 0,
              content_index: 0,
              refusal: 'I cannot help with that request.',
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_refusal_done' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_refusal_done' },
      { type: 'text.delta', delta: 'I cannot help with that request.' },
      {
        type: 'response.completed',
        responseId: 'resp_refusal_done',
        usage: null,
      },
    ]);
  });

  it('uses finalized output text when no output-text delta was delivered', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_text_done' },
            },
          },
          {
            event: 'response.output_text.done',
            data: {
              type: 'response.output_text.done',
              item_id: 'message_text',
              output_index: 0,
              content_index: 0,
              text: 'Final text without a preceding delta.',
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_text_done' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_text_done' },
      { type: 'text.delta', delta: 'Final text without a preceding delta.' },
      { type: 'response.completed', responseId: 'resp_text_done', usage: null },
    ]);
  });

  it.each([
    ['does not duplicate completed text', 'Complete answer.', 'Complete answer.', []],
    ['emits only the missing finalized suffix', 'Partial ', 'Partial answer.', ['answer.']],
  ] as const)('%s', async (_label, streamed, finalized, finalizedDeltas) => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_text_reconciled' },
            },
          },
          {
            event: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              item_id: 'message_text',
              output_index: 0,
              content_index: 0,
              delta: streamed,
            },
          },
          {
            event: 'response.output_text.done',
            data: {
              type: 'response.output_text.done',
              item_id: 'message_text',
              output_index: 0,
              content_index: 0,
              text: finalized,
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_text_reconciled' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_text_reconciled' },
      { type: 'text.delta', delta: streamed },
      ...finalizedDeltas.map((delta) => ({
        type: 'text.delta' as const,
        delta,
      })),
      {
        type: 'response.completed',
        responseId: 'resp_text_reconciled',
        usage: null,
      },
    ]);
  });

  it('uses a completed output-text content part when finer-grained text events are missing', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_content_part' },
            },
          },
          {
            event: 'response.content_part.done',
            data: {
              type: 'response.content_part.done',
              item_id: 'message_content_part',
              output_index: 0,
              content_index: 0,
              part: {
                type: 'output_text',
                text: 'Recovered from the completed content part.',
                annotations: [],
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_content_part' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_content_part' },
      {
        type: 'text.delta',
        delta: 'Recovered from the completed content part.',
      },
      {
        type: 'response.completed',
        responseId: 'resp_content_part',
        usage: null,
      },
    ]);
  });

  it('reconciles a completed content part with output-text deltas already delivered', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_content_reconciled' },
            },
          },
          {
            event: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              item_id: 'message_content_part',
              output_index: 0,
              content_index: 0,
              delta: 'Partial ',
            },
          },
          {
            event: 'response.content_part.done',
            data: {
              type: 'response.content_part.done',
              item_id: 'message_content_part',
              output_index: 0,
              content_index: 0,
              part: {
                type: 'output_text',
                text: 'Partial answer.',
                annotations: [],
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_content_reconciled' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_content_reconciled' },
      { type: 'text.delta', delta: 'Partial ' },
      { type: 'text.delta', delta: 'answer.' },
      {
        type: 'response.completed',
        responseId: 'resp_content_reconciled',
        usage: null,
      },
    ]);
  });

  it('uses a completed refusal content part when refusal events are missing', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_refusal_part' },
            },
          },
          {
            event: 'response.content_part.done',
            data: {
              type: 'response.content_part.done',
              item_id: 'message_refusal_part',
              output_index: 0,
              content_index: 0,
              part: {
                type: 'refusal',
                refusal: 'This request cannot be completed.',
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_refusal_part' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_refusal_part' },
      { type: 'text.delta', delta: 'This request cannot be completed.' },
      {
        type: 'response.completed',
        responseId: 'resp_refusal_part',
        usage: null,
      },
    ]);
  });

  it('uses a completed message output item as the final text fallback', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_message_item' },
            },
          },
          {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'message_item',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: 'Recovered from the completed message item.',
                    annotations: [],
                  },
                ],
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_message_item' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_message_item' },
      {
        type: 'text.delta',
        delta: 'Recovered from the completed message item.',
      },
      {
        type: 'response.completed',
        responseId: 'resp_message_item',
        usage: null,
      },
    ]);
  });

  it('uses a refusal from a completed message output item as the final fallback', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_message_refusal' },
            },
          },
          {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'message_refusal_item',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'refusal',
                    refusal: 'I cannot complete this request.',
                  },
                ],
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_message_refusal' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_message_refusal' },
      { type: 'text.delta', delta: 'I cannot complete this request.' },
      {
        type: 'response.completed',
        responseId: 'resp_message_refusal',
        usage: null,
      },
    ]);
  });

  it('deduplicates the normal output-text completion cascade', async () => {
    const text = 'One visible answer.';
    const content = { type: 'output_text', text, annotations: [] } as const;
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_completion_cascade' },
            },
          },
          {
            event: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              item_id: 'message_cascade',
              output_index: 0,
              content_index: 0,
              delta: text,
            },
          },
          {
            event: 'response.output_text.done',
            data: {
              type: 'response.output_text.done',
              item_id: 'message_cascade',
              output_index: 0,
              content_index: 0,
              text,
            },
          },
          {
            event: 'response.content_part.done',
            data: {
              type: 'response.content_part.done',
              item_id: 'message_cascade',
              output_index: 0,
              content_index: 0,
              part: content,
            },
          },
          {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'message_cascade',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [content],
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_completion_cascade' },
            },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_completion_cascade' },
      { type: 'text.delta', delta: text },
      {
        type: 'response.completed',
        responseId: 'resp_completion_cascade',
        usage: null,
      },
    ]);
  });

  it('ignores unsupported event types without weakening recognized-event validation', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.future_queued',
            data: 'future payload shape',
          },
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_unknown_events' },
            },
          },
          {
            event: 'response.future_progress',
            data: { type: 'response.future_progress', marker: 'during' },
          },
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'Still valid' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_unknown_events' },
            },
          },
          {
            event: 'response.future_accounting',
            data: { type: 'response.future_accounting', marker: 'after' },
          },
        ]),
      ),
    );

    await expect(collect(provider.stream(REQUEST, new AbortController().signal))).resolves.toEqual([
      { type: 'response.started', responseId: 'resp_unknown_events' },
      { type: 'text.delta', delta: 'Still valid' },
      {
        type: 'response.completed',
        responseId: 'resp_unknown_events',
        usage: null,
      },
    ]);
  });

  it.each([
    [
      'before response.created',
      [
        {
          event: 'response.output_text.delta',
          data: { type: 'response.output_text.delta', delta: 'Too early' },
        },
        {
          event: 'response.created',
          data: {
            type: 'response.created',
            response: { id: 'resp_event_order' },
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: { id: 'resp_event_order' },
          },
        },
      ],
    ],
    [
      'after response.completed',
      [
        {
          event: 'response.created',
          data: {
            type: 'response.created',
            response: { id: 'resp_event_order' },
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: { id: 'resp_event_order' },
          },
        },
        {
          event: 'response.output_text.delta',
          data: { type: 'response.output_text.delta', delta: 'Too late' },
        },
      ],
    ],
  ] as const)('rejects recognized content events %s', async (_label, events) => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () => sseResponse(events)),
    );

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    [
      'changes the item id for one output position',
      [
        {
          event: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: 'message_original',
            output_index: 0,
            content_index: 0,
            delta: 'Answer',
          },
        },
        {
          event: 'response.output_text.done',
          data: {
            type: 'response.output_text.done',
            item_id: 'message_other',
            output_index: 0,
            content_index: 0,
            text: 'Answer',
          },
        },
      ],
    ],
    [
      'changes the content type for one content position',
      [
        {
          event: 'response.output_text.done',
          data: {
            type: 'response.output_text.done',
            item_id: 'message_content_type',
            output_index: 0,
            content_index: 0,
            text: 'Answer',
          },
        },
        {
          event: 'response.content_part.done',
          data: {
            type: 'response.content_part.done',
            item_id: 'message_content_type',
            output_index: 0,
            content_index: 0,
            part: { type: 'refusal', refusal: 'Refused' },
          },
        },
      ],
    ],
    [
      'provides only part of the optional text-delta identity',
      [
        {
          event: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            item_id: 'message_partial_identity',
            delta: 'Answer',
          },
        },
      ],
    ],
  ] as const)('rejects a content stream that %s', async (_label, contentEvents) => {
    const responseId = 'resp_content_identity';
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: { type: 'response.created', response: { id: responseId } },
          },
          ...contentEvents,
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: responseId },
            },
          },
        ]),
      ),
    );

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects canonical text that conflicts with already streamed content', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_text_conflict' },
            },
          },
          {
            event: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              item_id: 'message_text_conflict',
              output_index: 0,
              content_index: 0,
              delta: 'Original',
            },
          },
          {
            event: 'response.output_text.done',
            data: {
              type: 'response.output_text.done',
              item_id: 'message_text_conflict',
              output_index: 0,
              content_index: 0,
              text: 'Different',
            },
          },
        ]),
      ),
    );

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    [
      'before response.created',
      [
        {
          event: 'response.failed',
          data: {
            type: 'response.failed',
            response: {
              id: 'resp_failed_order',
              error: { code: 'server_error' },
            },
          },
        },
      ],
    ],
    [
      'with a mismatched response id',
      [
        {
          event: 'response.created',
          data: {
            type: 'response.created',
            response: { id: 'resp_failed_order' },
          },
        },
        {
          event: 'response.failed',
          data: {
            type: 'response.failed',
            response: { id: 'resp_other', error: { code: 'server_error' } },
          },
        },
      ],
    ],
    [
      'after response.completed',
      [
        {
          event: 'response.created',
          data: {
            type: 'response.created',
            response: { id: 'resp_failed_order' },
          },
        },
        {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            response: { id: 'resp_failed_order' },
          },
        },
        {
          event: 'response.failed',
          data: {
            type: 'response.failed',
            response: {
              id: 'resp_failed_order',
              error: { code: 'server_error' },
            },
          },
        },
      ],
    ],
  ] as const)('rejects response.failed %s', async (_label, events) => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () => sseResponse(events)),
    );

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects an out-of-band error after a completed response', async () => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_error_after_complete' },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_error_after_complete' },
            },
          },
          {
            event: 'error',
            data: {
              type: 'error',
              code: 'server_error',
              message: 'late error',
            },
          },
        ]),
      ),
    );

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    [
      'an incomplete response',
      {
        type: 'response.incomplete',
        response: {
          id: 'resp_terminal_error',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        },
      },
      'TRANSIENT',
    ],
    [
      'a server-side failed response',
      {
        type: 'response.failed',
        response: {
          id: 'resp_terminal_error',
          error: { code: 'server_error' },
        },
      },
      'TRANSIENT',
    ],
    [
      'a rate-limited failed response',
      {
        type: 'response.failed',
        response: {
          id: 'resp_terminal_error',
          error: { code: 'rate_limit_exceeded' },
        },
      },
      'RATE_LIMIT',
    ],
  ] as const)('normalizes %s', async (_label, terminal, code) => {
    const provider = new CodexProvider(
      credentialStore(ACCESS_TOKEN),
      vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_terminal_error' },
            },
          },
          { event: terminal.type, data: terminal },
        ]),
      ),
    );

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code, retryable: true });
  });

  it.each(['response.completed', 'response.incomplete'] as const)(
    'rejects a mismatched %s terminal id',
    async (eventType) => {
      const terminal = {
        type: eventType,
        response: { id: 'resp_terminal_other' },
      };
      const provider = new CodexProvider(
        credentialStore(ACCESS_TOKEN),
        vi.fn<typeof fetch>(async () =>
          sseResponse([
            {
              event: 'response.created',
              data: {
                type: 'response.created',
                response: { id: 'resp_terminal_expected' },
              },
            },
            { event: eventType, data: terminal },
          ]),
        ),
      );

      await expect(
        collect(provider.stream(REQUEST, new AbortController().signal)),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );

  it.each(['lookup', 'lookup_record', 'lookup-record'] as const)(
    'preserves valid generic wire tool name %s',
    async (wireName) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        sseResponse([
          {
            event: 'response.created',
            data: {
              type: 'response.created',
              response: { id: 'resp_tool_name' },
            },
          },
          {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              item: {
                id: 'item_tool_name',
                type: 'function_call',
                call_id: 'call_tool_name',
                name: wireName,
                arguments: '{}',
              },
            },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: { id: 'resp_tool_name' },
            },
          },
        ]),
      );

      await expect(
        collect(
          new CodexProvider(credentialStore(ACCESS_TOKEN), fetchMock).stream(
            REQUEST,
            new AbortController().signal,
          ),
        ),
      ).resolves.toEqual([
        { type: 'response.started', responseId: 'resp_tool_name' },
        { type: 'tool.started', callId: 'call_tool_name', name: wireName },
        {
          type: 'tool.completed',
          callId: 'call_tool_name',
          name: wireName,
          argumentsJson: '{}',
        },
        {
          type: 'response.completed',
          responseId: 'resp_tool_name',
          usage: null,
        },
      ]);
    },
  );

  it.each([
    [401, 'AUTH', false],
    [403, 'AUTH', false],
    [429, 'RATE_LIMIT', true],
    [503, 'TRANSIENT', true],
    [400, 'INVALID_RESPONSE', false],
  ] as const)('normalizes HTTP %s without exposing its body', async (status, code, retryable) => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('<html>secret-token-value</html>', {
          status,
          ...(status === 429 ? { headers: { 'Retry-After': '2' } } : {}),
        }),
    );
    const provider = new CodexProvider(credentialStore(ACCESS_TOKEN), fetchMock);

    let thrown: unknown;
    try {
      await collect(provider.stream(REQUEST, new AbortController().signal));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: 'ProviderError',
      code,
      retryable,
      status,
      retryAfterMs: status === 429 ? 2_000 : null,
    });
    expect(String(thrown)).not.toContain('secret-token-value');
  });

  it('normalizes a network failure and an already-aborted request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('network included unsafe details');
    });
    const provider = new CodexProvider(credentialStore(ACCESS_TOKEN), fetchMock);

    await expect(
      collect(provider.stream(REQUEST, new AbortController().signal)),
    ).rejects.toMatchObject({ code: 'TRANSIENT', retryable: true });

    const controller = new AbortController();
    controller.abort();
    await expect(collect(provider.stream(REQUEST, controller.signal))).rejects.toMatchObject({
      code: 'ABORTED',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects missing credentials and an incomplete successful stream', async () => {
    const noTokenFetch = vi.fn<typeof fetch>();
    await expect(
      collect(
        new CodexProvider(credentialStore(), noTokenFetch).stream(
          REQUEST,
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: 'AUTH' });
    expect(noTokenFetch).not.toHaveBeenCalled();

    const incomplete = vi.fn<typeof fetch>(async () =>
      sseResponse([
        {
          event: 'response.created',
          data: {
            type: 'response.created',
            response: { id: 'resp_incomplete' },
          },
        },
      ]),
    );
    await expect(
      collect(
        new CodexProvider(credentialStore(ACCESS_TOKEN), incomplete).stream(
          REQUEST,
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('normalizes explicit upstream error events without echoing their message', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      sseResponse([
        {
          event: 'error',
          data: {
            type: 'error',
            code: 'server_error',
            message: 'secret upstream detail',
          },
        },
      ]),
    );

    let thrown: unknown;
    try {
      await collect(
        new CodexProvider(credentialStore(ACCESS_TOKEN), fetchMock).stream(
          REQUEST,
          new AbortController().signal,
        ),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'TRANSIENT', retryable: true });
    expect(String(thrown)).not.toContain('secret upstream detail');
  });
});
