import { describe, expect, it, vi } from 'vitest';
import type {
  DebuggerDetachListener,
  DebuggerEventListener,
  DebuggerSession,
  DebuggerTransport,
} from '../../../src/browser/debugger/debugger-transport';
import {
  TargetSessionRegistry,
  TargetSessionRegistryError,
} from '../../../src/browser/debugger/target-session-registry';

function transport(): DebuggerTransport & {
  emitEvent(
    session: DebuggerSession,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): void;
  emitDetach(session: DebuggerSession, reason: string): void;
} {
  const eventListeners = new Set<DebuggerEventListener>();
  const detachListeners = new Set<DebuggerDetachListener>();
  return {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    send: vi.fn(async () => ({})) as unknown as DebuggerTransport['send'],
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onDetach(listener) {
      detachListeners.add(listener);
      return () => detachListeners.delete(listener);
    },
    emitEvent(session, method, params) {
      for (const listener of eventListeners) listener(session, method, params);
    },
    emitDetach(session, reason) {
      for (const listener of detachListeners) listener(session, reason);
    },
  };
}

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
} as const;

describe('TargetSessionRegistry', () => {
  it('single-flights root attachment and enables the bounded domain set', async () => {
    const debuggerTransport = transport();
    const registry = new TargetSessionRegistry(debuggerTransport);

    const [first, second] = await Promise.all([
      registry.ensure(7, new AbortController().signal),
      registry.ensure(7, new AbortController().signal),
    ]);

    expect(debuggerTransport.attach).toHaveBeenCalledOnce();
    expect(debuggerTransport.attach).toHaveBeenCalledWith(7);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ tabId: 7, generation: 1, root: { tabId: 7 } });
    expect(debuggerTransport.send).toHaveBeenCalledWith(
      { tabId: 7 },
      'Target.setAutoAttach',
      AUTO_ATTACH,
    );
    for (const method of ['Page.enable', 'DOM.enable', 'Accessibility.enable', 'Runtime.enable']) {
      expect(debuggerTransport.send).toHaveBeenCalledWith({ tabId: 7 }, method);
    }
  });

  it('registers and recursively configures nested OOPIF sessions', async () => {
    const debuggerTransport = transport();
    const registry = new TargetSessionRegistry(debuggerTransport);
    await registry.ensure(7, new AbortController().signal);

    debuggerTransport.emitEvent({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'session_child',
      targetInfo: { targetId: 'target_child', type: 'iframe', url: 'https://frame.test' },
    });
    debuggerTransport.emitEvent(
      { tabId: 7, sessionId: 'session_child' },
      'Target.attachedToTarget',
      {
        sessionId: 'session_nested',
        targetInfo: { targetId: 'target_nested', type: 'iframe', url: 'https://nested.test' },
      },
    );

    await vi.waitFor(() =>
      expect(debuggerTransport.send).toHaveBeenCalledWith(
        { tabId: 7, sessionId: 'session_nested' },
        'Target.setAutoAttach',
        AUTO_ATTACH,
      ),
    );
    const snapshot = await registry.ensure(7, new AbortController().signal);
    expect([...snapshot.children.keys()]).toEqual(['target_child', 'target_nested']);
    expect(snapshot.children.get('target_nested')).toMatchObject({
      targetId: 'target_nested',
      parentSessionId: 'session_child',
      session: { tabId: 7, sessionId: 'session_nested' },
    });
    expect(registry.sessionForTarget(7, 'target_nested')).toEqual({
      tabId: 7,
      sessionId: 'session_nested',
    });
  });

  it('does not expose an attached OOPIF until its CDP domains are configured', async () => {
    const debuggerTransport = transport();
    let childConfigured = false;
    let releaseChildConfiguration: (() => void) | undefined;
    const childConfiguration = new Promise<void>((resolve) => {
      releaseChildConfiguration = resolve;
    });
    vi.mocked(debuggerTransport.send).mockImplementation(async (session, method) => {
      if (session.sessionId === undefined && method === 'Target.setAutoAttach') {
        queueMicrotask(() => {
          debuggerTransport.emitEvent({ tabId: 7 }, 'Target.attachedToTarget', {
            sessionId: 'session_child',
            targetInfo: { targetId: 'target_child', type: 'iframe', url: 'https://frame.test' },
          });
        });
      }
      if (session.sessionId === 'session_child' && method === 'Accessibility.enable') {
        await childConfiguration;
        childConfigured = true;
      }
      return {};
    });
    const registry = new TargetSessionRegistry(debuggerTransport);

    const ensuring = registry.ensure(7, new AbortController().signal);
    const beforeChildConfiguration = await Promise.race([
      ensuring.then(() => 'resolved' as const),
      new Promise<'pending'>((resolve) => globalThis.setTimeout(() => resolve('pending'), 10)),
    ]);
    expect(childConfigured).toBe(false);
    expect(beforeChildConfiguration).toBe('pending');

    releaseChildConfiguration?.();
    const snapshot = await ensuring;
    expect(childConfigured).toBe(true);
    expect(snapshot.children.has('target_child')).toBe(true);
  });

  it('invalidates child and root state without affecting another tab', async () => {
    const debuggerTransport = transport();
    const registry = new TargetSessionRegistry(debuggerTransport);
    await registry.ensure(7, new AbortController().signal);
    const other = await registry.ensure(8, new AbortController().signal);
    debuggerTransport.emitEvent({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'session_child',
      targetInfo: { targetId: 'target_child', type: 'iframe', url: 'https://frame.test' },
    });
    await vi.waitFor(() => expect(registry.sessionForTarget(7, 'target_child')).toBeDefined());
    const beforeDetach = await registry.ensure(7, new AbortController().signal);

    debuggerTransport.emitEvent({ tabId: 7 }, 'Target.detachedFromTarget', {
      sessionId: 'session_child',
      targetId: 'target_child',
    });

    const afterChildDetach = await registry.ensure(7, new AbortController().signal);
    expect(afterChildDetach.generation).toBeGreaterThan(beforeDetach.generation);
    expect(registry.sessionForTarget(7, 'target_child')).toBeUndefined();
    expect(await registry.ensure(8, new AbortController().signal)).toEqual(other);

    debuggerTransport.emitDetach({ tabId: 7 }, 'target_closed');
    const reattached = await registry.ensure(7, new AbortController().signal);
    expect(reattached.generation).toBeGreaterThan(afterChildDetach.generation);
    expect(debuggerTransport.attach).toHaveBeenCalledTimes(3);
  });

  it('advances the ref generation when any attached frame navigates', async () => {
    const debuggerTransport = transport();
    const registry = new TargetSessionRegistry(debuggerTransport);
    const beforeNavigation = await registry.ensure(7, new AbortController().signal);

    debuggerTransport.emitEvent({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'root-frame', url: 'https://next.test' },
    });

    const afterNavigation = await registry.ensure(7, new AbortController().signal);
    expect(afterNavigation.generation).toBeGreaterThan(beforeNavigation.generation);
  });

  it('releases one root attachment and redacts debugger ownership failures', async () => {
    const debuggerTransport = transport();
    const registry = new TargetSessionRegistry(debuggerTransport);
    await registry.ensure(7, new AbortController().signal);
    await registry.release(7);

    expect(debuggerTransport.detach).toHaveBeenCalledWith(7);

    vi.mocked(debuggerTransport.attach).mockRejectedValueOnce(
      new Error('Another debugger owns sensitive target details'),
    );
    vi.mocked(debuggerTransport.detach).mockRejectedValueOnce(new Error('Not owned'));
    let thrown: unknown;
    try {
      await registry.ensure(9, new AbortController().signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TargetSessionRegistryError);
    expect(thrown).toMatchObject({ code: 'DEBUGGER_UNAVAILABLE' });
    expect(String(thrown)).not.toContain('sensitive target details');
  });

  it('reattaches once after releasing an attachment left by the same extension', async () => {
    const debuggerTransport = transport();
    vi.mocked(debuggerTransport.attach)
      .mockRejectedValueOnce(new Error('Already attached'))
      .mockResolvedValueOnce(undefined);
    const registry = new TargetSessionRegistry(debuggerTransport);

    await expect(registry.ensure(7, new AbortController().signal)).resolves.toMatchObject({
      tabId: 7,
      root: { tabId: 7 },
    });

    expect(debuggerTransport.attach).toHaveBeenCalledTimes(2);
    expect(debuggerTransport.detach).toHaveBeenCalledOnce();
    expect(debuggerTransport.detach).toHaveBeenCalledWith(7);
  });

  it('detaches only after the last task owner releases a shared tab', async () => {
    const debuggerTransport = transport();
    const registry = new TargetSessionRegistry(debuggerTransport);
    await registry.retain(7, 'runner_1');
    await registry.ensure(7, new AbortController().signal);
    await registry.retain(7, 'runner_2');

    await registry.releaseOwner('runner_1');
    expect(debuggerTransport.detach).not.toHaveBeenCalled();
    expect(await registry.ensure(7, new AbortController().signal)).toMatchObject({ tabId: 7 });

    await registry.releaseOwner('runner_2');
    expect(debuggerTransport.detach).toHaveBeenCalledOnce();
    expect(debuggerTransport.detach).toHaveBeenCalledWith(7);
  });

  it('does not attach when the action is already aborted', async () => {
    const debuggerTransport = transport();
    const registry = new TargetSessionRegistry(debuggerTransport);
    const controller = new AbortController();
    controller.abort();

    await expect(registry.ensure(7, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(debuggerTransport.attach).not.toHaveBeenCalled();
  });
});
