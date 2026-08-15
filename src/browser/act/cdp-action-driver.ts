import type { Clock } from '../../shared/time';
import type { BrowserActionRequest } from '../contracts/action';
import type { BrowserActionEvidence } from '../contracts/evidence';
import type { ObservedElement } from '../contracts/observation';
import type { ActionDriver, ActionDriverContext } from './action-driver';
import { ActionExecutionError } from './action-errors';

export interface CdpActionCommandPort {
  send<TResult>(
    tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<TResult>;
}

export interface CdpActionDependencies {
  readonly clock: Clock;
  readonly tabs: { getUrl(tabId: number): Promise<string> };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const selectOptionFunction = `function(value) {
  if (this === null || this.tagName !== 'SELECT') return false;
  const option = Array.from(this.options).find((candidate) => candidate.value === value);
  if (option === undefined) return false;
  this.value = value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return this.value === value;
}`;

/** Reads a page URL through the minimal Chrome tab boundary used for action evidence. */
async function getChromeTabUrl(tabId: number): Promise<string> {
  return (await chrome.tabs.get(tabId)).url ?? '';
}

/** Returns the observation-time backend node hint or rejects stale/non-CDP targets. */
function backendNodeId(element: ObservedElement | null): number {
  if (element?.backendNodeId === null || element?.backendNodeId === undefined) {
    throw new ActionExecutionError('TARGET_NOT_FOUND', 'CDP target has no live backend node.');
  }
  return element.backendNodeId;
}

/** Converts an eight-value CDP box quad into its geometric center. */
function quadCenter(quad: readonly number[]): Point {
  if (quad.length < 8) {
    throw new ActionExecutionError('ACTION_FAILED', 'CDP target box is unavailable.');
  }
  const xValues = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const yValues = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  return {
    x: xValues.reduce((total, value) => total + value, 0) / xValues.length,
    y: yValues.reduce((total, value) => total + value, 0) / yValues.length,
  };
}

export class CdpActionDriver implements ActionDriver {
  readonly kind = 'cdp' as const;
  readonly #transport: CdpActionCommandPort;
  readonly #dependencies: CdpActionDependencies;

  /** Creates a real-input action driver over an attached debugger transport. */
  constructor(
    transport: CdpActionCommandPort,
    dependencies: CdpActionDependencies = {
      clock: { now: () => Date.now() },
      tabs: { getUrl: getChromeTabUrl },
    },
  ) {
    this.#transport = transport;
    this.#dependencies = dependencies;
  }

  /** Executes one approved action with CDP mouse, keyboard, focus, wheel, or drag commands. */
  async execute(
    request: BrowserActionRequest,
    context?: ActionDriverContext,
  ): Promise<BrowserActionEvidence> {
    if (context === undefined) {
      throw new ActionExecutionError('TARGET_NOT_FOUND', 'CDP action context is missing.');
    }
    const sessionId = context.target?.cdpSessionId ?? undefined;
    if (request.type === 'drag' && (context.destination?.cdpSessionId ?? undefined) !== sessionId) {
      throw new ActionExecutionError(
        'ACTION_UNSUPPORTED',
        'Cross-session drag is not safely supported.',
      );
    }
    const startedAt = this.#dependencies.clock.now();
    const beforeUrl = await this.#dependencies.tabs.getUrl(request.tabId);
    let commandCount = 0;
    let status: BrowserActionEvidence['status'] = 'executed';
    const send = async <TResult>(method: string, params?: object): Promise<TResult> => {
      commandCount += 1;
      return this.#transport.send<TResult>(request.tabId, method, params, sessionId);
    };
    const center = async (element: ObservedElement | null): Promise<Point> => {
      const response = await send<{ readonly model?: { readonly border?: readonly number[] } }>(
        'DOM.getBoxModel',
        { backendNodeId: backendNodeId(element) },
      );
      return quadCenter(response.model?.border ?? []);
    };
    const focus = async (element: ObservedElement | null): Promise<void> => {
      await send('DOM.focus', { backendNodeId: backendNodeId(element) });
    };
    const pressKey = async (key: string): Promise<void> => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key });
    };
    const selectAll = async (): Promise<void> => {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        commands: ['SelectAll'],
      });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
    };
    const click = async (element: ObservedElement | null): Promise<void> => {
      const point = await center(element);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...point,
        button: 'left',
        clickCount: 1,
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...point,
        button: 'left',
        clickCount: 1,
      });
    };
    const selectOption = async (element: ObservedElement | null, value: string): Promise<void> => {
      const resolved = await send<{ readonly object?: { readonly objectId?: string } }>(
        'DOM.resolveNode',
        { backendNodeId: backendNodeId(element) },
      );
      const objectId = resolved.object?.objectId;
      if (objectId === undefined) {
        throw new ActionExecutionError('TARGET_NOT_FOUND', 'CDP target could not be resolved.');
      }
      try {
        const result = await send<{
          readonly result?: { readonly value?: unknown };
          readonly exceptionDetails?: unknown;
        }>('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: selectOptionFunction,
          arguments: [{ value }],
          returnByValue: true,
          awaitPromise: false,
        });
        if (result.exceptionDetails !== undefined || result.result?.value !== true) {
          throw new ActionExecutionError('ACTION_FAILED', 'Requested option is unavailable.');
        }
      } finally {
        await send('Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    };

    switch (request.type) {
      case 'click':
        await click(context.target);
        break;
      case 'type':
        await focus(context.target);
        if (request.replace) await selectAll();
        await send('Input.insertText', { text: request.text });
        break;
      case 'clear':
        await focus(context.target);
        await selectAll();
        await pressKey('Backspace');
        break;
      case 'select':
        await selectOption(context.target, request.value);
        break;
      case 'check':
        if (context.target?.state.checked !== request.checked) await click(context.target);
        break;
      case 'hover': {
        const point = await center(context.target);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        break;
      }
      case 'pressKey':
        if (context.target !== null) await focus(context.target);
        await pressKey(request.key);
        break;
      case 'scroll': {
        const point = context.target === null ? { x: 0, y: 0 } : await center(context.target);
        await send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...point,
          deltaX: request.deltaX,
          deltaY: request.deltaY,
        });
        break;
      }
      case 'drag': {
        const source = await center(context.target);
        const destination = await center(context.destination);
        const midpoint = {
          x: (source.x + destination.x) / 2,
          y: (source.y + destination.y) / 2,
        };
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...source });
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          ...source,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...midpoint,
          button: 'left',
          buttons: 1,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...destination,
          button: 'left',
          buttons: 1,
        });
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...destination,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        break;
      }
      case 'waitFor':
        status = 'unsupported';
        break;
    }

    const target = context.target;
    return {
      actionId: request.actionId,
      actionKind: request.type,
      driver: 'cdp',
      status,
      startedAt,
      finishedAt: this.#dependencies.clock.now(),
      resolvedTarget:
        target === null
          ? null
          : {
              role: target.role,
              name: target.name.slice(0, 200),
              frameDepth: target.framePath.length,
              shadowDepth: target.shadowPath.length,
            },
      beforeUrl,
      afterUrl: await this.#dependencies.tabs.getUrl(request.tabId),
      commandResult: { commands: commandCount },
    };
  }
}
