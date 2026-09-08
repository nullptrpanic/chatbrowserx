const CDP_PROTOCOL_VERSION = '1.3';
const MAX_METHOD_LENGTH = 160;
const MAX_SESSION_ID_LENGTH = 512;
const COMMAND_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 5_000;

export interface DebuggerSession {
  readonly tabId: number;
  readonly sessionId?: string;
}

export type DebuggerTransportErrorCode =
  | 'INVALID_TARGET'
  | 'INVALID_COMMAND'
  | 'ATTACH_FAILED'
  | 'DETACH_FAILED'
  | 'COMMAND_FAILED'
  | 'COMMAND_TIMEOUT';

export class DebuggerTransportError extends Error {
  readonly code: DebuggerTransportErrorCode;

  constructor(code: DebuggerTransportErrorCode, message: string) {
    super(message);
    this.name = 'DebuggerTransportError';
    this.code = code;
  }
}

export type DebuggerEventListener = (
  session: DebuggerSession,
  method: string,
  params: Readonly<Record<string, unknown>>,
) => void;

export type DebuggerDetachListener = (session: DebuggerSession, reason: string) => void;

type ChromeDebuggerEventHandler = (
  source: DebuggerSession,
  method: string,
  params?: Readonly<Record<string, unknown>>,
) => void;

type ChromeDebuggerDetachHandler = (source: DebuggerSession, reason: string) => void;

interface ChromeDebuggerEventPort<TListener> {
  addListener(listener: TListener): void;
  removeListener(listener: TListener): void;
}

/** Minimal injectable surface used from chrome.debugger. */
export interface ChromeDebuggerApi {
  attach(target: DebuggerSession, requiredVersion: string): Promise<void>;
  detach(target: DebuggerSession): Promise<void>;
  sendCommand(
    target: DebuggerSession,
    method: string,
    commandParams?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  readonly onEvent: ChromeDebuggerEventPort<ChromeDebuggerEventHandler>;
  readonly onDetach: ChromeDebuggerEventPort<ChromeDebuggerDetachHandler>;
}

export interface DebuggerTransport {
  attach(tabId: number): Promise<void>;
  detach(tabId: number): Promise<void>;
  send<TResult>(
    session: DebuggerSession,
    method: string,
    params?: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TResult>;
  onEvent(listener: DebuggerEventListener): () => void;
  onDetach(listener: DebuggerDetachListener): () => void;
}

function isValidTabId(tabId: number): boolean {
  return Number.isSafeInteger(tabId) && tabId >= 0;
}

function isBoundedText(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.length <= maximumLength;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSession(session: DebuggerSession): void {
  if (!isValidTabId(session.tabId)) {
    throw new DebuggerTransportError('INVALID_TARGET', 'The browser target is invalid.');
  }
  if (session.sessionId !== undefined && !isBoundedText(session.sessionId, MAX_SESSION_ID_LENGTH)) {
    throw new DebuggerTransportError('INVALID_TARGET', 'The browser target is invalid.');
  }
}

function normalizeSession(source: DebuggerSession): DebuggerSession | undefined {
  try {
    validateSession(source);
  } catch {
    return undefined;
  }
  return source.sessionId === undefined
    ? { tabId: source.tabId }
    : { tabId: source.tabId, sessionId: source.sessionId };
}

/** Stops waiting, not the dispatched browser effect; callers must never infer safe replay. */
function boundedNativeCall<T>(
  invoke: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(new DOMException('Browser command was aborted.', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      clear();
      reject(new DOMException('Browser command was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      clear();
      reject(
        new DebuggerTransportError(
          'COMMAND_TIMEOUT',
          'The browser command timed out; its result is unknown.',
        ),
      );
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    // Both handlers remain attached after cancellation, so late native failures are consumed.
    try {
      void invoke().then(
        (value) => {
          clear();
          resolve(value);
        },
        (error: unknown) => {
          clear();
          reject(error);
        },
      );
    } catch (error) {
      clear();
      reject(error);
    }
  });
}

/** Binds cancellation to one operation, without mutating a shared transport or session. */
export function withDebuggerSignal(
  transport: DebuggerTransport,
  signal: AbortSignal,
): DebuggerTransport {
  let timedOut: DebuggerTransportError | undefined;
  return {
    attach: (tabId) => transport.attach(tabId),
    detach: (tabId) => transport.detach(tabId),
    async send(session, method, params) {
      const cleanup = isCleanup(method, params);
      if (timedOut && !cleanup) throw timedOut;
      try {
        return await transport.send(session, method, params, cleanup ? undefined : signal);
      } catch (error) {
        if (error instanceof DebuggerTransportError && error.code === 'COMMAND_TIMEOUT')
          timedOut ??= error;
        throw timedOut ?? error;
      }
    },
    onEvent: (listener) => transport.onEvent(listener),
    onDetach: (listener) => transport.onDetach(listener),
  };
}

function isCleanup(method: string, params?: Readonly<Record<string, unknown>>): boolean {
  return (
    method === 'Runtime.releaseObject' ||
    (method === 'Page.setInterceptFileChooserDialog' && params?.enabled === false) ||
    (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') ||
    (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp')
  );
}

/** Wraps chrome.debugger behind validation, stable failures, and removable listeners. */
export class ChromeDebuggerTransport implements DebuggerTransport {
  readonly #api: ChromeDebuggerApi;

  constructor(api: ChromeDebuggerApi = chrome.debugger as unknown as ChromeDebuggerApi) {
    this.#api = api;
  }

  async attach(tabId: number): Promise<void> {
    validateSession({ tabId });
    try {
      await boundedNativeCall(
        () => this.#api.attach({ tabId }, CDP_PROTOCOL_VERSION),
        COMMAND_TIMEOUT_MS,
      );
    } catch {
      throw new DebuggerTransportError('ATTACH_FAILED', 'The browser tab could not be attached.');
    }
  }

  async detach(tabId: number): Promise<void> {
    validateSession({ tabId });
    try {
      await boundedNativeCall(() => this.#api.detach({ tabId }), CLEANUP_TIMEOUT_MS);
    } catch {
      throw new DebuggerTransportError('DETACH_FAILED', 'The browser tab could not be detached.');
    }
  }

  async send<TResult>(
    session: DebuggerSession,
    method: string,
    params?: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TResult> {
    validateSession(session);
    if (!isBoundedText(method, MAX_METHOD_LENGTH)) {
      throw new DebuggerTransportError('INVALID_COMMAND', 'The browser command is invalid.');
    }
    if (params !== undefined && !isPlainRecord(params)) {
      throw new DebuggerTransportError('INVALID_COMMAND', 'The browser command is invalid.');
    }

    try {
      return (await boundedNativeCall(
        () => this.#api.sendCommand(session, method, params),
        isCleanup(method, params) ? CLEANUP_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
        signal,
      )) as TResult;
    } catch (error) {
      if (
        error instanceof DebuggerTransportError ||
        (error instanceof DOMException && error.name === 'AbortError')
      )
        throw error;
      throw new DebuggerTransportError(
        'COMMAND_FAILED',
        'The browser command could not be completed.',
      );
    }
  }

  onEvent(listener: DebuggerEventListener): () => void {
    const handler: ChromeDebuggerEventHandler = (source, method, params) => {
      const session = normalizeSession(source);
      if (session === undefined || !isBoundedText(method, MAX_METHOD_LENGTH)) return;
      listener(session, method, isPlainRecord(params) ? params : {});
    };
    this.#api.onEvent.addListener(handler);
    return () => this.#api.onEvent.removeListener(handler);
  }

  onDetach(listener: DebuggerDetachListener): () => void {
    const handler: ChromeDebuggerDetachHandler = (source, reason) => {
      const session = normalizeSession(source);
      if (session === undefined) return;
      listener(session, reason);
    };
    this.#api.onDetach.addListener(handler);
    return () => this.#api.onDetach.removeListener(handler);
  }
}
