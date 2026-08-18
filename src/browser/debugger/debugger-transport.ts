const CDP_PROTOCOL_VERSION = '1.3';
const MAX_METHOD_LENGTH = 160;
const MAX_SESSION_ID_LENGTH = 512;

export interface DebuggerSession {
  readonly tabId: number;
  readonly sessionId?: string;
}

export type DebuggerTransportErrorCode =
  'INVALID_TARGET' | 'INVALID_COMMAND' | 'ATTACH_FAILED' | 'DETACH_FAILED' | 'COMMAND_FAILED';

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

/** Wraps chrome.debugger behind validation, stable failures, and removable listeners. */
export class ChromeDebuggerTransport implements DebuggerTransport {
  readonly #api: ChromeDebuggerApi;

  constructor(api: ChromeDebuggerApi = chrome.debugger as unknown as ChromeDebuggerApi) {
    this.#api = api;
  }

  async attach(tabId: number): Promise<void> {
    validateSession({ tabId });
    try {
      await this.#api.attach({ tabId }, CDP_PROTOCOL_VERSION);
    } catch {
      throw new DebuggerTransportError('ATTACH_FAILED', 'The browser tab could not be attached.');
    }
  }

  async detach(tabId: number): Promise<void> {
    validateSession({ tabId });
    try {
      await this.#api.detach({ tabId });
    } catch {
      throw new DebuggerTransportError('DETACH_FAILED', 'The browser tab could not be detached.');
    }
  }

  async send<TResult>(
    session: DebuggerSession,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<TResult> {
    validateSession(session);
    if (!isBoundedText(method, MAX_METHOD_LENGTH)) {
      throw new DebuggerTransportError('INVALID_COMMAND', 'The browser command is invalid.');
    }
    if (params !== undefined && !isPlainRecord(params)) {
      throw new DebuggerTransportError('INVALID_COMMAND', 'The browser command is invalid.');
    }

    try {
      return (await this.#api.sendCommand(session, method, params)) as TResult;
    } catch {
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
