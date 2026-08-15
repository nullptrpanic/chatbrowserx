import type {
  ChromeDebuggerDetachListener,
  ChromeDebuggerEventListener,
  ChromeDebuggerTarget,
  DebuggerSessionDescriptor,
  DebuggerEventListener,
} from './debugger-events';

export interface ChromeDebuggerApi {
  attach(target: ChromeDebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: ChromeDebuggerTarget): Promise<void>;
  sendCommand(target: ChromeDebuggerTarget, method: string, params?: object): Promise<unknown>;
  readonly onEvent: { addListener(listener: ChromeDebuggerEventListener): void };
  readonly onDetach: { addListener(listener: ChromeDebuggerDetachListener): void };
}

export interface DebuggerTransport {
  acquire(tabId: number, ownerId: string): Promise<void>;
  release(tabId: number, ownerId: string): Promise<void>;
  send<TResult>(
    tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<TResult>;
  subscribe(listener: DebuggerEventListener): () => void;
  listSessions(tabId: number): Promise<readonly DebuggerSessionDescriptor[]>;
  isAttached(tabId: number): boolean;
}

export type DebuggerTransportErrorCode =
  'ATTACH_FAILED' | 'DETACH_FAILED' | 'NOT_ATTACHED' | 'COMMAND_FAILED';

export class DebuggerTransportError extends Error {
  readonly code: DebuggerTransportErrorCode;

  /** Creates a stable transport error that never embeds protocol parameters or browser payloads. */
  constructor(code: DebuggerTransportErrorCode, message: string) {
    super(message);
    this.name = 'DebuggerTransportError';
    this.code = code;
  }
}

interface AttachmentState {
  readonly owners: Map<string, number>;
  readonly sessions: Map<string, ChildSessionState>;
  ready: Promise<void>;
  attached: boolean;
}

interface ChildSessionState {
  readonly descriptor: DebuggerSessionDescriptor;
  ready: Promise<boolean>;
}

const enabledDomains = ['Page.enable', 'DOM.enable', 'Runtime.enable', 'Accessibility.enable'];
const iframeAutoAttach = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: 'iframe', exclude: false }],
};

export class ChromeDebuggerTransport implements DebuggerTransport {
  readonly #api: ChromeDebuggerApi;
  readonly #attachments = new Map<number, AttachmentState>();
  readonly #listeners = new Set<DebuggerEventListener>();

  /** Creates a reference-counted CDP 1.3 transport and installs global debugger listeners once. */
  constructor(api: ChromeDebuggerApi = chrome.debugger as unknown as ChromeDebuggerApi) {
    this.#api = api;
    api.onEvent.addListener((source, method, params = {}) => {
      this.#trackSessionEvent(source, method, params);
      this.#emit({
        kind: 'protocol_event',
        tabId: source.tabId,
        sessionId: source.sessionId ?? null,
        method,
        params,
      });
    });
    api.onDetach.addListener((source, reason) => {
      this.#attachments.delete(source.tabId);
      this.#emit({ kind: 'detached', tabId: source.tabId, reason });
    });
  }

  /** Attaches once per tab, enables required domains, and increments the requesting owner count. */
  async acquire(tabId: number, ownerId: string): Promise<void> {
    if (!Number.isInteger(tabId) || tabId < 0 || ownerId.trim().length === 0) {
      throw new DebuggerTransportError('ATTACH_FAILED', 'Debugger target is invalid.');
    }

    let state = this.#attachments.get(tabId);
    if (state === undefined) {
      state = {
        owners: new Map(),
        sessions: new Map(),
        attached: false,
        ready: Promise.resolve(),
      };
      this.#attachments.set(tabId, state);
      state.ready = this.#attach(tabId, state);
    }

    await state.ready;
    state.owners.set(ownerId, (state.owners.get(ownerId) ?? 0) + 1);
  }

  /** Decrements one owner reference and detaches only after the tab has no remaining owners. */
  async release(tabId: number, ownerId: string): Promise<void> {
    const state = this.#attachments.get(tabId);
    if (state === undefined) return;
    await state.ready;

    const count = state.owners.get(ownerId) ?? 0;
    if (count <= 1) state.owners.delete(ownerId);
    else state.owners.set(ownerId, count - 1);
    const remaining = [...state.owners.values()].reduce((total, value) => total + value, 0);
    if (remaining > 0) return;

    this.#attachments.delete(tabId);
    try {
      await this.#api.detach({ tabId });
    } catch {
      throw new DebuggerTransportError('DETACH_FAILED', 'Unable to detach browser debugger.');
    }
  }

  /** Sends one typed protocol command through the tab or an explicitly supplied child session. */
  async send<TResult>(
    tabId: number,
    method: string,
    params?: object,
    sessionId?: string,
  ): Promise<TResult> {
    const state = this.#attachments.get(tabId);
    if (state === undefined) {
      throw new DebuggerTransportError('NOT_ATTACHED', 'Browser debugger is not attached.');
    }
    await state.ready;
    if (!state.attached) {
      throw new DebuggerTransportError('NOT_ATTACHED', 'Browser debugger is not attached.');
    }

    const target: ChromeDebuggerTarget = sessionId === undefined ? { tabId } : { tabId, sessionId };
    try {
      return (await this.#api.sendCommand(target, method, params)) as TResult;
    } catch {
      throw new DebuggerTransportError('COMMAND_FAILED', 'Browser debugger command failed.');
    }
  }

  /** Subscribes to normalized protocol and detach events and returns an idempotent unsubscribe. */
  subscribe(listener: DebuggerEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Returns initialized child iframe sessions in deterministic attachment order. */
  async listSessions(tabId: number): Promise<readonly DebuggerSessionDescriptor[]> {
    const state = this.#attachments.get(tabId);
    if (state === undefined) return [];
    await state.ready;

    for (let pass = 0; pass < 64; pass += 1) {
      const sessions = [...state.sessions.values()];
      await Promise.all(sessions.map((session) => session.ready));
      if (this.#attachments.get(tabId) !== state || sessions.length === state.sessions.size) {
        break;
      }
    }
    if (this.#attachments.get(tabId) !== state) return [];

    const descriptors: DebuggerSessionDescriptor[] = [];
    for (const session of state.sessions.values()) {
      if (await session.ready) descriptors.push(session.descriptor);
    }
    return descriptors;
  }

  /** Reports whether required domains finished enabling for the selected tab. */
  isAttached(tabId: number): boolean {
    return this.#attachments.get(tabId)?.attached === true;
  }

  /** Performs first attachment and domain setup while cleaning state after any partial failure. */
  async #attach(tabId: number, state: AttachmentState): Promise<void> {
    try {
      await this.#api.attach({ tabId }, '1.3');
      for (const method of enabledDomains) {
        await this.#api.sendCommand({ tabId }, method);
      }
      await this.#api.sendCommand({ tabId }, 'Target.setAutoAttach', iframeAutoAttach);
      state.attached = true;
    } catch {
      if (this.#attachments.get(tabId) === state) this.#attachments.delete(tabId);
      throw new DebuggerTransportError('ATTACH_FAILED', 'Unable to attach browser debugger.');
    }
  }

  /** Tracks auto-attached iframe sessions and removes detached subtrees synchronously. */
  #trackSessionEvent(source: ChromeDebuggerTarget, method: string, params: object): void {
    const state = this.#attachments.get(source.tabId);
    if (state === undefined) return;
    if (method === 'Target.attachedToTarget') {
      const payload = params as {
        readonly sessionId?: unknown;
        readonly targetInfo?: {
          readonly targetId?: unknown;
          readonly type?: unknown;
          readonly url?: unknown;
          readonly title?: unknown;
        };
      };
      const target = payload.targetInfo;
      if (
        typeof payload.sessionId !== 'string' ||
        typeof target?.targetId !== 'string' ||
        target.type !== 'iframe'
      ) {
        return;
      }
      const descriptor: DebuggerSessionDescriptor = {
        sessionId: payload.sessionId,
        targetId: target.targetId,
        type: target.type,
        url: typeof target.url === 'string' ? target.url : '',
        title: typeof target.title === 'string' ? target.title : '',
        parentSessionId: source.sessionId ?? null,
      };
      const session: ChildSessionState = {
        descriptor,
        ready: Promise.resolve(false),
      };
      state.sessions.set(descriptor.sessionId, session);
      session.ready = this.#initializeChildSession(source.tabId, descriptor, state);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const sessionId = (params as { readonly sessionId?: unknown }).sessionId;
      if (typeof sessionId === 'string') this.#removeSessionTree(state, sessionId);
    }
  }

  /** Enables observation/input domains and recursive auto-attach for one child iframe target. */
  async #initializeChildSession(
    tabId: number,
    descriptor: DebuggerSessionDescriptor,
    state: AttachmentState,
  ): Promise<boolean> {
    const target = { tabId, sessionId: descriptor.sessionId };
    try {
      for (const method of enabledDomains) {
        await this.#api.sendCommand(target, method);
      }
      await this.#api.sendCommand(target, 'Target.setAutoAttach', iframeAutoAttach);
      return this.#attachments.get(tabId) === state;
    } catch {
      const current = state.sessions.get(descriptor.sessionId);
      if (current?.descriptor === descriptor) this.#removeSessionTree(state, descriptor.sessionId);
      return false;
    }
  }

  /** Removes a detached session and every recursively attached descendant. */
  #removeSessionTree(state: AttachmentState, sessionId: string): void {
    const pending = [sessionId];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      state.sessions.delete(current);
      for (const child of state.sessions.values()) {
        if (child.descriptor.parentSessionId === current) pending.push(child.descriptor.sessionId);
      }
    }
  }

  /** Delivers a normalized event to a snapshot of listeners so unsubscription is safe mid-loop. */
  #emit(event: Parameters<DebuggerEventListener>[0]): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}
