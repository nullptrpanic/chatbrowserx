import { describe, expect, it } from 'vitest';
import {
  CdpObserver,
  type CdpCommandPort,
  type CdpSessionDescriptor,
} from '../../../src/browser/observe/cdp-observer';

class StubCdpTransport implements CdpCommandPort {
  readonly calls: Array<{
    readonly method: string;
    readonly params: object | undefined;
    readonly sessionId: string | undefined;
  }> = [];

  /** Returns no out-of-process frame sessions for the base observation fixture. */
  async listSessions(_tabId: number): Promise<readonly CdpSessionDescriptor[]> {
    void _tabId;
    return [];
  }

  /**
   * Returns deterministic protocol fixtures while recording every requested method.
   */
  async send<TResult>(
    _tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<TResult> {
    this.calls.push({ method, params, sessionId });
    const responses: Record<string, unknown> = {
      'Accessibility.getFullAXTree': {
        nodes: [
          {
            nodeId: 'ax_1',
            backendDOMNodeId: 101,
            role: { value: 'textbox' },
            name: { value: 'Email' },
            value: { value: 'stale@example.test' },
            properties: [{ name: 'disabled', value: { value: false } }],
          },
          {
            nodeId: 'ax_2',
            backendDOMNodeId: 102,
            role: { value: 'button' },
            name: { value: 'Save' },
            properties: [{ name: 'disabled', value: { value: true } }],
          },
          {
            nodeId: 'ax_text',
            role: { value: 'StaticText' },
            name: { value: 'Account settings' },
          },
        ],
      },
      'DOM.getDocument': {
        root: {
          nodeId: 1,
          nodeName: '#document',
          documentURL: 'https://example.test/form',
          children: [
            {
              nodeId: 2,
              backendNodeId: 201,
              nodeName: 'IFRAME',
              attributes: ['name', 'remote', 'title', 'Remote frame'],
              contentDocument: {
                nodeId: 3,
                nodeName: '#document',
                documentURL: 'https://frame.example/child',
                frameId: 'frame_remote',
              },
            },
          ],
        },
      },
      'DOMSnapshot.captureSnapshot': {
        strings: ['INPUT', 'id', 'email', 'BUTTON', 'data-testid', 'save-action'],
        documents: [
          {
            nodes: {
              backendNodeId: [101, 102],
              nodeName: [0, 3],
              attributes: [
                [1, 2],
                [4, 5],
              ],
            },
            layout: {
              nodeIndex: [0, 1],
              bounds: [
                [20, 20, 160, 32],
                [20, 70, 100, 32],
              ],
            },
          },
        ],
      },
    };
    return responses[method] as TResult;
  }
}

describe('CdpObserver', () => {
  it('normalizes accessibility nodes, DOM snapshot geometry, and frame metadata', async () => {
    const transport = new StubCdpTransport();
    const observer = new CdpObserver(transport);

    const observation = await observer.observe({
      id: 'observation_cdp',
      capturedAt: 1_000,
      tabId: 7,
      url: 'https://example.test/form',
      title: 'Account form',
      viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
    });

    expect(transport.calls.map((call) => call.method)).toEqual([
      'Accessibility.getFullAXTree',
      'DOM.getDocument',
      'DOMSnapshot.captureSnapshot',
    ]);
    expect(observation.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'textbox',
          name: 'Email',
          value: 'stale@example.test',
          stableAttributes: { id: 'email' },
          rect: { x: 20, y: 20, width: 160, height: 32 },
          backendNodeId: 101,
        }),
        expect.objectContaining({
          role: 'button',
          name: 'Save',
          state: expect.objectContaining({ disabled: true }),
          stableAttributes: { 'data-testid': 'save-action' },
          backendNodeId: 102,
        }),
      ]),
    );
    expect(observation.textRegions).toEqual([
      expect.objectContaining({ kind: 'staticText', text: 'Account settings' }),
    ]);
    expect(observation.frames).toEqual([
      expect.objectContaining({
        name: 'remote',
        title: 'Remote frame',
        url: 'https://frame.example/child',
        accessible: true,
      }),
    ]);
  });

  it('observes an out-of-process iframe through its attached child session', async () => {
    class CrossOriginTransport implements CdpCommandPort {
      readonly calls: Array<{ readonly method: string; readonly sessionId: string | undefined }> =
        [];

      /** Exposes one child target whose target ID matches the remote frame owner ID. */
      async listSessions(_tabId: number): Promise<readonly CdpSessionDescriptor[]> {
        void _tabId;
        return [
          {
            sessionId: 'session_remote',
            targetId: 'frame_remote',
            type: 'iframe',
            url: 'https://frame.example/child',
            title: 'Remote frame',
            parentSessionId: null,
          },
        ];
      }

      /** Returns distinct root and child protocol snapshots for frame-path routing assertions. */
      async send<TResult>(
        _tabId: number,
        method: string,
        _params?: object,
        sessionId?: string,
      ): Promise<TResult> {
        this.calls.push({ method, sessionId });
        if (sessionId === undefined) {
          const rootResponses: Record<string, unknown> = {
            'Accessibility.getFullAXTree': { nodes: [] },
            'DOM.getDocument': {
              root: {
                nodeName: '#document',
                documentURL: 'https://example.test/form',
                children: [
                  {
                    nodeName: 'IFRAME',
                    frameId: 'frame_remote',
                    attributes: [
                      'name',
                      'remote',
                      'title',
                      'Remote frame',
                      'src',
                      'https://frame.example/child',
                    ],
                  },
                ],
              },
            },
            'DOMSnapshot.captureSnapshot': { strings: [], documents: [] },
          };
          return rootResponses[method] as TResult;
        }
        const childResponses: Record<string, unknown> = {
          'Accessibility.getFullAXTree': {
            nodes: [
              {
                backendDOMNodeId: 301,
                frameId: 'frame_remote',
                role: { value: 'button' },
                name: { value: 'Continue' },
                properties: [{ name: 'disabled', value: { value: false } }],
              },
            ],
          },
          'DOM.getDocument': {
            root: {
              nodeName: '#document',
              documentURL: 'https://frame.example/child',
              frameId: 'frame_remote',
            },
          },
          'DOMSnapshot.captureSnapshot': {
            strings: ['BUTTON', 'data-testid', 'continue'],
            documents: [
              {
                nodes: { backendNodeId: [301], attributes: [[1, 2]] },
                layout: { nodeIndex: [0], bounds: [[12, 16, 120, 32]] },
              },
            ],
          },
        };
        return childResponses[method] as TResult;
      }
    }

    const transport = new CrossOriginTransport();
    const observation = await new CdpObserver(transport).observe({
      id: 'observation_cross_origin',
      capturedAt: 1_000,
      tabId: 7,
      url: 'https://example.test/form',
      title: 'Host form',
      viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
    });

    expect(observation.elements).toContainEqual(
      expect.objectContaining({
        name: 'Continue',
        backendNodeId: 301,
        cdpSessionId: 'session_remote',
        framePath: [
          {
            index: 0,
            name: 'remote',
            title: 'Remote frame',
            origin: 'https://frame.example',
          },
        ],
      }),
    );
    expect(observation.frames).toContainEqual(
      expect.objectContaining({
        url: 'https://frame.example/child',
        accessible: true,
      }),
    );
    expect(
      transport.calls
        .filter((call) => call.sessionId === 'session_remote')
        .map((call) => call.method),
    ).toEqual(['Accessibility.getFullAXTree', 'DOM.getDocument', 'DOMSnapshot.captureSnapshot']);
  });
});
