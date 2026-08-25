import { describe, expect, it, vi } from 'vitest';
import type {
  DebuggerDetachListener,
  DebuggerEventListener,
  DebuggerSession,
  DebuggerTransport,
} from '../../../src/browser/debugger/debugger-transport';
import type { BrowserSessionSnapshot } from '../../../src/browser/debugger/target-session-registry';
import {
  NetworkCaptureError,
  NetworkCaptureRegistry,
} from '../../../src/browser/network/network-capture-registry';

function transport() {
  const eventListeners = new Set<DebuggerEventListener>();
  const detachListeners = new Set<DebuggerDetachListener>();
  const send = vi.fn(async (_session: DebuggerSession, method: string) => {
    if (method === 'Network.getRequestPostData') {
      return {
        postData: JSON.stringify({ password: 'secret', value: 'request-visible' }),
        base64Encoded: false,
      };
    }
    if (method === 'Network.getResponseBody') {
      return {
        body: JSON.stringify({ accessToken: 'secret', value: 'visible' }),
        base64Encoded: false,
      };
    }
    return {};
  });
  return {
    api: {
      attach: vi.fn(async () => undefined),
      detach: vi.fn(async () => undefined),
      send: send as unknown as DebuggerTransport['send'],
      onEvent(listener: DebuggerEventListener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
      onDetach(listener: DebuggerDetachListener) {
        detachListeners.add(listener);
        return () => detachListeners.delete(listener);
      },
    } satisfies DebuggerTransport,
    send,
    event(session: DebuggerSession, method: string, params: Readonly<Record<string, unknown>>) {
      for (const listener of eventListeners) listener(session, method, params);
    },
    detach(session: DebuggerSession) {
      for (const listener of detachListeners) listener(session, 'target_closed');
    },
  };
}

function snapshot(): BrowserSessionSnapshot {
  return {
    tabId: 7,
    generation: 3,
    root: { tabId: 7 },
    children: new Map([
      [
        'frame_1',
        {
          targetId: 'frame_1',
          type: 'iframe',
          url: 'https://frame.test/',
          parentSessionId: null,
          session: { tabId: 7, sessionId: 'session_frame_1' },
        },
      ],
    ]),
  };
}

function registry(debuggerTransport: ReturnType<typeof transport>) {
  let id = 0;
  let now = 1_000;
  return new NetworkCaptureRegistry({
    sessions: { ensure: vi.fn(async () => snapshot()) },
    transport: debuggerTransport.api,
    ids: { create: (prefix: string) => `${prefix}_${String(++id)}` },
    clock: { now: () => ++now },
  });
}

function request(
  debuggerTransport: ReturnType<typeof transport>,
  requestId: string,
  url: string,
  extra: Readonly<Record<string, unknown>> = {},
  requestExtra: Readonly<Record<string, unknown>> = {},
) {
  const extraHeaders =
    typeof requestExtra.headers === 'object' && requestExtra.headers !== null
      ? (requestExtra.headers as Readonly<Record<string, unknown>>)
      : {};
  debuggerTransport.event({ tabId: 7 }, 'Network.requestWillBeSent', {
    requestId,
    timestamp: 1,
    type: 'Fetch',
    request: {
      url,
      method: 'GET',
      ...requestExtra,
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer secret-request-token',
        Cookie: 'session=secret',
        ...extraHeaders,
      },
    },
    ...extra,
  });
}

function response(debuggerTransport: ReturnType<typeof transport>, requestId: string) {
  debuggerTransport.event({ tabId: 7 }, 'Network.responseReceived', {
    requestId,
    timestamp: 1.25,
    type: 'Fetch',
    response: {
      url: 'https://api.test/items?access_token=secret&view=compact',
      status: 200,
      statusText: 'OK',
      mimeType: 'application/json',
      protocol: 'h2',
      fromDiskCache: false,
      fromServiceWorker: false,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': 'secret=response',
        'X-Trace': 'trace_1',
      },
    },
  });
  debuggerTransport.event({ tabId: 7 }, 'Network.loadingFinished', {
    requestId,
    timestamp: 1.5,
    encodedDataLength: 321,
  });
}

describe('NetworkCaptureRegistry', () => {
  it('starts future-only capture idempotently on root, current, and future child sessions', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);

    const first = await capture.start(7, new AbortController().signal);
    const second = await capture.start(7, new AbortController().signal);

    expect(first).toMatchObject({ tabId: 7, alreadyActive: false, generation: 3 });
    expect(first.message).toContain('Earlier traffic is unavailable');
    expect(second).toMatchObject({ alreadyActive: true });
    expect(debuggerTransport.send).toHaveBeenCalledWith({ tabId: 7 }, 'Network.enable', {
      maxTotalBufferSize: 10_485_760,
      maxResourceBufferSize: 1_048_576,
      maxPostDataSize: 0,
    });
    expect(debuggerTransport.send).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'session_frame_1' },
      'Network.enable',
      expect.any(Object),
    );
    expect(
      debuggerTransport.send.mock.calls.filter(([, method]) => method === 'Network.enable'),
    ).toHaveLength(2);

    debuggerTransport.event({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'session_future',
      targetInfo: { targetId: 'frame_future', type: 'iframe', url: 'https://future.test/' },
    });
    await vi.waitFor(() =>
      expect(debuggerTransport.send).toHaveBeenCalledWith(
        { tabId: 7, sessionId: 'session_future' },
        'Network.enable',
        expect.any(Object),
      ),
    );
  });

  it('records redirects as separate opaque entries and returns newest filtered summaries', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);

    request(debuggerTransport, 'cdp_1', 'https://api.test/old?token=secret', {
      redirectResponse: {
        url: 'https://api.test/previous?api_key=secret',
        status: 302,
        statusText: 'Found',
        mimeType: 'text/html',
        protocol: 'h2',
        headers: { Location: 'https://api.test/old', 'Set-Cookie': 'secret' },
      },
    });
    response(debuggerTransport, 'cdp_1');
    request(debuggerTransport, 'cdp_2', 'data:text/plain,private');

    const entries = await capture.list(7, 'api.test', 10, 'recent');

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ status: 200, completed: true, redirected: false });
    expect(entries[1]).toMatchObject({ status: 302, completed: true, redirected: true });
    expect(entries[0]?.requestId).not.toBe('cdp_1');
    expect(entries[0]?.url).toContain('access_token=%5Bredacted%5D');
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(JSON.stringify(entries)).not.toContain('data:text');
  });

  it('keeps only 500 entries and caps list results at the requested maximum', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    for (let index = 0; index < 502; index += 1) {
      request(debuggerTransport, `cdp_${String(index)}`, `https://api.test/${String(index)}`);
    }

    const entries = await capture.list(7, '', 100, 'recent');

    expect(entries).toHaveLength(100);
    expect(entries[0]?.url).toBe('https://api.test/501');
    expect(entries.at(-1)?.url).toBe('https://api.test/402');
  });

  it('samples the newest concrete request per stable endpoint signature', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    request(debuggerTransport, 'cdp_1', 'https://api.test/items?page=1&sort=asc');
    request(debuggerTransport, 'cdp_2', 'https://api.test/items?sort=desc&page=2');
    request(debuggerTransport, 'cdp_3', 'https://api.test/items?page=3', {}, { method: 'POST' });
    request(debuggerTransport, 'cdp_4', 'https://api.test/items?page=4&filter=open');

    const entries = await capture.list(7, '', 10, 'endpoint_sample');

    expect(entries).toHaveLength(3);
    expect(entries.map(({ method, occurrenceCount }) => [method, occurrenceCount])).toEqual([
      ['GET', 1],
      ['POST', 1],
      ['GET', 2],
    ]);
    expect(entries[2]).toMatchObject({
      requestId: 'networkRequest_2',
      url: 'https://api.test/items?sort=desc&page=2',
    });
  });

  it('preserves first-seen input order, deduplicates IDs, and isolates missing batch items', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    request(debuggerTransport, 'cdp_1', 'https://api.test/one');
    request(debuggerTransport, 'cdp_2', 'https://api.test/two');
    const entries = await capture.list(7, '', 10, 'recent');
    const newest = entries[0];
    const oldest = entries[1];
    if (!newest || !oldest) throw new Error('Expected two captured requests.');

    const results = await capture.get(7, [
      {
        requestId: newest.requestId,
        includeRequestBody: false,
        includeResponseBody: false,
      },
      {
        requestId: 'missing_request',
        includeRequestBody: false,
        includeResponseBody: true,
      },
      {
        requestId: oldest.requestId,
        includeRequestBody: false,
        includeResponseBody: false,
      },
      {
        requestId: newest.requestId,
        includeRequestBody: true,
        includeResponseBody: true,
      },
    ]);

    expect(results.map(({ requestId }) => requestId)).toEqual([
      newest.requestId,
      'missing_request',
      oldest.requestId,
    ]);
    expect(results[0]).toMatchObject({
      ok: true,
      request: {
        requestBody: { included: false },
        responseBody: { included: false },
      },
    });
    expect(results[1]).toEqual({
      ok: false,
      requestId: 'missing_request',
      code: 'NETWORK_REQUEST_NOT_FOUND',
      message: 'The captured network request is no longer available.',
    });
    expect(results[2]).toMatchObject({ ok: true, requestId: oldest.requestId });
    expect(debuggerTransport.send).not.toHaveBeenCalledWith(
      expect.anything(),
      'Network.getRequestPostData',
      expect.anything(),
    );
    expect(debuggerTransport.send).not.toHaveBeenCalledWith(
      expect.anything(),
      'Network.getResponseBody',
      expect.anything(),
    );
  });

  it('fetches bodies only on demand and redacts headers, query values, and JSON secrets', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    request(
      debuggerTransport,
      'cdp_body',
      'https://api.test/items?access_token=secret&view=compact',
      {},
      {
        method: 'POST',
        hasPostData: true,
        headers: { 'Content-Type': 'application/json' },
      },
    );
    response(debuggerTransport, 'cdp_body');
    const [summary] = await capture.list(7, '', 10, 'recent');
    if (!summary) throw new Error('Expected captured request.');

    const [metadataResult] = await capture.get(7, [
      {
        requestId: summary.requestId,
        includeRequestBody: false,
        includeResponseBody: false,
      },
    ]);
    if (!metadataResult?.ok) throw new Error('Expected captured request details.');
    const metadata = metadataResult.request;
    expect(debuggerTransport.send).not.toHaveBeenCalledWith(
      expect.anything(),
      'Network.getRequestPostData',
      expect.anything(),
    );
    expect(debuggerTransport.send).not.toHaveBeenCalledWith(
      expect.anything(),
      'Network.getResponseBody',
      expect.anything(),
    );
    expect(metadata).toMatchObject({
      requestBody: { included: false, available: true },
      responseBody: { included: false, available: true },
    });

    const [detailsResult] = await capture.get(7, [
      {
        requestId: summary.requestId,
        includeRequestBody: true,
        includeResponseBody: true,
      },
    ]);
    if (!detailsResult?.ok) throw new Error('Expected captured request details.');
    const details = detailsResult.request;
    expect(debuggerTransport.send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Network.getRequestPostData',
      {
        requestId: 'cdp_body',
      },
    );
    expect(debuggerTransport.send).toHaveBeenCalledWith({ tabId: 7 }, 'Network.getResponseBody', {
      requestId: 'cdp_body',
    });
    expect(details.requestHeaders).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(details.responseHeaders).toEqual({
      'Content-Type': 'application/json',
      'X-Trace': 'trace_1',
    });
    expect(details.requestBody).toMatchObject({
      included: true,
      available: true,
      encoding: 'utf8',
      truncated: false,
    });
    expect(details.requestBody.text).toContain('"password":"[redacted]"');
    expect(details.requestBody.text).toContain('"value":"request-visible"');
    expect(details.responseBody).toMatchObject({
      included: true,
      available: true,
      encoding: 'utf8',
      truncated: false,
    });
    expect(details.responseBody.text).toContain('"accessToken":"[redacted]"');
    expect(details.responseBody.text).toContain('"value":"visible"');
    expect(JSON.stringify(details)).not.toContain('secret');
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(100 * 1_024);
  });

  it('marks binary and unavailable bodies without leaking payloads', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    request(debuggerTransport, 'cdp_binary', 'https://api.test/image');
    response(debuggerTransport, 'cdp_binary');
    const [summary] = await capture.list(7, '', 10, 'recent');
    if (!summary) throw new Error('Expected captured request.');
    debuggerTransport.send.mockResolvedValueOnce({ body: 'private-binary', base64Encoded: true });

    await expect(
      capture.get(7, [
        {
          requestId: summary.requestId,
          includeRequestBody: false,
          includeResponseBody: true,
        },
      ]),
    ).resolves.toMatchObject({
      0: {
        ok: true,
        request: { responseBody: { included: true, available: false, reason: 'binary' } },
      },
    });
    debuggerTransport.send.mockRejectedValueOnce(new Error('private CDP failure'));
    await expect(
      capture.get(7, [
        {
          requestId: summary.requestId,
          includeRequestBody: false,
          includeResponseBody: true,
        },
      ]),
    ).resolves.toMatchObject({
      0: {
        ok: true,
        request: { responseBody: { included: true, available: false, reason: 'unavailable' } },
      },
    });
  });

  it('redacts sensitive URL-encoded request fields fetched on demand', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    request(
      debuggerTransport,
      'cdp_form',
      'https://api.test/form',
      {},
      {
        method: 'POST',
        hasPostData: true,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    const [summary] = await capture.list(7, '', 10, 'recent');
    if (!summary) throw new Error('Expected captured request.');
    debuggerTransport.send.mockResolvedValueOnce({
      postData: 'password=secret&view=compact',
      base64Encoded: false,
    });

    const [result] = await capture.get(7, [
      {
        requestId: summary.requestId,
        includeRequestBody: true,
        includeResponseBody: false,
      },
    ]);

    expect(result).toMatchObject({
      ok: true,
      request: {
        requestBody: {
          included: true,
          available: true,
          text: 'password=%5Bredacted%5D&view=compact',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('bounds aggregate body output when five requests fetch both body sides', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    debuggerTransport.send.mockImplementation(async (_session: DebuggerSession, method: string) => {
      if (method === 'Network.getRequestPostData') {
        return { postData: 'q'.repeat(100_000), base64Encoded: false };
      }
      if (method === 'Network.getResponseBody') {
        return {
          body: JSON.stringify({ value: 'r'.repeat(100_000) }),
          base64Encoded: false,
        };
      }
      return {};
    });
    const largeHeaders = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `X-${'n'.repeat(90)}-${String(index)}`,
        'v'.repeat(400),
      ]),
    );
    for (let index = 0; index < 5; index += 1) {
      const requestId = `cdp_large_${String(index)}`;
      const url = `https://api.test/large/${String(index)}/${'p'.repeat(5_000)}`;
      request(
        debuggerTransport,
        requestId,
        url,
        {},
        {
          method: 'POST',
          hasPostData: true,
          headers: { 'Content-Type': 'text/plain', ...largeHeaders },
        },
      );
      debuggerTransport.event({ tabId: 7 }, 'Network.responseReceived', {
        requestId,
        timestamp: 1.25,
        type: 'Fetch',
        response: {
          url,
          status: 200,
          statusText: 'OK',
          mimeType: 'application/json',
          protocol: 'h2',
          headers: { 'Content-Type': 'application/json', ...largeHeaders },
        },
      });
      debuggerTransport.event({ tabId: 7 }, 'Network.loadingFinished', {
        requestId,
        timestamp: 1.5,
        encodedDataLength: 100_000,
      });
    }
    const entries = await capture.list(7, '', 5, 'recent');

    const results = await capture.get(
      7,
      entries.map(({ requestId }) => ({
        requestId,
        includeRequestBody: true,
        includeResponseBody: true,
      })),
    );
    const browserEnvelope = {
      ok: true,
      tabId: 7,
      url: null,
      data: { results },
      observation: null,
    };

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.some(
        (result) =>
          result.ok &&
          (result.request.requestBody.truncated || result.request.responseBody.truncated),
      ),
    ).toBe(true);
    expect(JSON.stringify(results).length).toBeLessThanOrEqual(80 * 1_024);
    expect(JSON.stringify(browserEnvelope).length).toBeLessThanOrEqual(100 * 1_024);
  });

  it('stops and releases the capture buffer without requiring list or get', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    request(debuggerTransport, 'cdp_1', 'https://api.test/one');

    await expect(capture.stop(7)).resolves.toBeUndefined();
    expect(debuggerTransport.send).toHaveBeenCalledWith({ tabId: 7 }, 'Network.disable');
    expect(debuggerTransport.send).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'session_frame_1' },
      'Network.disable',
    );
    await expect(capture.list(7, '', 10, 'recent')).rejects.toMatchObject({
      code: 'NETWORK_CAPTURE_LOST',
    });
  });

  it('invalidates opaque request IDs on stop and root debugger detach', async () => {
    const debuggerTransport = transport();
    const capture = registry(debuggerTransport);
    await capture.start(7, new AbortController().signal);
    request(debuggerTransport, 'cdp_1', 'https://api.test/one');
    const [summary] = await capture.list(7, '', 10, 'recent');
    if (!summary) throw new Error('Expected captured request.');
    await capture.get(7, [
      {
        requestId: summary.requestId,
        includeRequestBody: false,
        includeResponseBody: false,
      },
    ]);

    await capture.stop(7);
    await expect(
      capture.get(7, [
        {
          requestId: summary.requestId,
          includeRequestBody: false,
          includeResponseBody: false,
        },
      ]),
    ).rejects.toBeInstanceOf(NetworkCaptureError);
    await expect(capture.list(7, '', 10, 'recent')).rejects.toMatchObject({
      code: 'NETWORK_CAPTURE_LOST',
      retryable: true,
    });

    await capture.start(7, new AbortController().signal);
    debuggerTransport.detach({ tabId: 7 });
    await expect(capture.list(7, '', 10, 'recent')).rejects.toMatchObject({
      code: 'NETWORK_CAPTURE_LOST',
    });
  });
});
