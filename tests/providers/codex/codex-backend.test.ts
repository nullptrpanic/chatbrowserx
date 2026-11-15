import { describe, expect, it, vi } from 'vitest';
import type { ModelRequest } from '@openai/agents-core';
import { CodexProvider } from '../../../src/providers/codex/provider';
import { CodexCredentials } from '../../../src/providers/codex/credentials';
import { DEFAULT_APP_SETTINGS } from '../../../src/persistence/settings-store';

const token = `${btoa('{}')}.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } }))}.`;
const request: ModelRequest = {
  systemInstructions: 'User instructions only.',
  input: 'Hello',
  tools: [],
  handoffs: [],
  outputType: 'text',
  modelSettings: { store: false, preserveRawUsage: true },
  tracing: false,
};
const output = [
  {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'OK', annotations: [] }],
  },
];
function response(items: object[] = output, terminalOutput: object[] = []): Response {
  const initial = {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    status: 'in_progress',
    output: [],
    error: null,
    incomplete_details: null,
  };
  const events = [
    { type: 'response.created', response: initial },
    ...items.flatMap((item, output_index) => [
      { type: 'response.output_item.added', item, output_index },
      { type: 'response.output_item.done', item, output_index },
    ]),
    {
      type: 'response.completed',
      response: {
        ...initial,
        status: 'completed',
        output: terminalOutput,
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    },
  ];
  return new Response(
    events
      .map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('Codex backend SDK boundary', () => {
  it('lazily refreshes credentials for an existing model and pairs each token with its account', async () => {
    const nextToken = `${btoa('{}')}.${btoa(JSON.stringify({ chatgpt_account_id: 'next-account' })).replace(/=+$/, '')}.`;
    const readCredential = vi.fn(async () => token);
    const configuration = {};
    const credentials = new CodexCredentials(
      { getAccessToken: async () => undefined },
      { get: async () => ({ ...DEFAULT_APP_SETTINGS, credentialSource: 'sandbox' }) },
      { configurationKey: async () => configuration, readCredential },
    );
    const sent: Headers[] = [];
    const backend = new CodexProvider(credentials, async (_url, init) => {
      sent.push(new Headers(init?.headers));
      return response();
    });
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const model = await backend.getModel({ model: 'fixture', reasoningEffort: 'low' }, 'chat');
      expect(readCredential).not.toHaveBeenCalled();
      const generate = async () => {
        const events = [];
        for await (const event of model.getStreamedResponse(request)) events.push(event);
        expect(events.some((event) => event.type === 'response_done')).toBe(true);
      };
      await generate();
      readCredential.mockResolvedValue(nextToken);
      now.mockReturnValue(120_000);
      await generate();
      expect(readCredential).toHaveBeenCalledOnce();
      now.mockReturnValue(300_000);
      await Promise.all([generate(), generate()]);
      expect(readCredential).toHaveBeenCalledTimes(2);
      expect(
        sent.map((headers) => [headers.get('Authorization'), headers.get('ChatGPT-Account-ID')]),
      ).toEqual([
        [`Bearer ${token}`, 'test-account'],
        [`Bearer ${token}`, 'test-account'],
        [`Bearer ${nextToken}`, 'next-account'],
        [`Bearer ${nextToken}`, 'next-account'],
      ]);
      expect(sent.every((headers) => headers.get('session-id') === 'chat')).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('reports a request-time credential failure as authentication failure without dispatching', async () => {
    const configuration = {};
    const credentials = new CodexCredentials(
      { getAccessToken: async () => undefined },
      { get: async () => ({ ...DEFAULT_APP_SETTINGS, credentialSource: 'sandbox' }) },
      {
        configurationKey: async () => configuration,
        readCredential: async () => {
          throw new Error('private credential failure');
        },
      },
    );
    const fetch = vi.fn(async () => response());
    const model = await new CodexProvider(credentials, fetch).getModel({
      model: 'fixture',
      reasoningEffort: 'low',
    });
    await expect(model.getStreamedResponse(request).next()).rejects.toMatchObject({ code: 'AUTH' });
    expect(await credentials.credentialSync.getStatus()).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 'invalid-token'])(
    'rejects a missing or invalid manual token before dispatching: %s',
    async (accessToken) => {
      const fetch = vi.fn(async () => response());
      const backend = new CodexProvider({ getAccessToken: async () => accessToken }, fetch);
      const model = await backend.getModel({ model: 'fixture', reasoningEffort: 'low' });
      await expect(model.getStreamedResponse(request).next()).rejects.toMatchObject({
        code: 'AUTH',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('does not dispatch a cancelled request or interrupt another waiter for the shared refresh', async () => {
    let finishRead!: (token: string) => void;
    const pendingToken = new Promise<string>((resolve) => {
      finishRead = resolve;
    });
    const readCredential = vi.fn(() => pendingToken);
    const configuration = {};
    const credentials = new CodexCredentials(
      { getAccessToken: async () => undefined },
      { get: async () => ({ ...DEFAULT_APP_SETTINGS, credentialSource: 'sandbox' }) },
      { configurationKey: async () => configuration, readCredential },
    );
    const fetch = vi.fn(async () => response());
    const model = await new CodexProvider(credentials, fetch).getModel({
      model: 'fixture',
      reasoningEffort: 'low',
    });
    const controller = new AbortController();
    const cancelled = expect(
      model.getStreamedResponse({ ...request, signal: controller.signal }).next(),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    const active = (async () => {
      const events = [];
      for await (const event of model.getStreamedResponse(request)) events.push(event);
      return events;
    })();
    await vi.waitFor(() => expect(readCredential).toHaveBeenCalledOnce());
    controller.abort();
    finishRead(token);
    await cancelled;
    expect((await active).some((event) => event.type === 'response_done')).toBe(true);
    expect(readCredential).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'round-trips application namespaces with terminal output present=%s',
    async (terminalOutput) => {
      const calls = [
        {
          id: 'fc_1',
          type: 'function_call',
          namespace: 'chatbrowserx_browser',
          name: 'tab',
          call_id: 'call_1',
          arguments: '{}',
          status: 'completed',
        },
        {
          id: 'fc_2',
          type: 'function_call',
          name: 'chatbrowserx_browser.tab',
          call_id: 'call_2',
          arguments: '{}',
          status: 'completed',
        },
      ];
      let body: unknown;
      const backend = new CodexProvider(
        { getAccessToken: async () => token },
        async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return response(calls, terminalOutput ? calls : []);
        },
      );
      const model = await backend.getModel({ model: 'fixture', reasoningEffort: 'low' });
      const events = [];
      for await (const event of model.getStreamedResponse({
        ...request,
        input: [
          {
            type: 'function_call',
            namespace: 'browser',
            name: 'tab',
            arguments: '{}',
            callId: 'earlier',
          },
          {
            type: 'function_call_result',
            name: 'tab',
            callId: 'earlier',
            status: 'completed',
            output: '[]',
          },
        ],
        modelSettings: { ...request.modelSettings, toolChoice: 'browser.tab' },
        tools: [
          {
            type: 'function',
            namespace: 'browser',
            namespaceDescription: 'Browser operations.',
            name: 'tab',
            description: 'Call browser.tab.',
            parameters: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
      }))
        events.push(event);
      expect(body).toMatchObject({
        instructions: request.systemInstructions,
        tools: [
          { type: 'web_search' },
          {
            type: 'namespace',
            name: 'chatbrowserx_browser',
            tools: [{ name: 'tab', description: 'Call chatbrowserx_browser.tab.' }],
          },
        ],
        tool_choice: { type: 'function', name: 'chatbrowserx_browser.tab' },
        input: [
          {
            type: 'function_call',
            name: 'tab',
            namespace: 'chatbrowserx_browser',
            call_id: 'earlier',
          },
          { type: 'function_call_output', call_id: 'earlier', output: '[]' },
        ],
      });
      expect(events.find((event) => event.type === 'response_done')).toMatchObject({
        response: {
          output: ['call_1', 'call_2'].map((callId) => ({
            type: 'function_call',
            namespace: 'browser',
            name: 'tab',
            callId,
          })),
        },
      });
    },
  );

  it('routes a conversation consistently without adding session state to the request body', async () => {
    const sent: Array<{ session: string | null; body: unknown }> = [];
    const backend = new CodexProvider({ getAccessToken: async () => token }, async (_url, init) => {
      sent.push({
        session: new Headers(init?.headers).get('session-id'),
        body: JSON.parse(String(init?.body)),
      });
      return response();
    });
    for (const id of ['conversation-a', 'conversation-a', 'conversation-b', undefined]) {
      const model = await backend.getModel({ model: 'fixture', reasoningEffort: 'low' }, id);
      for await (const event of model.getStreamedResponse(request)) void event;
    }
    expect(sent.map((item) => item.session)).toEqual([
      'conversation-a',
      'conversation-a',
      'conversation-b',
      null,
    ]);
    expect(sent.every((item) => JSON.stringify(item.body) === JSON.stringify(sent[0]?.body))).toBe(
      true,
    );
  });

  it('calls the native fetch with its global receiver in a Worker', async () => {
    const fetch = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(Response.json({ models: [] }));
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const backend = new CodexProvider({ getAccessToken: async () => token });
      await expect(backend.listModels(new AbortController().signal)).resolves.toEqual([]);
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains returned usage on an incomplete stream and redacts upstream error text', async () => {
    const backend = new CodexProvider(
      { getAccessToken: async () => token },
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: 'response.incomplete', response: { id: 'partial', output: [], error: { message: 'private text' }, usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const model = await backend.getModel({ model: 'fixture', reasoningEffort: 'low' });
    await expect(
      (async () => {
        for await (const event of model.getStreamedResponse(request)) {
          void event;
        }
      })(),
    ).rejects.toMatchObject({
      code: 'TRANSIENT',
      transientStage: 'response_incomplete',
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 },
    });
  });

  it('does not fabricate zero usage when the provider omits it', async () => {
    const backend = new CodexProvider({ getAccessToken: async () => token }, async () => {
      const stream = await response().text();
      return new Response(
        stream.replace(',"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}', ''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const model = await backend.getModel({ model: 'fixture', reasoningEffort: 'low' });
    const events = [];
    for await (const event of model.getStreamedResponse(request)) events.push(event);
    const done = events.find((event) => event.type === 'response_done');
    expect(done?.type === 'response_done' && done.response.rawUsage).toBeUndefined();
  });

  it('preserves streamed output when the terminal envelope omits it, without appending instructions', async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchPort = vi.fn(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return response();
    });
    const backend = new CodexProvider({ getAccessToken: async () => token }, fetchPort);
    const model = await backend.getModel({ model: 'gpt-5.6-terra', reasoningEffort: 'high' });
    const events = [];
    for await (const event of model.getStreamedResponse(request)) events.push(event);
    expect(events.find((e) => e.type === 'response_done')).toMatchObject({
      response: {
        output: [{ type: 'message', content: [{ text: 'OK' }] }],
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    });
    expect(sent[0]).toMatchObject({
      instructions: 'User instructions only.',
      store: false,
      stream: true,
    });
    expect(fetchPort).toHaveBeenCalledOnce();
  });

  it('discovers model-specific reasoning defaults and context limits from the backend', async () => {
    const backend = new CodexProvider({ getAccessToken: async () => token }, async (request) => {
      const url = new URL(String(request));
      expect(url.pathname).toBe('/backend-api/codex/models');
      // A current catalog includes models omitted from the retired client version's response.
      if (url.searchParams.get('client_version') === '0.134.0')
        return Response.json({ models: [] });
      return Response.json({
        models: [
          {
            slug: 'test-model',
            display_name: 'Test model',
            default_reasoning_level: 'high',
            supported_reasoning_levels: [
              { effort: 'low', description: 'Fast' },
              { effort: 'high', description: 'Thorough' },
            ],
            context_window: 100000,
          },
          {
            slug: 'hidden-model',
            display_name: 'Hidden model',
            visibility: 'hide',
            default_reasoning_level: 'medium',
            supported_reasoning_levels: [{ effort: 'medium' }],
            context_window: 200000,
          },
        ],
      });
    });
    expect(await backend.listModels(new AbortController().signal)).toEqual([
      {
        id: 'test-model',
        name: 'Test model',
        defaultReasoningEffort: 'high',
        reasoningEfforts: ['low', 'high'],
        contextWindow: 100000,
      },
      {
        id: 'hidden-model',
        name: 'Hidden model',
        hidden: true,
        defaultReasoningEffort: 'medium',
        reasoningEfforts: ['medium'],
        contextWindow: 200000,
      },
    ]);
  });

  it.each([401, 403, 429, 503])(
    'does not hide HTTP %i or retry in the transport',
    async (status) => {
      const fetchPort = vi.fn(async () =>
        Response.json(
          { error: { message: 'private upstream text' } },
          { status, headers: { 'retry-after': '2' } },
        ),
      );
      const backend = new CodexProvider({ getAccessToken: async () => token }, fetchPort);
      await expect(backend.listModels(new AbortController().signal)).rejects.toMatchObject({
        status,
        code:
          status === 401
            ? 'AUTH'
            : status === 403
              ? 'FORBIDDEN'
              : status === 429
                ? 'RATE_LIMIT'
                : 'TRANSIENT',
      });
      expect(fetchPort).toHaveBeenCalledOnce();
    },
  );

  it('replays native compaction without guessing a summary or adding instructions', async () => {
    const requests: Record<string, unknown>[] = [];
    const compacted = { type: 'compaction', id: 'compact_test', encrypted_content: 'opaque-state' };
    const fetchPort = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('session-id')).toBe('conversation-compact');
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'compact_response', output: [compacted], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } })}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const backend = new CodexProvider({ getAccessToken: async () => token }, fetchPort);
    const result = await backend.compact(
      { model: 'fixture', reasoningEffort: 'high' },
      { ...request, input: [{ role: 'user', content: 'Remember blue.' }] },
      'conversation-compact',
    );
    expect(result).toEqual({
      items: [compacted],
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });
    expect(requests[0]).toMatchObject({
      instructions: request.systemInstructions,
      input: [{ role: 'user', content: 'Remember blue.' }, { type: 'compaction_trigger' }],
    });
  });

  it.each([undefined, '', '  ', 123])(
    'rejects compaction whose encrypted content is %j before it can replace the session',
    async (encryptedContent) => {
      const backend = new CodexProvider(
        { getAccessToken: async () => token },
        async () =>
          new Response(
            `data: ${JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'compact_response',
                output: [
                  { type: 'compaction', id: 'compact_test', encrypted_content: encryptedContent },
                ],
                usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
              },
            })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      );
      await expect(
        backend.compact({ model: 'fixture', reasoningEffort: 'high' }, request),
      ).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        invalidResponseStage: 'compaction_schema',
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      });
    },
  );

  it('enables native search by default and preserves public summaries and search evidence', async () => {
    const rawItems = [
      {
        id: 'rs_1',
        type: 'reasoning',
        encrypted_content: 'opaque-only',
        summary: [{ type: 'summary_text', text: 'Checking the source.' }],
      },
      {
        id: 'ws_1',
        type: 'web_search_call',
        status: 'completed',
        action: {
          type: 'search',
          query: 'fixture',
          sources: [{ url: 'https://example.com/source', type: 'url' }],
        },
      },
      ...output,
    ];
    const initial = {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_1',
      summary_index: 0,
      delta: 'Checking the source.',
    };
    const sent: unknown[] = [];
    const backend = new CodexProvider({ getAccessToken: async () => token }, async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      const stream = await response(rawItems as typeof output).text();
      return new Response(`data: ${JSON.stringify(initial)}\n\n${stream}`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const events = [];
    for await (const event of (
      await backend.getModel({ model: 'fixture', reasoningEffort: 'high' })
    ).getStreamedResponse(request))
      events.push(event);
    expect(sent).toMatchObject([
      {
        instructions: request.systemInstructions,
        tools: [{ type: 'web_search' }],
      },
    ]);
    expect(events).toContainEqual({
      type: 'model',
      event: { type: 'reasoning_summary_delta', key: 'rs_1:0', delta: 'Checking the source.' },
    });
    const done = events.find((event) => event.type === 'response_done');
    expect(JSON.stringify(done)).toContain('opaque-only');
    expect(done).toMatchObject({
      response: {
        output: expect.arrayContaining([
          expect.objectContaining({ type: 'hosted_tool_call', name: 'web_search_call' }),
        ]),
      },
    });
  });
});
