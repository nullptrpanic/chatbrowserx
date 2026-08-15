export const CONDITION_POLL_INTERVAL_MS = 250;
export const MAX_VERIFICATION_TIMEOUT_MS = 15_000;

export interface ConditionWaitOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ConditionWaitResult {
  readonly satisfied: boolean;
  readonly timedOut: boolean;
}

export type ConditionEventSubscription = (listener: () => void) => () => void;

export interface DomConditionWaiterOptions {
  readonly subscribe?: ConditionEventSubscription;
}

/** Creates the consistent abort exception returned by all browser verification waits. */
function abortError(): DOMException {
  return new DOMException('Browser verification was aborted.', 'AbortError');
}

export class DomConditionWaiter {
  readonly #subscribe: ConditionEventSubscription | undefined;

  /** Creates a waiter with an optional event source and bounded polling fallback. */
  constructor(options: DomConditionWaiterOptions = {}) {
    this.#subscribe = options.subscribe;
  }

  /** Rechecks a condition after relevant events or 250ms fallback ticks until success or timeout. */
  waitFor(
    check: () => Promise<boolean>,
    options: ConditionWaitOptions,
  ): Promise<ConditionWaitResult> {
    const timeoutMs = Math.min(
      MAX_VERIFICATION_TIMEOUT_MS,
      Math.max(0, Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0),
    );
    if (options.signal?.aborted === true) return Promise.reject(abortError());

    return new Promise<ConditionWaitResult>((resolve, reject) => {
      let settled = false;
      let checking = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        unsubscribe?.();
        options.signal?.removeEventListener('abort', handleAbort);
      };
      const finish = (result: ConditionWaitResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const evaluate = async (): Promise<void> => {
        if (settled || checking) return;
        checking = true;
        try {
          if (await check()) finish({ satisfied: true, timedOut: false });
        } catch (error) {
          fail(error);
        } finally {
          checking = false;
        }
      };
      const schedulePoll = (): void => {
        if (settled) return;
        pollTimer = setTimeout(() => {
          void evaluate().finally(schedulePoll);
        }, CONDITION_POLL_INTERVAL_MS);
      };
      function handleAbort(): void {
        fail(abortError());
      }

      options.signal?.addEventListener('abort', handleAbort, { once: true });
      const unsubscribe = this.#subscribe?.(() => {
        void evaluate();
      });
      const timeoutTimer = setTimeout(
        () => finish({ satisfied: false, timedOut: true }),
        timeoutMs,
      );
      void evaluate().finally(schedulePoll);
    });
  }
}

/** Creates a MutationObserver subscription for a live document without changing its DOM. */
export function createDocumentMutationSubscription(document: Document): ConditionEventSubscription {
  return (listener) => {
    const observer = new MutationObserver(listener);
    if (document.documentElement !== null) {
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }
    return () => observer.disconnect();
  };
}
