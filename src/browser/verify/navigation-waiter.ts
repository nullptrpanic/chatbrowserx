import type { Clock } from '../../shared/time';
import type { DebuggerEventListener } from '../../platform/chrome/debugger-events';
import { DomConditionWaiter } from './dom-condition-waiter';

export interface DebuggerEventPort {
  subscribe(listener: DebuggerEventListener): () => void;
}

export interface NavigationStableResult {
  readonly satisfied: boolean;
  readonly quietMs: number;
}

const lifecycleMethods = new Set([
  'DOM.documentUpdated',
  'Page.domContentEventFired',
  'Page.frameNavigated',
  'Page.lifecycleEvent',
  'Page.loadEventFired',
  'Page.navigatedWithinDocument',
]);

export class NavigationWaiter {
  readonly #events: DebuggerEventPort;
  readonly #clock: Clock;

  /** Creates a page-stability waiter over normalized debugger lifecycle events. */
  constructor(events: DebuggerEventPort, clock: Clock = { now: () => Date.now() }) {
    this.#events = events;
    this.#clock = clock;
  }

  /** Waits for a 300–2,000ms quiet lifecycle window within the bounded verification timeout. */
  async waitForStable(
    tabId: number,
    quietMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<NavigationStableResult> {
    const boundedQuietMs = Math.min(2_000, Math.max(300, quietMs));
    let lastActivity = this.#clock.now();
    const waiter = new DomConditionWaiter({
      subscribe: (wake) =>
        this.#events.subscribe((event) => {
          if (
            event.tabId === tabId &&
            event.kind === 'protocol_event' &&
            lifecycleMethods.has(event.method)
          ) {
            lastActivity = this.#clock.now();
            wake();
          }
        }),
    });
    const result = await waiter.waitFor(
      async () => this.#clock.now() - lastActivity >= boundedQuietMs,
      signal === undefined ? { timeoutMs } : { timeoutMs, signal },
    );
    return { satisfied: result.satisfied, quietMs: boundedQuietMs };
  }
}
