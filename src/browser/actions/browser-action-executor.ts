import type { Protocol } from 'devtools-protocol';
import type { ParsedBrowserToolCall } from '../../agent/tools/browser-tool-schema';
import type { DebuggerSession, DebuggerTransport } from '../debugger/debugger-transport';
import type { TargetSessionRegistry } from '../debugger/target-session-registry';
import type { ElementRefStore, ResolvedElementRef } from '../observation/element-ref-store';
import { parseKeyChord, type ParsedKeyChord } from './key-chords';

const SELECT_FUNCTION = `function(value) {
  if (!(this instanceof HTMLSelectElement)) return { ok: false };
  this.value = value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: this.value };
}`;

export type PointerEffect = 'move' | 'click' | 'double_click' | 'drag';

export interface PointerPagePort {
  show(
    tabId: number,
    effect: {
      readonly x: number;
      readonly y: number;
      readonly fromX: number;
      readonly fromY: number;
      readonly effect: PointerEffect;
    },
  ): Promise<void>;
}

export interface BrowserActionResult {
  readonly tabId: number;
  readonly url: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly observation: Readonly<Record<string, unknown>> | null;
}

export interface BrowserActionPort {
  execute(call: ParsedBrowserToolCall, signal: AbortSignal): Promise<BrowserActionResult>;
}

export type BrowserActionErrorCode =
  'UNSUPPORTED_ACTION' | 'POINT_OUT_OF_VIEWPORT' | 'HISTORY_UNAVAILABLE' | 'WAIT_TIMEOUT';

export class BrowserActionError extends Error {
  readonly code: BrowserActionErrorCode;

  constructor(code: BrowserActionErrorCode, message: string) {
    super(message);
    this.name = 'BrowserActionError';
    this.code = code;
  }
}

export interface BrowserActionExecutorDependencies {
  readonly sessions: Pick<TargetSessionRegistry, 'ensure'>;
  readonly transport: DebuggerTransport;
  readonly refs: ElementRefStore;
  readonly pointer: PointerPagePort;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Browser action was aborted.', 'AbortError');
}

function center(target: ResolvedElementRef): Point {
  return {
    x: target.bounds.x + target.bounds.width / 2,
    y: target.bounds.y + target.bounds.height / 2,
  };
}

function input<T>(call: ParsedBrowserToolCall): T {
  return call.arguments as T;
}

/** Executes already-checkpointed browser actions through semantic refs or validated viewport points. */
export class BrowserActionExecutor implements BrowserActionPort {
  readonly #dependencies: BrowserActionExecutorDependencies;

  constructor(dependencies: BrowserActionExecutorDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(call: ParsedBrowserToolCall, signal: AbortSignal): Promise<BrowserActionResult> {
    throwIfAborted(signal);
    const tabId = (call.arguments as { readonly tabId: number }).tabId;
    const snapshot = await this.#dependencies.sessions.ensure(tabId, signal);
    let data: Readonly<Record<string, unknown>>;
    let targetPresent: boolean | null = null;

    switch (call.operation) {
      case 'click': {
        const value = input<{
          tabId: number;
          ref: string;
          button: 'left' | 'right' | 'middle';
          count: 1 | 2;
        }>(call);
        const target = this.#dependencies.refs.resolve(value.ref, tabId, snapshot.generation);
        const point = center(target);
        await this.#showPointer(tabId, point, point, value.count === 2 ? 'double_click' : 'click');
        await this.#click(snapshot.root, point, value.button, value.count);
        data = { action: 'click', dispatched: true, button: value.button, count: value.count };
        targetPresent = true;
        break;
      }
      case 'type': {
        const value = input<{
          tabId: number;
          ref: string;
          text: string;
          replace: boolean;
          submit: boolean;
        }>(call);
        const target = this.#dependencies.refs.resolve(value.ref, tabId, snapshot.generation);
        await this.#dependencies.transport.send(target.session, 'DOM.focus', {
          backendNodeId: target.backendNodeId,
        });
        if (value.replace) {
          await this.#dispatchKey(target.session, {
            kind: 'key',
            key: 'a',
            code: 'KeyA',
            modifiers: 2,
          });
          await this.#dispatchKey(target.session, {
            kind: 'key',
            key: 'Backspace',
            code: 'Backspace',
            modifiers: 0,
          });
        }
        if (value.text.length > 0) {
          await this.#dependencies.transport.send(target.session, 'Input.insertText', {
            text: value.text,
          });
        }
        if (value.submit) {
          await this.#dispatchKey(target.session, {
            kind: 'key',
            key: 'Enter',
            code: 'Enter',
            modifiers: 0,
          });
        }
        data = {
          action: 'type',
          dispatched: true,
          replaced: value.replace,
          submitted: value.submit,
        };
        targetPresent = true;
        break;
      }
      case 'keypress': {
        const value = input<{ tabId: number; keys: string }>(call);
        const chord = parseKeyChord(value.keys);
        if (chord.kind === 'history') await this.#navigateHistory(snapshot.root, chord.direction);
        else await this.#dispatchKey(snapshot.root, chord);
        data = { action: 'keypress', dispatched: true, keys: value.keys };
        break;
      }
      case 'scroll': {
        const value = input<{
          tabId: number;
          target: string;
          direction: 'up' | 'down' | 'left' | 'right';
          amount: 'small' | 'medium' | 'page';
        }>(call);
        const viewport = await this.#viewport(snapshot.root);
        const point =
          value.target === 'viewport'
            ? { x: viewport.width / 2, y: viewport.height / 2 }
            : center(this.#dependencies.refs.resolve(value.target, tabId, snapshot.generation));
        const magnitude =
          value.amount === 'small'
            ? 280
            : value.amount === 'medium'
              ? 600
              : Math.max(300, viewport.height * 0.85);
        const horizontal = value.direction === 'left' || value.direction === 'right';
        const sign = value.direction === 'up' || value.direction === 'left' ? -1 : 1;
        await this.#showPointer(tabId, point, point, 'move');
        await this.#dependencies.transport.send(snapshot.root, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX: horizontal ? magnitude * sign : 0,
          deltaY: horizontal ? 0 : magnitude * sign,
        });
        data = {
          action: 'scroll',
          dispatched: true,
          direction: value.direction,
          amount: value.amount,
        };
        break;
      }
      case 'hover': {
        const value = input<{ tabId: number; ref: string }>(call);
        const target = this.#dependencies.refs.resolve(value.ref, tabId, snapshot.generation);
        const point = center(target);
        await this.#showPointer(tabId, point, point, 'move');
        await this.#dependencies.transport.send(snapshot.root, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'none',
        });
        data = { action: 'hover', dispatched: true };
        targetPresent = true;
        break;
      }
      case 'select': {
        const value = input<{ tabId: number; ref: string; value: string }>(call);
        const target = this.#dependencies.refs.resolve(value.ref, tabId, snapshot.generation);
        const resolved = await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
          target.session,
          'DOM.resolveNode',
          { backendNodeId: target.backendNodeId },
        );
        if (!resolved.object.objectId) {
          throw new BrowserActionError('UNSUPPORTED_ACTION', 'The select target is unavailable.');
        }
        await this.#dependencies.transport.send(target.session, 'Runtime.callFunctionOn', {
          objectId: resolved.object.objectId,
          functionDeclaration: SELECT_FUNCTION,
          arguments: [{ value: value.value }],
          awaitPromise: false,
          returnByValue: true,
          userGesture: true,
        });
        data = { action: 'select', dispatched: true };
        targetPresent = true;
        break;
      }
      case 'drag': {
        const value = input<{ tabId: number; fromRef: string; toRef: string }>(call);
        const from = center(
          this.#dependencies.refs.resolve(value.fromRef, tabId, snapshot.generation),
        );
        const to = center(this.#dependencies.refs.resolve(value.toRef, tabId, snapshot.generation));
        await this.#showPointer(tabId, to, from, 'drag');
        await this.#drag(snapshot.root, from, to);
        data = { action: 'drag', dispatched: true };
        targetPresent = true;
        break;
      }
      case 'wait': {
        const value = input<{
          tabId: number;
          condition: 'load' | 'network_idle' | 'dom_stable' | 'delay';
          timeoutMs: number;
        }>(call);
        await this.#wait(snapshot.root, value.condition, value.timeoutMs, signal);
        data = { action: 'wait', condition: value.condition, completed: true };
        break;
      }
      case 'click_point': {
        const value = input<{
          tabId: number;
          x: number;
          y: number;
          button: 'left' | 'right';
          count: 1 | 2;
        }>(call);
        const point = { x: value.x, y: value.y };
        await this.#validatePoint(snapshot.root, point);
        await this.#showPointer(tabId, point, point, value.count === 2 ? 'double_click' : 'click');
        await this.#click(snapshot.root, point, value.button, value.count);
        data = {
          action: 'click_point',
          dispatched: true,
          button: value.button,
          count: value.count,
        };
        break;
      }
      case 'drag_point': {
        const value = input<{
          tabId: number;
          fromX: number;
          fromY: number;
          toX: number;
          toY: number;
        }>(call);
        const from = { x: value.fromX, y: value.fromY };
        const to = { x: value.toX, y: value.toY };
        await this.#validatePoint(snapshot.root, from);
        await this.#validatePoint(snapshot.root, to);
        await this.#showPointer(tabId, to, from, 'drag');
        await this.#drag(snapshot.root, from, to);
        data = { action: 'drag_point', dispatched: true };
        break;
      }
      default:
        throw new BrowserActionError('UNSUPPORTED_ACTION', 'This browser action is unsupported.');
    }

    throwIfAborted(signal);
    const url = await this.#currentUrl(snapshot.root);
    return {
      tabId,
      url,
      data,
      observation: { targetPresent },
    };
  }

  async #showPointer(tabId: number, to: Point, from: Point, effect: PointerEffect): Promise<void> {
    try {
      await this.#dependencies.pointer.show(tabId, {
        x: to.x,
        y: to.y,
        fromX: from.x,
        fromY: from.y,
        effect,
      });
    } catch {
      // Pointer feedback is best-effort and must never cause an action retry.
    }
  }

  async #click(
    session: DebuggerSession,
    point: Point,
    button: 'left' | 'right' | 'middle',
    count: 1 | 2,
  ): Promise<void> {
    await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
    });
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
      await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
    }
  }

  async #drag(session: DebuggerSession, from: Point, to: Point): Promise<void> {
    await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
      button: 'none',
    });
    await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      clickCount: 1,
    });
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
        button: 'left',
        buttons: 1,
      });
    }
    await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      clickCount: 1,
    });
  }

  async #dispatchKey(
    session: DebuggerSession,
    chord: Extract<ParsedKeyChord, { readonly kind: 'key' }>,
  ): Promise<void> {
    await this.#dependencies.transport.send(session, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: chord.key,
      code: chord.code,
      modifiers: chord.modifiers,
    });
    await this.#dependencies.transport.send(session, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: chord.key,
      code: chord.code,
      modifiers: chord.modifiers,
    });
  }

  async #navigateHistory(session: DebuggerSession, direction: 'back' | 'forward'): Promise<void> {
    const history =
      await this.#dependencies.transport.send<Protocol.Page.GetNavigationHistoryResponse>(
        session,
        'Page.getNavigationHistory',
      );
    const index = history.currentIndex + (direction === 'back' ? -1 : 1);
    const entry = history.entries[index];
    if (!entry)
      throw new BrowserActionError('HISTORY_UNAVAILABLE', 'Browser history is unavailable.');
    await this.#dependencies.transport.send(session, 'Page.navigateToHistoryEntry', {
      entryId: entry.id,
    });
  }

  async #viewport(session: DebuggerSession): Promise<{ width: number; height: number }> {
    const metrics = await this.#dependencies.transport.send<Protocol.Page.GetLayoutMetricsResponse>(
      session,
      'Page.getLayoutMetrics',
    );
    return {
      width: metrics.visualViewport.clientWidth,
      height: metrics.visualViewport.clientHeight,
    };
  }

  async #validatePoint(session: DebuggerSession, point: Point): Promise<void> {
    const viewport = await this.#viewport(session);
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      throw new BrowserActionError(
        'POINT_OUT_OF_VIEWPORT',
        'The screenshot point is outside the current viewport.',
      );
    }
  }

  async #wait(
    session: DebuggerSession,
    condition: 'load' | 'network_idle' | 'dom_stable' | 'delay',
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (condition === 'delay') {
      await this.#delay(timeoutMs, signal);
      return;
    }
    if (condition === 'load') {
      const ready = await this.#dependencies.transport.send<Protocol.Runtime.EvaluateResponse>(
        session,
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
      );
      if (ready.result.value === 'complete') return;
      await this.#waitForEvents(session, timeoutMs, signal, ['Page.loadEventFired'], 0);
      return;
    }
    const network = condition === 'network_idle';
    if (network) await this.#dependencies.transport.send(session, 'Network.enable');
    await this.#waitForEvents(
      session,
      timeoutMs,
      signal,
      network
        ? ['Network.requestWillBeSent', 'Network.loadingFinished', 'Network.loadingFailed']
        : [
            'DOM.documentUpdated',
            'DOM.attributeModified',
            'DOM.childNodeInserted',
            'DOM.childNodeRemoved',
          ],
      500,
    );
  }

  #waitForEvents(
    session: DebuggerSession,
    timeoutMs: number,
    signal: AbortSignal,
    methods: readonly string[],
    quietMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        clearTimeout(timeoutTimer);
        if (quietTimer) clearTimeout(quietTimer);
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const scheduleQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), quietMs);
      };
      const unsubscribe = this.#dependencies.transport.onEvent((source, method) => {
        if (
          source.tabId === session.tabId &&
          source.sessionId === session.sessionId &&
          methods.includes(method)
        ) {
          if (quietMs === 0) finish();
          else scheduleQuiet();
        }
      });
      const onAbort = () => finish(new DOMException('Browser wait was aborted.', 'AbortError'));
      const timeoutTimer = setTimeout(
        () => finish(new BrowserActionError('WAIT_TIMEOUT', 'The browser wait timed out.')),
        timeoutMs,
      );
      signal.addEventListener('abort', onAbort, { once: true });
      if (quietMs > 0) scheduleQuiet();
    });
  }

  #delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Browser delay was aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async #currentUrl(session: DebuggerSession): Promise<string | null> {
    try {
      const history =
        await this.#dependencies.transport.send<Protocol.Page.GetNavigationHistoryResponse>(
          session,
          'Page.getNavigationHistory',
        );
      return history.entries[history.currentIndex]?.url.slice(0, 4_096) ?? null;
    } catch {
      return null;
    }
  }
}
