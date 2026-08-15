import { describe, expect, it, vi } from 'vitest';
import { CodexProvider } from '../../../src/providers/codex/codex-provider';
import { CODEX_RESPONSES_URL } from '../../../src/providers/codex/codex-constants';
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
function sseResponse(
  events: readonly { readonly event: string; readonly data: unknown }[],
): Response {
  const body = `${events
    .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')}data: [DONE]\n\n`;
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
              name: 'browser.act',
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
              name: 'browser.act',
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
              usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 },
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
      { type: 'tool.started', callId: 'call_1', name: 'browser.act' },
      { type: 'tool.arguments.delta', callId: 'call_1', delta: '{"type":"click"}' },
      {
        type: 'tool.completed',
        callId: 'call_1',
        name: 'browser.act',
        argumentsJson: '{"type":"click"}',
      },
      {
        type: 'response.completed',
        responseId: 'resp_123',
        usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
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
          data: { type: 'response.created', response: { id: 'resp_incomplete' } },
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
