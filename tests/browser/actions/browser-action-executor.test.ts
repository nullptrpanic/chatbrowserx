import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBrowserToolCall } from '../../../src/agent/tools/browser-tool-schema';
import { BrowserActionExecutor } from '../../../src/browser/actions/browser-action-executor';
import type {
  DebuggerSession,
  DebuggerTransport,
} from '../../../src/browser/debugger/debugger-transport';
import type { BrowserSessionSnapshot } from '../../../src/browser/debugger/target-session-registry';
import { ElementRefStore } from '../../../src/browser/observation/element-ref-store';

const SNAPSHOT: BrowserSessionSnapshot = {
  tabId: 7,
  generation: 2,
  root: { tabId: 7 },
  children: new Map(),
};

function call(name: string, arguments_: unknown) {
  return parseBrowserToolCall({
    callId: 'call_1',
    name,
    argumentsJson: JSON.stringify(arguments_),
  });
}

function harness(
  options: {
    readonly pointerRejects?: boolean;
    readonly responder?: (
      session: DebuggerSession,
      method: string,
      params?: Readonly<Record<string, unknown>>,
    ) => unknown;
  } = {},
) {
  const order: string[] = [];
  const send = vi.fn(async (session, method, params) => {
    order.push(`cdp:${method}`);
    if (options.responder) return options.responder(session, method, params);
    if (method === 'Page.getNavigationHistory') {
      return {
        currentIndex: 1,
        entries: [
          {
            id: 1,
            url: 'https://example.test/previous',
            title: 'Previous',
            transitionType: 'link',
          },
          { id: 2, url: 'https://example.test/current', title: 'Current', transitionType: 'link' },
          { id: 3, url: 'https://example.test/next', title: 'Next', transitionType: 'link' },
        ],
      };
    }
    if (method === 'Page.getLayoutMetrics') {
      return { visualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object_1' } };
    return {};
  }) as unknown as DebuggerTransport['send'];
  const transport: DebuggerTransport = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    send,
    onEvent: () => () => undefined,
    onDetach: () => () => undefined,
  };
  const refs = new ElementRefStore({ create: () => 'ref_1' });
  refs.replaceSnapshot(7, 2, [
    {
      session: { tabId: 7 },
      backendNodeId: 42,
      role: 'button',
      name: 'Continue',
      state: [],
      frame: 'main',
      bounds: { x: 10, y: 20, width: 100, height: 30 },
    },
  ]);
  const pointer = {
    show: vi.fn(async () => {
      order.push('pointer');
      if (options.pointerRejects) throw new Error('Overlay unavailable');
    }),
  };
  const executor = new BrowserActionExecutor({
    sessions: { ensure: vi.fn(async () => SNAPSHOT) },
    transport,
    refs,
    pointer,
  });
  return { executor, transport, send: vi.mocked(send), pointer, order };
}

afterEach(() => vi.useRealTimers());

describe('BrowserActionExecutor', () => {
  it('animates first, dispatches one click sequence, and returns mechanical verification', async () => {
    const { executor, send, pointer, order } = harness();

    const result = await executor.execute(
      call('browser_click', { tabId: 7, ref: 'ref_1', button: 'left', count: 1 }),
      new AbortController().signal,
    );

    expect(pointer.show).toHaveBeenCalledWith(7, {
      x: 60,
      y: 35,
      fromX: 60,
      fromY: 35,
      effect: 'click',
    });
    expect(order[0]).toBe('pointer');
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      expect.objectContaining({
        type: 'mousePressed',
        x: 60,
        y: 35,
        button: 'left',
        clickCount: 1,
      }),
    );
    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
    expect(result).toMatchObject({
      tabId: 7,
      url: 'https://example.test/current',
      data: { action: 'click', dispatched: true },
      observation: { targetPresent: true },
    });
  });

  it('does not repeat a click when the optional pointer overlay fails', async () => {
    const { executor, send } = harness({ pointerRejects: true });

    await executor.execute(
      call('browser_click', { tabId: 7, ref: 'ref_1', button: 'left', count: 1 }),
      new AbortController().signal,
    );

    expect(
      send.mock.calls.filter(
        ([, method, params]) =>
          method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed',
      ),
    ).toHaveLength(1);
  });

  it('focuses, replaces, inserts bounded text, and optionally submits', async () => {
    const { executor, send } = harness();

    await executor.execute(
      call('browser_type', {
        tabId: 7,
        ref: 'ref_1',
        text: 'hello',
        replace: true,
        submit: true,
      }),
      new AbortController().signal,
    );

    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'DOM.focus', { backendNodeId: 42 });
    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'Input.insertText', { text: 'hello' });
    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Input.dispatchKeyEvent',
      expect.objectContaining({ type: 'keyDown', key: 'Enter' }),
    );
  });

  it('validates screenshot coordinates against the current viewport', async () => {
    const { executor, send } = harness();

    await expect(
      executor.execute(
        call('browser_click_point', { tabId: 7, x: 801, y: 20, button: 'left', count: 1 }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'POINT_OUT_OF_VIEWPORT' });
    expect(send.mock.calls.some(([, method]) => method === 'Input.dispatchMouseEvent')).toBe(false);
  });

  it('navigates logical browser history without synthesizing shortcuts', async () => {
    const { executor, send } = harness();

    await executor.execute(
      call('browser_keypress', { tabId: 7, keys: 'BROWSER_BACK' }),
      new AbortController().signal,
    );

    expect(send).toHaveBeenCalledWith({ tabId: 7 }, 'Page.navigateToHistoryEntry', { entryId: 1 });
    expect(send.mock.calls.some(([, method]) => method === 'Input.dispatchKeyEvent')).toBe(false);
  });

  it('selects through one fixed internal function and page-owned value argument', async () => {
    const { executor, send } = harness();

    await executor.execute(
      call('browser_select', { tabId: 7, ref: 'ref_1', value: 'pro' }),
      new AbortController().signal,
    );

    expect(send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Runtime.callFunctionOn',
      expect.objectContaining({
        objectId: 'object_1',
        arguments: [{ value: 'pro' }],
        functionDeclaration: expect.stringContaining('HTMLSelectElement'),
      }),
    );
  });

  it('waits for an explicit bounded delay without dispatching input', async () => {
    vi.useFakeTimers();
    const { executor, send } = harness();
    const waiting = executor.execute(
      call('browser_wait', { tabId: 7, condition: 'delay', timeoutMs: 250 }),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(250);

    await expect(waiting).resolves.toMatchObject({ data: { action: 'wait', condition: 'delay' } });
    expect(send.mock.calls.some(([, method]) => method.startsWith('Input.'))).toBe(false);
  });
});
