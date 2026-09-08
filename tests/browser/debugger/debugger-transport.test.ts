import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChromeDebuggerTransport,
  DebuggerTransportError,
  withDebuggerSignal,
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
  afterEach(() => vi.useRealTimers());

  it('aborts a pending native command and ignores its late rejection', async () => {
    const api = createDebuggerApi();
    let rejectNative: (error: Error) => void = () => undefined;
    vi.mocked(api.sendCommand).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectNative = reject;
        }),
    );
    const transport = new ChromeDebuggerTransport(api);
    const controller = new AbortController();
    const result = transport.send(
      { tabId: 12 },
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved' },
      controller.signal,
    );
    const aborted = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await aborted;
    rejectNative(new Error('late native failure'));
    await Promise.resolve();
    expect(api.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a new command with an already aborted signal', async () => {
    const api = createDebuggerApi();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ChromeDebuggerTransport(api).send(
        { tabId: 12 },
        'Input.insertText',
        { text: 'must not be inserted' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.sendCommand).not.toHaveBeenCalled();
  });

  it('stops follow-on commands in the timed-out scope but still releases resources', async () => {
    vi.useFakeTimers();
    const api = createDebuggerApi();
    vi.mocked(api.sendCommand).mockImplementationOnce(() => new Promise(() => undefined));
    const transport = new ChromeDebuggerTransport(api);
    const scoped = withDebuggerSignal(transport, new AbortController().signal);
    const pending = scoped.send({ tabId: 12 }, 'Input.insertText', { text: 'one dispatch' });
    const outcome = expect(pending).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    await expect(
      scoped.send({ tabId: 12 }, 'Input.insertText', { text: 'unsafe fallback' }),
    ).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
    await scoped.send({ tabId: 12 }, 'Runtime.releaseObject', { objectId: 'owned-object' });
    expect(vi.mocked(api.sendCommand).mock.calls.map(([, method]) => method)).toEqual([
      'Input.insertText',
      'Runtime.releaseObject',
    ]);
    await expect(
      withDebuggerSignal(transport, new AbortController().signal).send(
        { tabId: 12 },
        'DOM.getDocument',
      ),
    ).resolves.toEqual({ nodeId: 42 });
  });

  it.each(['attach', 'detach', 'sendCommand'] as const)(
    'bounds a stalled native %s call',
    async (method) => {
      vi.useFakeTimers();
      const api = createDebuggerApi();
      vi.mocked(api[method]).mockImplementationOnce(() => new Promise(() => undefined));
      const transport = new ChromeDebuggerTransport(api);
      const pending =
        method === 'sendCommand'
          ? transport.send({ tabId: 12 }, 'DOM.getDocument')
          : transport[method](12);
      let settled = false;
      const outcome = pending.catch((error: unknown) => {
        settled = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(true);
      expect(await outcome).toBeInstanceOf(DebuggerTransportError);
      expect(api[method]).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('preserves an uncertain timeout when cleanup also fails', async () => {
    vi.useFakeTimers();
    const api = createDebuggerApi();
    vi.mocked(api.sendCommand)
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValueOnce(new Error('cleanup failed'));
    const scoped = withDebuggerSignal(
      new ChromeDebuggerTransport(api),
      new AbortController().signal,
    );
    const pending = scoped.send({ tabId: 12 }, 'Input.insertText', { text: 'one dispatch' });
    const outcome = expect(pending).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(60_000);
    await outcome;
    await expect(
      scoped.send({ tabId: 12 }, 'Runtime.releaseObject', { objectId: 'owned-object' }),
    ).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT' });
    expect(api.sendCommand).toHaveBeenCalledTimes(2);
  });

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
