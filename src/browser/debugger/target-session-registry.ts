import type { Protocol } from 'devtools-protocol';
import type { DebuggerSession, DebuggerTransport } from './debugger-transport';

const AUTO_ATTACH_PARAMETERS = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
} as const;

const ENABLED_DOMAINS = [
  'Page.enable',
  'DOM.enable',
  'Accessibility.enable',
  'Runtime.enable',
] as const;

export type TargetSessionRegistryErrorCode = 'DEBUGGER_UNAVAILABLE';

export class TargetSessionRegistryError extends Error {
  readonly code: TargetSessionRegistryErrorCode;

  constructor(message: string) {
    super(message);
    this.name = 'TargetSessionRegistryError';
    this.code = 'DEBUGGER_UNAVAILABLE';
  }
}

export interface ChildTargetSession {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly parentSessionId: string | null;
  readonly session: DebuggerSession & { readonly sessionId: string };
}

export interface BrowserSessionSnapshot {
  readonly tabId: number;
  readonly generation: number;
  readonly root: DebuggerSession;
  readonly children: ReadonlyMap<string, ChildTargetSession>;
}

interface MutableSessionState {
  readonly tabId: number;
  generation: number;
  readonly root: DebuggerSession;
  readonly children: Map<string, ChildTargetSession>;
}

interface AttachedTargetParameters {
  readonly sessionId: string;
  readonly targetInfo: Pick<Protocol.Target.TargetInfo, 'targetId' | 'type' | 'url'>;
}

function aborted(): DOMException {
  return new DOMException('Browser session attachment was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

function snapshot(state: MutableSessionState): BrowserSessionSnapshot {
  return {
    tabId: state.tabId,
    generation: state.generation,
    root: state.root,
    children: new Map(state.children),
  };
}

function attachedTargetParameters(
  params: Readonly<Record<string, unknown>>,
): AttachedTargetParameters | undefined {
  if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) return undefined;
  if (typeof params.targetInfo !== 'object' || params.targetInfo === null) return undefined;
  const targetInfo = params.targetInfo as Record<string, unknown>;
  if (
    typeof targetInfo.targetId !== 'string' ||
    targetInfo.targetId.length === 0 ||
    typeof targetInfo.type !== 'string' ||
    typeof targetInfo.url !== 'string'
  ) {
    return undefined;
  }
  return {
    sessionId: params.sessionId,
    targetInfo: {
      targetId: targetInfo.targetId,
      type: targetInfo.type,
      url: targetInfo.url,
    },
  };
}

/** Owns one debugger attachment per tab and routes flattened OOPIF child sessions. */
export class TargetSessionRegistry {
  readonly #transport: DebuggerTransport;
  readonly #states = new Map<number, MutableSessionState>();
  readonly #inFlight = new Map<number, Promise<MutableSessionState>>();
  readonly #generations = new Map<number, number>();
  readonly #ownersByTab = new Map<number, Set<string>>();
  readonly #tabsByOwner = new Map<string, Set<number>>();
  readonly #lifecycleQueues = new Map<number, Promise<void>>();
  readonly #eventTasksByTab = new Map<number, Set<Promise<void>>>();

  constructor(transport: DebuggerTransport) {
    this.#transport = transport;
    transport.onEvent((session, method, params) => {
      const task = this.#handleEvent(session, method, params);
      const tasks = this.#eventTasksByTab.get(session.tabId) ?? new Set<Promise<void>>();
      tasks.add(task);
      this.#eventTasksByTab.set(session.tabId, tasks);
      void task.finally(() => {
        tasks.delete(task);
        if (tasks.size === 0 && this.#eventTasksByTab.get(session.tabId) === tasks) {
          this.#eventTasksByTab.delete(session.tabId);
        }
      });
    });
    transport.onDetach((session) => {
      if (session.sessionId === undefined) this.invalidate(session.tabId);
      else this.#removeChildSession(session.tabId, session.sessionId);
    });
  }

  async ensure(tabId: number, signal: AbortSignal): Promise<BrowserSessionSnapshot> {
    throwIfAborted(signal);
    const current = this.#states.get(tabId);
    if (current) return snapshot(current);

    let attaching = this.#inFlight.get(tabId);
    if (!attaching) {
      attaching = this.#attach(tabId);
      this.#inFlight.set(tabId, attaching);
      const clearInFlight = () => {
        if (this.#inFlight.get(tabId) === attaching) this.#inFlight.delete(tabId);
      };
      void attaching.then(clearInFlight, clearInFlight);
    }
    const state = await this.#withAbort(attaching, signal);
    await Promise.resolve();
    await this.#waitForEventTasks(tabId, signal);
    return snapshot(this.#states.get(tabId) ?? state);
  }

  /** Retains one tab for a runner without attaching until its first CDP operation. */
  retain(tabId: number, ownerId: string): Promise<void> {
    if (ownerId.length === 0 || ownerId.length > 256) {
      return Promise.reject(new Error('Browser session owner is invalid.'));
    }
    return this.#serializeLifecycle(tabId, () => {
      const owners = this.#ownersByTab.get(tabId) ?? new Set<string>();
      owners.add(ownerId);
      this.#ownersByTab.set(tabId, owners);
      const tabs = this.#tabsByOwner.get(ownerId) ?? new Set<number>();
      tabs.add(tabId);
      this.#tabsByOwner.set(ownerId, tabs);
    });
  }

  /** Detaches tabs no longer retained by any runner, preserving concurrent tasks on shared tabs. */
  async releaseOwner(ownerId: string): Promise<void> {
    const tabs = [...(this.#tabsByOwner.get(ownerId) ?? [])];
    this.#tabsByOwner.delete(ownerId);
    await Promise.all(
      tabs.map((tabId) =>
        this.#serializeLifecycle(tabId, async () => {
          const owners = this.#ownersByTab.get(tabId);
          owners?.delete(ownerId);
          if (owners !== undefined && owners.size > 0) return;
          this.#ownersByTab.delete(tabId);
          await this.#releaseSession(tabId);
        }),
      ),
    );
  }

  sessionForTarget(tabId: number, targetId: string): DebuggerSession | undefined {
    const session = this.#states.get(tabId)?.children.get(targetId)?.session;
    return session === undefined ? undefined : { ...session };
  }

  invalidate(tabId: number): void {
    this.#states.delete(tabId);
    this.#advanceGeneration(tabId);
  }

  async release(tabId: number): Promise<void> {
    await this.#serializeLifecycle(tabId, async () => {
      for (const ownerId of this.#ownersByTab.get(tabId) ?? []) {
        const tabs = this.#tabsByOwner.get(ownerId);
        tabs?.delete(tabId);
        if (tabs?.size === 0) this.#tabsByOwner.delete(ownerId);
      }
      this.#ownersByTab.delete(tabId);
      await this.#releaseSession(tabId);
    });
  }

  async #releaseSession(tabId: number): Promise<void> {
    const attaching = this.#inFlight.get(tabId);
    if (attaching) await attaching.catch(() => undefined);
    if (this.#states.has(tabId)) {
      try {
        await this.#transport.detach(tabId);
      } catch {
        // Detach is best-effort; local ownership must still be released.
      }
    }
    this.invalidate(tabId);
  }

  #serializeLifecycle(tabId: number, action: () => void | Promise<void>): Promise<void> {
    const previous = this.#lifecycleQueues.get(tabId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.#lifecycleQueues.set(tabId, current);
    return current.finally(() => {
      if (this.#lifecycleQueues.get(tabId) === current) this.#lifecycleQueues.delete(tabId);
    });
  }

  async #attach(tabId: number): Promise<MutableSessionState> {
    try {
      return await this.#attachOnce(tabId);
    } catch {
      this.#states.delete(tabId);
      try {
        await this.#transport.detach(tabId);
      } catch {
        // Another debugger may own the target; never interfere or retry in that case.
        throw new TargetSessionRegistryError('The browser debugger is unavailable for this tab.');
      }
      try {
        return await this.#attachOnce(tabId);
      } catch {
        this.#states.delete(tabId);
        try {
          await this.#transport.detach(tabId);
        } catch {
          // The bounded recovery attempt may have failed before acquiring ownership.
        }
        throw new TargetSessionRegistryError('The browser debugger is unavailable for this tab.');
      }
    }
  }

  async #attachOnce(tabId: number): Promise<MutableSessionState> {
    await this.#transport.attach(tabId);
    const state: MutableSessionState = {
      tabId,
      generation: this.#advanceGeneration(tabId),
      root: { tabId },
      children: new Map(),
    };
    this.#states.set(tabId, state);
    await this.#configureSession(state.root);
    return state;
  }

  async #configureSession(session: DebuggerSession): Promise<void> {
    await this.#transport.send(session, 'Target.setAutoAttach', AUTO_ATTACH_PARAMETERS);
    for (const method of ENABLED_DOMAINS) await this.#transport.send(session, method);
    await this.#transport
      .send(session, 'Emulation.setFocusEmulationEnabled', { enabled: true })
      .catch(() => undefined);
  }

  async #handleEvent(
    source: DebuggerSession,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const state = this.#states.get(source.tabId);
    if (!state) return;
    if (method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument') {
      state.generation = this.#advanceGeneration(source.tabId);
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const attached = attachedTargetParameters(params);
      if (!attached || attached.targetInfo.type !== 'iframe') return;
      const child: ChildTargetSession = {
        targetId: attached.targetInfo.targetId,
        type: attached.targetInfo.type,
        url: attached.targetInfo.url.slice(0, 4_096),
        parentSessionId: source.sessionId ?? null,
        session: { tabId: source.tabId, sessionId: attached.sessionId },
      };
      state.children.set(child.targetId, child);
      state.generation = this.#advanceGeneration(source.tabId);
      try {
        await this.#configureSession(child.session);
      } catch {
        this.#removeChildSession(source.tabId, child.session.sessionId);
      }
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      const targetId = typeof params.targetId === 'string' ? params.targetId : undefined;
      if (sessionId) this.#removeChildSession(source.tabId, sessionId);
      else if (targetId) this.#removeChildTarget(source.tabId, targetId);
    }
  }

  #removeChildSession(tabId: number, sessionId: string): void {
    const state = this.#states.get(tabId);
    if (!state) return;
    const target = [...state.children.values()].find(
      (candidate) => candidate.session.sessionId === sessionId,
    );
    if (target) this.#removeChildTarget(tabId, target.targetId);
  }

  #removeChildTarget(tabId: number, targetId: string): void {
    const state = this.#states.get(tabId);
    const target = state?.children.get(targetId);
    if (!state || !target) return;
    const removedSessionIds = new Set([target.session.sessionId]);
    state.children.delete(targetId);
    let removed = true;
    while (removed) {
      removed = false;
      for (const child of state.children.values()) {
        if (child.parentSessionId !== null && removedSessionIds.has(child.parentSessionId)) {
          removedSessionIds.add(child.session.sessionId);
          state.children.delete(child.targetId);
          removed = true;
        }
      }
    }
    state.generation = this.#advanceGeneration(tabId);
  }

  #advanceGeneration(tabId: number): number {
    const next = (this.#generations.get(tabId) ?? 0) + 1;
    this.#generations.set(tabId, next);
    return next;
  }

  #withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(aborted());
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  async #waitForEventTasks(tabId: number, signal: AbortSignal): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const tasks = [...(this.#eventTasksByTab.get(tabId) ?? [])];
      if (tasks.length === 0) return;
      await this.#withAbort(
        Promise.all(tasks).then(() => undefined),
        signal,
      );
    }
  }
}
