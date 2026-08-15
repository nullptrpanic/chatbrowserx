import { describe, expect, it } from 'vitest';
import {
  CdpActionDriver,
  type CdpActionCommandPort,
} from '../../../src/browser/act/cdp-action-driver';
import type { ActionDriverContext } from '../../../src/browser/act/action-driver';
import type { ObservedElement } from '../../../src/browser/contracts/observation';
import { createElementTarget } from '../../../src/browser/contracts/target';

class StubActionTransport implements CdpActionCommandPort {
  readonly calls: Array<{
    readonly method: string;
    readonly params: object | undefined;
    readonly sessionId: string | undefined;
  }> = [];

  /** Records real-input CDP commands and returns a stable target box model. */
  async send<TResult>(
    _tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<TResult> {
    this.calls.push({ method, params, sessionId });
    if (method === 'DOM.getBoxModel') {
      return {
        model: { border: [0, 0, 100, 0, 100, 40, 0, 40] },
      } as TResult;
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: 'object_select' } } as TResult;
    }
    if (method === 'Runtime.callFunctionOn') {
      return { result: { value: true } } as TResult;
    }
    return {} as TResult;
  }
}

/** Builds a resolved semantic element with a live CDP backend node hint. */
function buildElement(overrides: Partial<ObservedElement> = {}): ObservedElement {
  return {
    observationRef: 'observation_1:element:0',
    framePath: [],
    shadowPath: [],
    role: 'textbox',
    name: 'Message',
    label: 'Message',
    text: null,
    value: '',
    stableAttributes: { id: 'message' },
    ancestorHint: null,
    state: { disabled: false, checked: null, selected: null, expanded: null },
    rect: { x: 0, y: 0, width: 100, height: 40 },
    visible: true,
    obscured: false,
    backendNodeId: 101,
    cdpSessionId: 'session_1',
    ...overrides,
  };
}

/** Creates the resolved context passed from BrowserController into a CDP action. */
function buildContext(
  target = buildElement(),
  destination: ObservedElement | null = null,
): ActionDriverContext {
  return { target, destination };
}

describe('CdpActionDriver', () => {
  it('uses a live box center and paired real mouse commands for click', async () => {
    const transport = new StubActionTransport();
    let now = 1_000;
    const driver = new CdpActionDriver(transport, {
      clock: { now: () => ++now },
      tabs: { getUrl: async () => 'https://example.test/form' },
    });
    const element = buildElement({ role: 'button', name: 'Save', text: 'Save' });

    const evidence = await driver.execute(
      {
        actionId: 'click_1',
        tabId: 7,
        type: 'click',
        target: createElementTarget(element),
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      buildContext(element),
    );

    expect(transport.calls).toEqual([
      {
        method: 'DOM.getBoxModel',
        params: { backendNodeId: 101 },
        sessionId: 'session_1',
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseMoved', x: 50, y: 20 },
        sessionId: 'session_1',
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: 50, y: 20, button: 'left', clickCount: 1 },
        sessionId: 'session_1',
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: 50, y: 20, button: 'left', clickCount: 1 },
        sessionId: 'session_1',
      },
    ]);
    expect(evidence).toMatchObject({ driver: 'cdp', status: 'executed', actionId: 'click_1' });
  });

  it('focuses and replaces text with real keyboard selection plus Input.insertText', async () => {
    const transport = new StubActionTransport();
    const driver = new CdpActionDriver(transport, {
      clock: { now: () => 1_000 },
      tabs: { getUrl: async () => 'https://example.test/form' },
    });
    const element = buildElement();

    await driver.execute(
      {
        actionId: 'type_1',
        tabId: 7,
        type: 'type',
        target: createElementTarget(element),
        text: 'hello',
        replace: true,
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      buildContext(element),
    );

    expect(transport.calls.map((call) => call.method)).toEqual([
      'DOM.focus',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText',
    ]);
    expect(transport.calls.at(-1)).toEqual({
      method: 'Input.insertText',
      params: { text: 'hello' },
      sessionId: 'session_1',
    });
    expect(transport.calls[1]).toEqual(
      expect.objectContaining({
        method: 'Input.dispatchKeyEvent',
        params: expect.objectContaining({ commands: ['SelectAll'] }),
      }),
    );
  });

  it('emits paired keys, real wheel input, and the CDP drag sequence', async () => {
    const transport = new StubActionTransport();
    const driver = new CdpActionDriver(transport, {
      clock: { now: () => 1_000 },
      tabs: { getUrl: async () => 'https://example.test/form' },
    });
    const source = buildElement({ backendNodeId: 101, role: 'button', name: 'Source' });
    const destination = buildElement({ backendNodeId: 202, role: 'button', name: 'Destination' });

    await driver.execute(
      {
        actionId: 'key_1',
        tabId: 7,
        type: 'pressKey',
        target: createElementTarget(source),
        key: 'Enter',
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      buildContext(source),
    );
    await driver.execute(
      {
        actionId: 'scroll_1',
        tabId: 7,
        type: 'scroll',
        target: createElementTarget(source),
        deltaX: 0,
        deltaY: 300,
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      buildContext(source),
    );
    await driver.execute(
      {
        actionId: 'drag_1',
        tabId: 7,
        type: 'drag',
        target: createElementTarget(source),
        destination: createElementTarget(destination),
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      buildContext(source, destination),
    );

    expect(transport.calls.filter((call) => call.method === 'Input.dispatchKeyEvent')).toHaveLength(
      2,
    );
    expect(transport.calls).toContainEqual({
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 50, y: 20, deltaX: 0, deltaY: 300 },
      sessionId: 'session_1',
    });
    expect(
      transport.calls
        .filter((call) => call.method === 'Input.dispatchMouseEvent')
        .slice(-5)
        .map((call) => (call.params as { type: string }).type),
    ).toEqual(['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
  });

  it('selects an exact option value through a fixed child-realm function', async () => {
    const transport = new StubActionTransport();
    const driver = new CdpActionDriver(transport, {
      clock: { now: () => 1_000 },
      tabs: { getUrl: async () => 'https://example.test/form' },
    });
    const select = buildElement({ role: 'combobox', name: 'Country' });

    await driver.execute(
      {
        actionId: 'select_1',
        tabId: 7,
        type: 'select',
        target: createElementTarget(select),
        value: 'cn',
        risk: 'low',
        expected: { type: 'element.value', target: createElementTarget(select), equals: 'cn' },
      },
      buildContext(select),
    );

    expect(transport.calls.map((call) => call.method)).toEqual([
      'DOM.resolveNode',
      'Runtime.callFunctionOn',
      'Runtime.releaseObject',
    ]);
    expect(transport.calls[1]).toEqual(
      expect.objectContaining({
        method: 'Runtime.callFunctionOn',
        sessionId: 'session_1',
        params: expect.objectContaining({
          objectId: 'object_select',
          arguments: [{ value: 'cn' }],
        }),
      }),
    );
  });

  it('refuses a drag whose destination belongs to a different CDP child session', async () => {
    const transport = new StubActionTransport();
    const driver = new CdpActionDriver(transport, {
      clock: { now: () => 1_000 },
      tabs: { getUrl: async () => 'https://example.test/form' },
    });
    const source = buildElement({ backendNodeId: 101, cdpSessionId: 'session_1' });
    const destination = buildElement({ backendNodeId: 202, cdpSessionId: 'session_2' });

    await expect(
      driver.execute(
        {
          actionId: 'drag_cross_session',
          tabId: 7,
          type: 'drag',
          target: createElementTarget(source),
          destination: createElementTarget(destination),
          risk: 'low',
          expected: { type: 'page.stable', quietMs: 300 },
        },
        buildContext(source, destination),
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'ACTION_UNSUPPORTED' }));
    expect(transport.calls).toEqual([]);
  });
});
