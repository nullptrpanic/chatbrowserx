import { describe, expect, it, vi } from 'vitest';
import { parseBrowserToolCall } from '../../src/agent/tools/browser-tool-schema';
import { BrowserToolExecutor } from '../../src/browser/browser-tool-executor';
import { NetworkCaptureError } from '../../src/browser/network/network-capture-registry';
import type { BrowserTabPort } from '../../src/browser/tab-service';

function tabPort(overrides: Partial<BrowserTabPort> = {}): BrowserTabPort {
  return {
    list: vi.fn(async () => []),
    open: vi.fn(async () => ({ tabId: 9, url: 'about:blank', title: '', active: true })),
    activate: vi.fn(async (tabId) => ({
      tabId,
      url: 'https://example.com',
      title: '',
      active: true,
    })),
    close: vi.fn(async () => undefined),
    navigate: vi.fn(async (tabId, url) => ({ tabId, url, title: '', active: true })),
    reload: vi.fn(async (tabId) => ({
      tabId,
      url: 'https://example.com',
      title: '',
      active: true,
    })),
    ...overrides,
  };
}

function call(name: string, arguments_: unknown) {
  return parseBrowserToolCall({
    callId: 'call_1',
    name,
    argumentsJson: JSON.stringify(arguments_),
  });
}

describe('BrowserToolExecutor', () => {
  it('dispatches a tab operation and returns one bounded JSON envelope', async () => {
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs });

    const result = await executor.execute(
      call('browser_open_tab', { url: 'about:blank', activate: true }),
      new AbortController().signal,
    );

    expect(tabs.open).toHaveBeenCalledWith('about:blank', true);
    expect(result.attachmentIds).toEqual([]);
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      tabId: 9,
      url: 'about:blank',
      data: { title: '', active: true },
      observation: null,
    });
    expect(result.output.length).toBeLessThanOrEqual(64 * 1_024);
  });

  it('returns a stable failure result without exposing tab errors', async () => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort({
        reload: vi.fn(async () => {
          throw Object.assign(new Error('Raw Chrome target details'), { code: 'LOAD_TIMEOUT' });
        }),
      }),
    });

    const result = await executor.execute(
      call('browser_reload', { tabId: 7 }),
      new AbortController().signal,
    );

    expect(JSON.parse(result.output)).toEqual({
      ok: false,
      code: 'LOAD_TIMEOUT',
      message: 'The page did not become ready in time.',
      retryable: true,
      needsInspect: true,
    });
    expect(result.output).not.toContain('Raw Chrome target details');
  });

  it('reports page operations as unavailable until their runtime is connected', async () => {
    const executor = new BrowserToolExecutor({ tabs: tabPort() });

    const result = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'content' }),
      new AbortController().signal,
    );

    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      code: 'OPERATION_UNAVAILABLE',
      retryable: false,
    });
  });

  it('dispatches inspect through the semantic observer and preserves its envelope', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'interactive', elements: [], truncated: false },
        observation: null,
        attachmentIds: [],
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const output = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
    );

    expect(observer.inspect).toHaveBeenCalledWith(7, 'interactive', expect.any(AbortSignal));
    expect(JSON.parse(output.output)).toEqual({
      ok: true,
      tabId: 7,
      url: 'https://example.com',
      data: { mode: 'interactive', elements: [], truncated: false },
      observation: null,
    });
  });

  it('dispatches interaction calls through the action runtime', async () => {
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'hover', dispatched: true },
        observation: { targetPresent: true },
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), actions });
    const browserCall = call('browser_hover', { tabId: 7, ref: 'ref_1' });

    const output = await executor.execute(browserCall, new AbortController().signal);

    expect(actions.execute).toHaveBeenCalledWith(browserCall, expect.any(AbortSignal));
    expect(JSON.parse(output.output)).toMatchObject({
      ok: true,
      data: { action: 'hover', dispatched: true },
    });
  });

  it('dispatches the four bounded network operations without implicitly reloading', async () => {
    const requestSummary = {
      requestId: 'request_1',
      url: 'https://api.test/',
      method: 'GET',
      resourceType: 'Fetch',
      status: 200,
      mimeType: 'application/json',
      startedAt: 1_000,
      durationMs: 20,
      encodedDataLength: 100,
      completed: true,
      failed: false,
      redirected: false,
      fromCache: false,
    };
    const network = {
      start: vi.fn(async () => ({
        tabId: 7,
        generation: 2,
        alreadyActive: false,
        message: 'Capture started. Earlier traffic is unavailable.',
      })),
      list: vi.fn(async () => [requestSummary]),
      get: vi.fn(async () => ({
        ...requestSummary,
        requestHeaders: {},
        responseHeaders: {},
        protocol: 'h2',
        statusText: 'OK',
        requestBodyIncluded: false as const,
        body: {
          included: true,
          available: true,
          encoding: 'utf8' as const,
          text: '{}',
          truncated: false,
        },
      })),
      stop: vi.fn(async () => undefined),
    };
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs, network });
    const signal = new AbortController().signal;

    const started = await executor.execute(call('browser_network_start', { tabId: 7 }), signal);
    const listed = await executor.execute(
      call('browser_network_list', { tabId: 7, urlPattern: '/api/', limit: 25 }),
      signal,
    );
    const details = await executor.execute(
      call('browser_network_get', {
        tabId: 7,
        requestId: 'request_1',
        includeBody: true,
      }),
      signal,
    );
    const stopped = await executor.execute(call('browser_network_stop', { tabId: 7 }), signal);

    expect(network.start).toHaveBeenCalledWith(7, signal);
    expect(network.list).toHaveBeenCalledWith(7, '/api/', 25);
    expect(network.get).toHaveBeenCalledWith(7, 'request_1', true);
    expect(network.stop).toHaveBeenCalledWith(7);
    expect(tabs.reload).not.toHaveBeenCalled();
    expect(JSON.parse(started.output)).toMatchObject({ ok: true, data: { generation: 2 } });
    expect(JSON.parse(listed.output)).toMatchObject({
      ok: true,
      data: { requests: [{ requestId: 'request_1' }] },
    });
    expect(JSON.parse(details.output)).toMatchObject({
      ok: true,
      data: { request: { requestId: 'request_1' } },
    });
    expect(JSON.parse(stopped.output)).toMatchObject({ ok: true, data: { stopped: true } });
  });

  it('preserves retryable network-capture loss so the model can start capture again', async () => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      network: {
        start: vi.fn(),
        list: vi.fn(async () => {
          throw new NetworkCaptureError('NETWORK_CAPTURE_LOST', 'private capture state', true);
        }),
        get: vi.fn(),
        stop: vi.fn(),
      },
    });

    const output = await executor.execute(
      call('browser_network_list', { tabId: 7, urlPattern: '', limit: 25 }),
      new AbortController().signal,
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'NETWORK_CAPTURE_LOST',
      message: 'Network capture was lost. Start capture again.',
      retryable: true,
      needsInspect: false,
    });
    expect(output.output).not.toContain('private capture state');
  });

  it.each([
    [
      'STALE_REF',
      {
        code: 'STALE_REF',
        message: 'The element reference is stale. Inspect interactive elements again.',
        retryable: true,
        needsInspect: true,
      },
    ],
    [
      'POINT_OUT_OF_VIEWPORT',
      {
        code: 'POINT_OUT_OF_VIEWPORT',
        message: 'The point is outside the current viewport. Take a new screenshot.',
        retryable: true,
        needsInspect: true,
      },
    ],
  ])('preserves actionable %s recovery guidance', async (code, expected) => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      actions: {
        execute: vi.fn(async () => {
          throw Object.assign(new Error('private page details'), { code });
        }),
      },
    });
    const tool =
      code === 'STALE_REF'
        ? call('browser_click', { tabId: 7, ref: 'ref_1', button: 'left', count: 1 })
        : call('browser_click_point', { tabId: 7, x: 20, y: 20, button: 'left', count: 1 });

    const output = await executor.execute(tool, new AbortController().signal);

    expect(JSON.parse(output.output)).toEqual({ ok: false, ...expected });
    expect(output.output).not.toContain('private page details');
  });
});
