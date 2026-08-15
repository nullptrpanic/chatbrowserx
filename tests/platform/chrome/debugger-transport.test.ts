import { describe, expect, it, vi } from 'vitest';
import {
  ChromeDebuggerTransport,
  DebuggerTransportError,
  type ChromeDebuggerApi,
} from '../../../src/platform/chrome/debugger-transport';
import type {
  ChromeDebuggerDetachListener,
  ChromeDebuggerEventListener,
} from '../../../src/platform/chrome/debugger-events';

class TestChromeEvent<TListener> {
  readonly listeners: TListener[] = [];

  /**
   * Captures a debugger listener for explicit lifecycle simulation.
   */
  addListener(listener: TListener): void {
    this.listeners.push(listener);
  }
}

/**
 * Creates an inspectable debugger API with successful promise operations.
 */
function buildDebuggerApi() {
  const events = {
    event: new TestChromeEvent<ChromeDebuggerEventListener>(),
    detach: new TestChromeEvent<ChromeDebuggerDetachListener>(),
  };
  const attach = vi.fn<ChromeDebuggerApi['attach']>(async () => undefined);
  const detach = vi.fn<ChromeDebuggerApi['detach']>(async () => undefined);
  const sendCommand = vi.fn<ChromeDebuggerApi['sendCommand']>(async () => ({ result: true }));
  const api: ChromeDebuggerApi = {
    attach,
    detach,
    sendCommand,
    onEvent: events.event,
    onDetach: events.detach,
  };
  return { api, events, attach, detach, sendCommand };
}

describe('ChromeDebuggerTransport', () => {
  it('attaches once, enables required domains, and reference-counts one owner', async () => {
    const debuggerApi = buildDebuggerApi();
    const transport = new ChromeDebuggerTransport(debuggerApi.api);

    await transport.acquire(7, 'task_1');
    await transport.acquire(7, 'task_1');

    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(debuggerApi.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3');
    expect(debuggerApi.sendCommand.mock.calls.map((call) => call[1])).toEqual([
      'Page.enable',
      'DOM.enable',
      'Runtime.enable',
      'Accessibility.enable',
      'Target.setAutoAttach',
    ]);
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith({ tabId: 7 }, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    });
    expect(transport.isAttached(7)).toBe(true);

    await transport.release(7, 'task_1');
    expect(debuggerApi.detach).not.toHaveBeenCalled();
    await transport.release(7, 'task_1');
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 7 });
    expect(transport.isAttached(7)).toBe(false);
  });

  it('routes commands through a child target session and sanitizes command failures', async () => {
    const debuggerApi = buildDebuggerApi();
    const transport = new ChromeDebuggerTransport(debuggerApi.api);
    await transport.acquire(7, 'task_1');
    debuggerApi.sendCommand.mockResolvedValueOnce({ nodeId: 44 });

    await expect(
      transport.send<{ nodeId: number }>(7, 'DOM.resolveNode', { backendNodeId: 9 }, 'session_1'),
    ).resolves.toEqual({ nodeId: 44 });
    expect(debuggerApi.sendCommand).toHaveBeenLastCalledWith(
      { tabId: 7, sessionId: 'session_1' },
      'DOM.resolveNode',
      { backendNodeId: 9 },
    );

    debuggerApi.sendCommand.mockRejectedValueOnce(new Error('private protocol payload'));
    await expect(transport.send(7, 'DOM.getBoxModel')).rejects.toEqual(
      expect.objectContaining({ code: 'COMMAND_FAILED' }),
    );
    try {
      await transport.send(7, 'DOM.getBoxModel');
    } catch (error) {
      expect(String(error)).not.toContain('private protocol payload');
    }
  });

  it('tracks recursive iframe sessions and enables each child before exposing it', async () => {
    const debuggerApi = buildDebuggerApi();
    const transport = new ChromeDebuggerTransport(debuggerApi.api);
    await transport.acquire(7, 'task_1');

    debuggerApi.events.event.listeners[0]?.({ tabId: 7 }, 'Target.attachedToTarget', {
      sessionId: 'session_1',
      targetInfo: {
        targetId: 'frame_remote',
        type: 'iframe',
        title: 'Remote frame',
        url: 'https://frame.example/child',
      },
      waitingForDebugger: false,
    });
    debuggerApi.events.event.listeners[0]?.(
      { tabId: 7, sessionId: 'session_1' },
      'Target.attachedToTarget',
      {
        sessionId: 'session_2',
        targetInfo: {
          targetId: 'frame_nested',
          type: 'iframe',
          title: 'Nested frame',
          url: 'https://nested.example/form',
        },
        waitingForDebugger: false,
      },
    );

    await expect(transport.listSessions(7)).resolves.toEqual([
      {
        sessionId: 'session_1',
        targetId: 'frame_remote',
        type: 'iframe',
        url: 'https://frame.example/child',
        title: 'Remote frame',
        parentSessionId: null,
      },
      {
        sessionId: 'session_2',
        targetId: 'frame_nested',
        type: 'iframe',
        url: 'https://nested.example/form',
        title: 'Nested frame',
        parentSessionId: 'session_1',
      },
    ]);
    for (const sessionId of ['session_1', 'session_2']) {
      expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
        { tabId: 7, sessionId },
        'Target.setAutoAttach',
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: 'iframe', exclude: false }],
        },
      );
    }

    debuggerApi.events.event.listeners[0]?.(
      { tabId: 7, sessionId: 'session_1' },
      'Target.detachedFromTarget',
      { sessionId: 'session_2', targetId: 'frame_nested' },
    );
    await expect(transport.listSessions(7)).resolves.toEqual([
      expect.objectContaining({ sessionId: 'session_1' }),
    ]);
  });

  it('clears ownership and notifies subscribers after an external detach', async () => {
    const debuggerApi = buildDebuggerApi();
    const transport = new ChromeDebuggerTransport(debuggerApi.api);
    const listener = vi.fn();
    transport.subscribe(listener);
    await transport.acquire(7, 'task_1');

    debuggerApi.events.event.listeners[0]?.(
      { tabId: 7, sessionId: 'session_1' },
      'Page.frameNavigated',
      { frame: { id: 'frame_1' } },
    );
    debuggerApi.events.detach.listeners[0]?.({ tabId: 7 }, 'target_closed');

    expect(listener).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'protocol_event',
        tabId: 7,
        sessionId: 'session_1',
        method: 'Page.frameNavigated',
      }),
    );
    expect(listener).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: 'detached', tabId: 7, reason: 'target_closed' }),
    );
    expect(transport.isAttached(7)).toBe(false);
    await expect(transport.send(7, 'Page.getNavigationHistory')).rejects.toBeInstanceOf(
      DebuggerTransportError,
    );
  });

  it('normalizes attach failures and leaves no attached state behind', async () => {
    const debuggerApi = buildDebuggerApi();
    debuggerApi.attach.mockRejectedValueOnce(new Error('Another debugger is attached'));
    const transport = new ChromeDebuggerTransport(debuggerApi.api);

    await expect(transport.acquire(7, 'task_1')).rejects.toEqual(
      expect.objectContaining({ code: 'ATTACH_FAILED' }),
    );
    expect(transport.isAttached(7)).toBe(false);
  });
});
