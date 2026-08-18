import { describe, expect, it, vi } from 'vitest';
import {
  ChromeDebuggerTransport,
  DebuggerTransportError,
  type ChromeDebuggerApi,
} from '../../../src/browser/debugger/debugger-transport';

type EventSource = { readonly tabId: number; readonly sessionId?: string };
type EventHandler = (
  source: EventSource,
  method: string,
  params?: Readonly<Record<string, unknown>>,
) => void;
type DetachHandler = (source: EventSource, reason: string) => void;

function createDebuggerApi(): ChromeDebuggerApi & {
  emitEvent(source: EventSource, method: string, params?: Readonly<Record<string, unknown>>): void;
  emitDetach(source: EventSource, reason: string): void;
} {
  const eventHandlers = new Set<EventHandler>();
  const detachHandlers = new Set<DetachHandler>();
  return {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async () => ({ nodeId: 42 })),
    onEvent: {
      addListener: (handler) => eventHandlers.add(handler),
      removeListener: (handler) => eventHandlers.delete(handler),
    },
    onDetach: {
      addListener: (handler) => detachHandlers.add(handler),
      removeListener: (handler) => detachHandlers.delete(handler),
    },
    emitEvent(source, method, params) {
      for (const handler of eventHandlers) handler(source, method, params);
    },
    emitDetach(source, reason) {
      for (const handler of detachHandlers) handler(source, reason);
    },
  };
}

describe('ChromeDebuggerTransport', () => {
  it('attaches with CDP 1.3 and preserves root and child command targets', async () => {
    const api = createDebuggerApi();
    const transport = new ChromeDebuggerTransport(api);

    await transport.attach(12);
    const rootResult = await transport.send<{ readonly nodeId: number }>(
      { tabId: 12 },
      'DOM.getDocument',
      { depth: 2 },
    );
    await transport.send({ tabId: 12, sessionId: 'oopif-7' }, 'Runtime.enable');

    expect(api.attach).toHaveBeenCalledWith({ tabId: 12 }, '1.3');
    expect(api.sendCommand).toHaveBeenNthCalledWith(1, { tabId: 12 }, 'DOM.getDocument', {
      depth: 2,
    });
    expect(api.sendCommand).toHaveBeenNthCalledWith(
      2,
      { tabId: 12, sessionId: 'oopif-7' },
      'Runtime.enable',
      undefined,
    );
    expect(rootResult).toEqual({ nodeId: 42 });
  });

  it('forwards events with their session and removes the exact listener on cleanup', () => {
    const api = createDebuggerApi();
    const transport = new ChromeDebuggerTransport(api);
    const listener = vi.fn();

    const unsubscribe = transport.onEvent(listener);
    api.emitEvent({ tabId: 12, sessionId: 'oopif-7' }, 'Page.frameNavigated', {
      frame: 'child',
    });
    unsubscribe();
    api.emitEvent({ tabId: 12 }, 'Page.loadEventFired');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      { tabId: 12, sessionId: 'oopif-7' },
      'Page.frameNavigated',
      { frame: 'child' },
    );
  });

  it('forwards detach events and removes the exact listener on cleanup', () => {
    const api = createDebuggerApi();
    const transport = new ChromeDebuggerTransport(api);
    const listener = vi.fn();

    const unsubscribe = transport.onDetach(listener);
    api.emitDetach({ tabId: 12, sessionId: 'oopif-7' }, 'target_closed');
    unsubscribe();
    api.emitDetach({ tabId: 12 }, 'canceled_by_user');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ tabId: 12, sessionId: 'oopif-7' }, 'target_closed');
  });

  it.each([
    ['attach', 'ATTACH_FAILED', (transport: ChromeDebuggerTransport) => transport.attach(12)],
    ['detach', 'DETACH_FAILED', (transport: ChromeDebuggerTransport) => transport.detach(12)],
    [
      'sendCommand',
      'COMMAND_FAILED',
      (transport: ChromeDebuggerTransport) => transport.send({ tabId: 12 }, 'DOM.getDocument'),
    ],
  ] as const)('normalizes raw %s failures', async (method, code, invoke) => {
    const api = createDebuggerApi();
    vi.mocked(api[method]).mockRejectedValueOnce(new Error('Sensitive Chrome target detail'));
    const transport = new ChromeDebuggerTransport(api);

    const failure = invoke(transport);

    await expect(failure).rejects.toBeInstanceOf(DebuggerTransportError);
    await expect(failure).rejects.toMatchObject({ code });
    await expect(failure).rejects.not.toThrow(/Sensitive Chrome target detail/);
  });

  it('rejects malformed targets before calling Chrome', async () => {
    const api = createDebuggerApi();
    const transport = new ChromeDebuggerTransport(api);

    await expect(transport.attach(-1)).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(
      transport.send({ tabId: 12, sessionId: '' }, 'Runtime.enable'),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(transport.send({ tabId: 12 }, '')).rejects.toMatchObject({
      code: 'INVALID_COMMAND',
    });

    expect(api.attach).not.toHaveBeenCalled();
    expect(api.sendCommand).not.toHaveBeenCalled();
  });
});
