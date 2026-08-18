import type { Protocol } from 'devtools-protocol';
import type { IdGenerator } from '../../shared/ids';
import type { Clock } from '../../shared/time';
import type { DebuggerSession, DebuggerTransport } from '../debugger/debugger-transport';
import type {
  BrowserSessionSnapshot,
  TargetSessionRegistry,
} from '../debugger/target-session-registry';

const MAX_CAPTURED_REQUESTS = 500;
const MAX_LIST_RESULTS = 100;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DETAIL_CHARACTERS = 100 * 1024;
const MAX_JSON_SANITIZE_CHARACTERS = 512 * 1024;
const MAX_HEADER_COUNT = 25;
const MAX_HEADER_NAME = 100;
const MAX_HEADER_VALUE = 512;
const MAX_URL_CHARACTERS = 4_096;
const NETWORK_ENABLE_PARAMETERS = {
  maxTotalBufferSize: 10 * 1024 * 1024,
  maxResourceBufferSize: 1024 * 1024,
  maxPostDataSize: 0,
} as const;
const CAPTURE_STARTED_MESSAGE =
  'Capture started. Earlier traffic is unavailable. For initial page traffic, reload this tab, wait for network_idle, then list requests.';
const SENSITIVE_NAME =
  /(?:^|[-_])(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|token|secret|password|passwd|api[-_]?key|credential|session)(?:$|[-_])/i;

export type NetworkCaptureErrorCode = 'NETWORK_CAPTURE_LOST' | 'NETWORK_REQUEST_NOT_FOUND';

export class NetworkCaptureError extends Error {
  readonly code: NetworkCaptureErrorCode;
  readonly retryable: boolean;

  constructor(code: NetworkCaptureErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'NetworkCaptureError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface NetworkCaptureStarted {
  readonly tabId: number;
  readonly generation: number;
  readonly alreadyActive: boolean;
  readonly message: string;
}

export interface NetworkRequestSummary {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly status: number | null;
  readonly mimeType: string | null;
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly encodedDataLength: number | null;
  readonly completed: boolean;
  readonly failed: boolean;
  readonly redirected: boolean;
  readonly fromCache: boolean;
}

export interface NetworkResponseBody {
  readonly included: boolean;
  readonly available: boolean;
  readonly encoding: 'utf8' | null;
  readonly text?: string | undefined;
  readonly truncated: boolean;
  readonly reason?: 'binary' | 'unavailable' | 'invalid_json' | undefined;
}

export interface NetworkRequestDetails extends NetworkRequestSummary {
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly protocol: string | null;
  readonly statusText: string | null;
  readonly requestBodyIncluded: false;
  readonly body: NetworkResponseBody;
}

export interface NetworkCapturePort {
  start(tabId: number, signal: AbortSignal): Promise<NetworkCaptureStarted>;
  list(tabId: number, urlPattern: string, limit: number): Promise<readonly NetworkRequestSummary[]>;
  get(tabId: number, requestId: string, includeBody: boolean): Promise<NetworkRequestDetails>;
  stop(tabId: number): Promise<void>;
}

export interface NetworkCaptureDependencies {
  readonly sessions: Pick<TargetSessionRegistry, 'ensure'>;
  readonly transport: DebuggerTransport;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

interface CapturedRequest {
  readonly opaqueId: string;
  readonly cdpRequestId: string;
  readonly session: DebuggerSession;
  url: string;
  readonly method: string;
  resourceType: string;
  readonly startedAt: number;
  readonly startTimestamp: number | null;
  durationMs: number | null;
  status: number | null;
  statusText: string | null;
  mimeType: string | null;
  protocol: string | null;
  encodedDataLength: number | null;
  completed: boolean;
  failed: boolean;
  redirected: boolean;
  fromCache: boolean;
  readonly requestHeaders: Readonly<Record<string, string>>;
  responseHeaders: Readonly<Record<string, string>>;
}

interface CaptureState {
  readonly tabId: number;
  readonly generation: number;
  readonly records: CapturedRequest[];
  readonly byOpaqueId: Map<string, CapturedRequest>;
  readonly activeByCdpId: Map<string, CapturedRequest>;
  readonly sessions: Map<string, DebuggerSession>;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Network capture was aborted.', 'AbortError');
}

function sessionKey(session: DebuggerSession): string {
  return session.sessionId ?? 'root';
}

function requestKey(session: DebuggerSession, requestId: string): string {
  return `${sessionKey(session)}\u001f${requestId}`;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function sensitiveName(name: string): boolean {
  return SENSITIVE_NAME.test(name) || /(?:access|refresh|id)[-_]?token/i.test(name);
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (sensitiveName(name)) url.searchParams.set(name, '[redacted]');
    }
    return url.toString().slice(0, MAX_URL_CHARACTERS);
  } catch {
    return null;
  }
}

function sanitizeHeaders(value: unknown): Readonly<Record<string, string>> {
  const headers = plainRecord(value);
  if (!headers) return {};
  const sanitized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (Object.keys(sanitized).length >= MAX_HEADER_COUNT) break;
    const name = rawName.trim().slice(0, MAX_HEADER_NAME);
    if (name.length === 0 || sensitiveName(name)) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') continue;
    let headerValue = String(rawValue)
      .replace(/[\r\n]+/g, ' ')
      .slice(0, MAX_HEADER_VALUE);
    if (/^(?:location|referer)$/i.test(name)) {
      headerValue = safeHttpUrl(headerValue) ?? '[unsupported-url]';
    }
    sanitized[name] = headerValue;
  }
  return sanitized;
}

function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redactJson(item, depth + 1));
  const record = plainRecord(value);
  if (!record) return value;
  const redacted: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(record)) {
    if (count >= 1_000) break;
    redacted[key.slice(0, 200)] = sensitiveName(key) ? '[redacted]' : redactJson(item, depth + 1);
    count += 1;
  }
  return redacted;
}

function isJsonMimeType(mimeType: string | null): boolean {
  return mimeType !== null && /(?:^|[+/])json(?:$|;)/i.test(mimeType);
}

function isTextMimeType(mimeType: string | null): boolean {
  return (
    mimeType === null ||
    /^text\//i.test(mimeType) ||
    /(?:json|javascript|xml|html|graphql|x-www-form-urlencoded)/i.test(mimeType)
  );
}

function truncateUtf8(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximumBytes) return { text: value, truncated: false };
  return {
    text: new TextDecoder().decode(bytes.slice(0, maximumBytes)),
    truncated: true,
  };
}

function sanitizeBodyText(
  text: string,
  mimeType: string | null,
): { text: string; truncated: boolean } | { reason: 'invalid_json' } {
  let sanitized = text;
  if (isJsonMimeType(mimeType)) {
    if (text.length > MAX_JSON_SANITIZE_CHARACTERS) return { reason: 'invalid_json' };
    try {
      sanitized = JSON.stringify(redactJson(JSON.parse(text)));
    } catch {
      return { reason: 'invalid_json' };
    }
  }
  return truncateUtf8(sanitized, MAX_BODY_BYTES);
}

function summary(record: CapturedRequest): NetworkRequestSummary {
  return {
    requestId: record.opaqueId,
    url: record.url,
    method: record.method,
    resourceType: record.resourceType,
    status: record.status,
    mimeType: record.mimeType,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    encodedDataLength: record.encodedDataLength,
    completed: record.completed,
    failed: record.failed,
    redirected: record.redirected,
    fromCache: record.fromCache,
  };
}

function boundedDetails(details: NetworkRequestDetails): NetworkRequestDetails {
  if (JSON.stringify(details).length <= MAX_DETAIL_CHARACTERS || details.body.text === undefined) {
    return details;
  }
  let low = 0;
  let high = details.body.text.length;
  let fitted = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...details,
      body: { ...details.body, text: details.body.text.slice(0, middle), truncated: true },
    };
    if (JSON.stringify(candidate).length <= MAX_DETAIL_CHARACTERS) {
      fitted = candidate.body.text;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { ...details, body: { ...details.body, text: fitted, truncated: true } };
}

/** Owns bounded, in-memory, future-only network capture for attached browser tabs. */
export class NetworkCaptureRegistry implements NetworkCapturePort {
  readonly #dependencies: NetworkCaptureDependencies;
  readonly #captures = new Map<number, CaptureState>();

  constructor(dependencies: NetworkCaptureDependencies) {
    this.#dependencies = dependencies;
    dependencies.transport.onEvent((session, method, params) => {
      this.#handleEvent(session, method, params);
    });
    dependencies.transport.onDetach((session) => {
      if (session.sessionId === undefined) this.#captures.delete(session.tabId);
      else this.#removeSession(session.tabId, session.sessionId);
    });
  }

  async start(tabId: number, signal: AbortSignal): Promise<NetworkCaptureStarted> {
    throwIfAborted(signal);
    const existing = this.#captures.get(tabId);
    if (existing) {
      return {
        tabId,
        generation: existing.generation,
        alreadyActive: true,
        message: CAPTURE_STARTED_MESSAGE,
      };
    }
    const snapshot = await this.#dependencies.sessions.ensure(tabId, signal);
    throwIfAborted(signal);
    const state = this.#createState(snapshot);
    this.#captures.set(tabId, state);
    try {
      for (const session of state.sessions.values()) {
        throwIfAborted(signal);
        await this.#dependencies.transport.send(
          session,
          'Network.enable',
          NETWORK_ENABLE_PARAMETERS,
        );
      }
    } catch {
      this.#captures.delete(tabId);
      if (signal.aborted) throw new DOMException('Network capture was aborted.', 'AbortError');
      throw new NetworkCaptureError(
        'NETWORK_CAPTURE_LOST',
        'Network capture could not be started. Start it again.',
        true,
      );
    }
    return {
      tabId,
      generation: snapshot.generation,
      alreadyActive: false,
      message: CAPTURE_STARTED_MESSAGE,
    };
  }

  async list(
    tabId: number,
    urlPattern: string,
    limit: number,
  ): Promise<readonly NetworkRequestSummary[]> {
    const state = this.#requiredState(tabId);
    const pattern = urlPattern.slice(0, 500).toLowerCase();
    const boundedLimit = Math.max(1, Math.min(MAX_LIST_RESULTS, Math.floor(limit)));
    return state.records
      .filter((record) => pattern.length === 0 || record.url.toLowerCase().includes(pattern))
      .slice(-boundedLimit)
      .reverse()
      .map(summary);
  }

  async get(
    tabId: number,
    requestId: string,
    includeBody: boolean,
  ): Promise<NetworkRequestDetails> {
    const state = this.#requiredState(tabId);
    const record = state.byOpaqueId.get(requestId);
    if (!record) {
      throw new NetworkCaptureError(
        'NETWORK_REQUEST_NOT_FOUND',
        'The captured network request is no longer available.',
        false,
      );
    }
    let body: NetworkResponseBody = {
      included: false,
      available: record.completed && !record.failed,
      encoding: null,
      truncated: false,
    };
    if (includeBody) body = await this.#responseBody(state, record);
    return boundedDetails({
      ...summary(record),
      requestHeaders: record.requestHeaders,
      responseHeaders: record.responseHeaders,
      protocol: record.protocol,
      statusText: record.statusText,
      requestBodyIncluded: false,
      body,
    });
  }

  async stop(tabId: number): Promise<void> {
    const state = this.#captures.get(tabId);
    if (!state) return;
    this.#captures.delete(tabId);
    await Promise.all(
      [...state.sessions.values()].map((session) =>
        this.#dependencies.transport.send(session, 'Network.disable').catch(() => undefined),
      ),
    );
  }

  #createState(snapshot: BrowserSessionSnapshot): CaptureState {
    const sessions = new Map<string, DebuggerSession>();
    sessions.set('root', snapshot.root);
    for (const child of snapshot.children.values()) {
      sessions.set(sessionKey(child.session), child.session);
    }
    return {
      tabId: snapshot.tabId,
      generation: snapshot.generation,
      records: [],
      byOpaqueId: new Map(),
      activeByCdpId: new Map(),
      sessions,
    };
  }

  #requiredState(tabId: number): CaptureState {
    const state = this.#captures.get(tabId);
    if (!state) {
      throw new NetworkCaptureError(
        'NETWORK_CAPTURE_LOST',
        'Network capture is unavailable. Start capture again before listing requests.',
        true,
      );
    }
    return state;
  }

  #handleEvent(
    session: DebuggerSession,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const state = this.#captures.get(session.tabId);
    if (!state) return;
    if (method === 'Target.attachedToTarget') {
      const sessionId = boundedString(params.sessionId, 512);
      const targetInfo = plainRecord(params.targetInfo);
      if (sessionId && targetInfo?.type === 'iframe') {
        const child = { tabId: session.tabId, sessionId } as const;
        state.sessions.set(sessionId, child);
        void this.#dependencies.transport
          .send(child, 'Network.enable', NETWORK_ENABLE_PARAMETERS)
          .catch(() => state.sessions.delete(sessionId));
      }
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const sessionId = boundedString(params.sessionId, 512);
      if (sessionId) this.#removeSession(session.tabId, sessionId);
      return;
    }
    if (method === 'Network.requestWillBeSent') {
      this.#recordRequest(state, session, params);
      return;
    }
    const cdpRequestId = boundedString(params.requestId, 512);
    if (!cdpRequestId) return;
    const record = state.activeByCdpId.get(requestKey(session, cdpRequestId));
    if (!record) return;
    if (method === 'Network.responseReceived') this.#recordResponse(record, params);
    else if (method === 'Network.loadingFinished') this.#finishRequest(record, params, false);
    else if (method === 'Network.loadingFailed') this.#finishRequest(record, params, true);
  }

  #recordRequest(
    state: CaptureState,
    session: DebuggerSession,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const cdpRequestId = boundedString(params.requestId, 512);
    const request = plainRecord(params.request);
    const url = safeHttpUrl(request?.url);
    if (!cdpRequestId || !request || !url) return;
    const key = requestKey(session, cdpRequestId);
    const redirectResponse = plainRecord(params.redirectResponse);
    if (redirectResponse) {
      const previous =
        state.activeByCdpId.get(key) ??
        this.#appendRecord(
          state,
          session,
          cdpRequestId,
          safeHttpUrl(redirectResponse.url),
          request,
          params,
        );
      if (previous) {
        this.#applyResponse(previous, redirectResponse);
        previous.redirected = true;
        previous.completed = true;
        previous.durationMs = this.#duration(previous, finiteNumber(params.timestamp));
      }
    }
    const current = this.#appendRecord(state, session, cdpRequestId, url, request, params);
    if (current) state.activeByCdpId.set(key, current);
  }

  #appendRecord(
    state: CaptureState,
    session: DebuggerSession,
    cdpRequestId: string,
    url: string | null,
    request: Readonly<Record<string, unknown>>,
    params: Readonly<Record<string, unknown>>,
  ): CapturedRequest | null {
    if (!url) return null;
    const opaqueId = this.#opaqueId(state);
    if (!opaqueId) return null;
    const record: CapturedRequest = {
      opaqueId,
      cdpRequestId,
      session: { ...session },
      url,
      method: (boundedString(request.method, 20) ?? 'GET').toUpperCase(),
      resourceType: boundedString(params.type, 100) ?? 'Other',
      startedAt: this.#dependencies.clock.now(),
      startTimestamp: finiteNumber(params.timestamp),
      durationMs: null,
      status: null,
      statusText: null,
      mimeType: null,
      protocol: null,
      encodedDataLength: null,
      completed: false,
      failed: false,
      redirected: false,
      fromCache: false,
      requestHeaders: sanitizeHeaders(request.headers),
      responseHeaders: {},
    };
    state.records.push(record);
    state.byOpaqueId.set(opaqueId, record);
    while (state.records.length > MAX_CAPTURED_REQUESTS) {
      const removed = state.records.shift();
      if (!removed) break;
      state.byOpaqueId.delete(removed.opaqueId);
      const key = requestKey(removed.session, removed.cdpRequestId);
      if (state.activeByCdpId.get(key) === removed) state.activeByCdpId.delete(key);
    }
    return record;
  }

  #recordResponse(record: CapturedRequest, params: Readonly<Record<string, unknown>>): void {
    const response = plainRecord(params.response);
    if (!response) return;
    this.#applyResponse(record, response);
    record.resourceType = boundedString(params.type, 100) ?? record.resourceType;
  }

  #applyResponse(record: CapturedRequest, response: Readonly<Record<string, unknown>>): void {
    record.url = safeHttpUrl(response.url) ?? record.url;
    record.status = finiteNumber(response.status);
    record.statusText = boundedString(response.statusText, 200);
    record.mimeType = boundedString(response.mimeType, 200);
    record.protocol = boundedString(response.protocol, 100);
    record.responseHeaders = sanitizeHeaders(response.headers);
    record.fromCache = response.fromDiskCache === true || response.fromServiceWorker === true;
  }

  #finishRequest(
    record: CapturedRequest,
    params: Readonly<Record<string, unknown>>,
    failed: boolean,
  ): void {
    record.completed = true;
    record.failed = failed;
    record.durationMs = this.#duration(record, finiteNumber(params.timestamp));
    record.encodedDataLength = failed ? null : finiteNumber(params.encodedDataLength);
  }

  #duration(record: CapturedRequest, endTimestamp: number | null): number | null {
    return record.startTimestamp === null || endTimestamp === null
      ? null
      : Math.max(0, Math.round((endTimestamp - record.startTimestamp) * 1_000));
  }

  async #responseBody(state: CaptureState, record: CapturedRequest): Promise<NetworkResponseBody> {
    if (
      !record.completed ||
      record.failed ||
      !state.sessions.has(sessionKey(record.session)) ||
      !isTextMimeType(record.mimeType)
    ) {
      return {
        included: true,
        available: false,
        encoding: null,
        truncated: false,
        reason: isTextMimeType(record.mimeType) ? 'unavailable' : 'binary',
      };
    }
    try {
      const response =
        await this.#dependencies.transport.send<Protocol.Network.GetResponseBodyResponse>(
          record.session,
          'Network.getResponseBody',
          { requestId: record.cdpRequestId },
        );
      if (response.base64Encoded) {
        return {
          included: true,
          available: false,
          encoding: null,
          truncated: false,
          reason: 'binary',
        };
      }
      const sanitized = sanitizeBodyText(response.body, record.mimeType);
      if ('reason' in sanitized) {
        return {
          included: true,
          available: false,
          encoding: null,
          truncated: false,
          reason: sanitized.reason,
        };
      }
      return {
        included: true,
        available: true,
        encoding: 'utf8',
        text: sanitized.text,
        truncated: sanitized.truncated,
      };
    } catch {
      return {
        included: true,
        available: false,
        encoding: null,
        truncated: false,
        reason: 'unavailable',
      };
    }
  }

  #removeSession(tabId: number, sessionId: string): void {
    const state = this.#captures.get(tabId);
    if (!state) return;
    state.sessions.delete(sessionId);
  }

  #opaqueId(state: CaptureState): string | null {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.#dependencies.ids.create('networkRequest').trim();
      if (id.length > 0 && id.length <= 512 && !state.byOpaqueId.has(id)) return id;
    }
    return null;
  }
}
