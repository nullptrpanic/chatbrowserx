import { describe, expect, it, vi } from 'vitest';
import { parseBrowserToolCall } from '../../src/agent/tools/browser-tool-schema';
import { BrowserToolExecutor } from '../../src/browser/browser-tool-executor';
import { NetworkCaptureError } from '../../src/browser/network/network-capture-registry';
import type { BrowserTabPort } from '../../src/browser/tab-service';

function tabPort(overrides: Partial<BrowserTabPort> = {}): BrowserTabPort {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async (tabId) => ({
      tabId,
      url: 'https://example.com/current',
      title: 'Current page',
      active: true,
    })),
    open: vi.fn(async () => ({
      tabId: 9,
      url: 'about:blank',
      title: '',
      active: true,
    })),
    activate: vi.fn(async (tabId) => ({
      tabId,
      url: 'https://example.com',
      title: '',
      active: true,
    })),
    close: vi.fn(async () => undefined),
    navigate: vi.fn(async (tabId, url) => ({
      tabId,
      url,
      title: '',
      active: true,
    })),
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
  it('resolves the task-bound current tab without querying active tabs', async () => {
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs });

    const result = await executor.execute(
      call('browser_get_current_tab', {}),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(tabs.get).toHaveBeenCalledWith(7);
    expect(tabs.list).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      tabId: 7,
      url: 'https://example.com/current',
      data: { title: 'Current page', active: true, taskBound: true },
      observation: null,
    });
  });

  it('inspects an explicitly selected background tab without activating it', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 8,
        url: 'https://example.com/background',
        data: { mode: 'content', text: 'Background page' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'none' as const,
      })),
    };
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs, observer });

    const result = await executor.execute(
      call('browser_inspect', { tabId: 8, mode: 'content' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(observer.inspect).toHaveBeenCalledWith(8, 'content', expect.any(AbortSignal));
    expect(tabs.activate).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, tabId: 8 });
  });

  it('maps tabId zero to the durable task target', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/current',
        data: { mode: 'content', text: 'Current page' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'none' as const,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const result = await executor.execute(
      call('browser_inspect', { tabId: 0, mode: 'content' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(observer.inspect).toHaveBeenCalledWith(7, 'content', expect.any(AbortSignal));
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, tabId: 7 });
  });

  it('binds a task-scoped call without tabId to the durable current tab', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'content', text: 'Current page' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'none' as const,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const result = await executor.execute(
      call('browser_inspect', { mode: 'content' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(observer.inspect).toHaveBeenCalledWith(7, 'content', expect.any(AbortSignal));
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, tabId: 7 });
  });

  it('does not execute an unbound task-scoped call without a durable current tab', async () => {
    const observer = { inspect: vi.fn() };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const result = await executor.execute(
      call('browser_inspect', { mode: 'content' }),
      new AbortController().signal,
    );

    expect(observer.inspect).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      code: 'CURRENT_TAB_UNAVAILABLE',
    });
  });

  it('passes the trusted bound tab to the action runtime', async () => {
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click', dispatched: true },
        observation: { targetPresent: true },
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), actions });

    await executor.execute(
      call('browser_click', { ref: 'ref_1', button: 'left', count: 1 }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({ tabId: 7, ref: 'ref_1' }),
      }),
      expect.any(AbortSignal),
    );
  });

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

  it('switches only the task target without activating the browser tab', async () => {
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs });

    const result = await executor.execute(
      call('browser_switch_tab', { tabId: 8 }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(tabs.get).toHaveBeenCalledWith(8);
    expect(tabs.activate).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, tabId: 8 });
  });

  it('returns a stable failure result without exposing tab errors', async () => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort({
        reload: vi.fn(async () => {
          throw Object.assign(new Error('Raw Chrome target details'), {
            code: 'LOAD_TIMEOUT',
          });
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
        debuggerSession: 'none' as const,
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

  it('retains and releases an ephemeral native interactive inspection immediately', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'interactive' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      sessions,
    });

    await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
      { currentTabId: 7, sessionOwnerId: 'runner_1' },
    );

    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1:operation');
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1:operation');
  });

  it('detaches after inspection and reattaches only for the stable-ref action', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'interactive' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click', dispatched: true },
        observation: { targetPresent: true },
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
      sessions,
    });
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
      context,
    );
    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1:operation');
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1:operation');

    await executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
      context,
    );

    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1:action');
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1:action');
  });

  it('releases an ephemeral screenshot session after capture', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'screenshot' },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      sessions,
    });

    await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'screenshot' }),
      new AbortController().signal,
      { currentTabId: 7, sessionOwnerId: 'runner_1' },
    );

    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1:operation');
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1:operation');
  });

  it('maps coordinates from a downscaled screenshot back to the CSS viewport', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 1000,
          height: 500,
          viewportWidth: 2000,
          viewportHeight: 1000,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(
      call('browser_click_point', { x: 250, y: 100, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({ tabId: 7, x: 500, y: 200 }),
      }),
      signal,
    );
  });

  it('maps both drag endpoints from screenshot pixels to the CSS viewport', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 720,
          height: 360,
          viewportWidth: 1440,
          viewportHeight: 720,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'drag_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(
      call('browser_drag_point', { fromX: 10, fromY: 20, toX: 100, toY: 120 }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          tabId: 7,
          fromX: 20,
          fromY: 40,
          toX: 200,
          toY: 240,
        }),
      }),
      signal,
    );
  });

  it('uses a screenshot coordinate mapping for only the next page action', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 500,
          height: 250,
          viewportWidth: 1000,
          viewportHeight: 500,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const receivedArguments: ReturnType<typeof call>['arguments'][] = [];
    const actions = {
      execute: vi.fn(async (received: ReturnType<typeof call>) => {
        receivedArguments.push(received.arguments);
        return {
          tabId: 7,
          url: 'https://example.com',
          data: { action: 'click_point', dispatched: true },
          observation: null,
        };
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );
    await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(receivedArguments[0]).toMatchObject({ x: 20, y: 40 });
    expect(receivedArguments[1]).toMatchObject({ x: 10, y: 20 });
  });

  it('drops screenshot coordinate state when the task runner is released', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 500,
          height: 250,
          viewportWidth: 1000,
          viewportHeight: 500,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.release('runner_1');
    await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: expect.objectContaining({ x: 10, y: 20 }) }),
      signal,
    );
  });

  it.each([
    ['navigation', 'browser_navigate', { url: 'https://other.test' }],
    ['reload', 'browser_reload', {}],
  ])('drops screenshot coordinate state when %s replaces the page', async (_label, name, input) => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 500,
          height: 250,
          viewportWidth: 1000,
          viewportHeight: 500,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://other.test',
        data: { action: 'click_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(call(name, input), signal, context);
    await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: expect.objectContaining({ x: 10, y: 20 }) }),
      signal,
    );
  });

  it('returns an actionable failure when the page observation bridge is unavailable', async () => {
    const observer = {
      inspect: vi.fn(async () => {
        throw Object.assign(new Error('private page bridge details'), {
          code: 'PAGE_UNAVAILABLE',
        });
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const output = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'PAGE_UNAVAILABLE',
      message: 'The page observation bridge is unavailable. Reload the page and inspect again.',
      retryable: true,
      needsInspect: false,
    });
    expect(output.output).not.toContain('private page bridge details');
  });

  it('asks for a fresh inspection when the page returns an invalid observation', async () => {
    const observer = {
      inspect: vi.fn(async () => {
        throw Object.assign(new Error('private invalid response details'), {
          code: 'INVALID_PAGE_RESPONSE',
        });
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const output = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'content' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'INVALID_PAGE_RESPONSE',
      message: 'The page returned an invalid observation. Reload the page and inspect again.',
      retryable: true,
      needsInspect: false,
    });
    expect(output.output).not.toContain('private invalid response details');
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
      call('browser_network_list', {
        tabId: 7,
        urlPattern: '/api/',
        limit: 25,
      }),
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
    expect(JSON.parse(started.output)).toMatchObject({
      ok: true,
      data: { generation: 2 },
    });
    expect(JSON.parse(listed.output)).toMatchObject({
      ok: true,
      data: { requests: [{ requestId: 'request_1' }] },
    });
    expect(JSON.parse(details.output)).toMatchObject({
      ok: true,
      data: { request: { requestId: 'request_1' } },
    });
    expect(JSON.parse(stopped.output)).toMatchObject({
      ok: true,
      data: { stopped: true },
    });
  });

  it('keeps the debugger only while network capture is active', async () => {
    const network = {
      start: vi.fn(async () => ({
        tabId: 7,
        generation: 2,
        alreadyActive: false,
        message: 'Capture started.',
      })),
      list: vi.fn(),
      get: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      network,
      sessions,
    });
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await executor.execute(
      call('browser_network_start', { tabId: 7 }),
      new AbortController().signal,
      context,
    );
    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1:network');
    expect(sessions.releaseOwner).not.toHaveBeenCalledWith('runner_1:network');

    await executor.execute(
      call('browser_network_stop', { tabId: 7 }),
      new AbortController().signal,
      context,
    );
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1:network');
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
    [
      'TYPE_VERIFICATION_FAILED',
      {
        code: 'TYPE_VERIFICATION_FAILED',
        message: 'The page did not retain the requested text. Inspect the editor and try again.',
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
    const tool = (() => {
      if (code === 'STALE_REF') {
        return call('browser_click', {
          tabId: 7,
          ref: 'ref_1',
          button: 'left',
          count: 1,
        });
      }
      if (code === 'TYPE_VERIFICATION_FAILED') {
        return call('browser_type', {
          tabId: 7,
          ref: 'ref_1',
          text: 'hello',
          replace: true,
          submit: false,
        });
      }
      return call('browser_click_point', {
        tabId: 7,
        x: 20,
        y: 20,
        button: 'left',
        count: 1,
      });
    })();

    const output = await executor.execute(tool, new AbortController().signal);

    expect(JSON.parse(output.output)).toEqual({ ok: false, ...expected });
    expect(output.output).not.toContain('private page details');
  });
});
