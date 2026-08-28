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
const MAX_LIST_CURSORS = 16;
const MAX_GET_REQUESTS = 5;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_GET_RESULTS_CHARACTERS = 80 * 1024;
const MAX_JSON_SANITIZE_CHARACTERS = 512 * 1024;
const MAX_HEADER_COUNT = 12;
const MAX_HEADER_NAME = 100;
const MAX_HEADER_VALUE = 256;
const MAX_URL_CHARACTERS = 4_096;
const NETWORK_ENABLE_PARAMETERS = {
  maxTotalBufferSize: 10 * 1024 * 1024,
  maxResourceBufferSize: 1024 * 1024,
  maxPostDataSize: 0,
} as const;
const CAPTURE_STARTED_MESSAGE =
  'Capture started. Earlier traffic is unavailable, and any prior frozen snapshot was replaced. On the next model turn, re-read the available tools: browser_network_list, browser_network_get, and browser_network_stop are now available. Keep capture active until the requested user-visible workflow is complete; network_idle alone does not prove asynchronous business completion. For initial page traffic, reload after starting. After completion, wait for final network quiet, list every recent cursor page, and read needed bodies. If stop happens first, the frozen snapshot remains readable until the next start.';
const SENSITIVE_NAME =
  /(?:^|[-_])(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|token|secret|password|passwd|api[-_]?key|credential|session)(?:$|[-_])/i;

export type NetworkCaptureErrorCode =
  'NETWORK_CAPTURE_LOST' | 'NETWORK_LIST_CURSOR_INVALID' | 'NETWORK_REQUEST_NOT_FOUND';

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
  readonly startedAt: number;
  readonly capacity: number;
  readonly message: string;
}

export interface NetworkCaptureCoverage {
  readonly startedAt: number;
  readonly snapshotAt: number;
  readonly lastActivityAt: number | null;
  readonly totalCaptured: number;
  readonly retainedCount: number;
  readonly droppedCount: number;
  readonly inFlightCount: number;
  readonly bufferLossless: boolean;
}

export interface NetworkRequestPage {
  readonly requests: readonly NetworkRequestSummary[];
  readonly mode: NetworkListMode;
  readonly matchedRequestCount: number;
  readonly resultCount: number;
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly coverage: NetworkCaptureCoverage;
}

export interface NetworkCaptureStopped {
  readonly stopped: true;
  readonly alreadyStopped: boolean;
  readonly startedAt: number | null;
  readonly stoppedAt: number;
  readonly lastActivityAt: number | null;
  readonly totalCaptured: number;
  readonly retainedCount: number;
  readonly droppedCount: number;
  readonly inFlightCount: number;
  readonly bufferLossless: boolean;
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
  /** Present only for endpoint_sample list results. */
  readonly occurrenceCount?: number | undefined;
}

export interface NetworkBody {
  readonly included: boolean;
  readonly available: boolean;
  readonly encoding: 'utf8' | null;
  readonly text?: string | undefined;
  readonly truncated: boolean;
  readonly reason?: 'no_body' | 'binary' | 'unavailable' | 'invalid_json' | 'too_large' | undefined;
}

export interface NetworkRequestDetails extends NetworkRequestSummary {
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly protocol: string | null;
  readonly statusText: string | null;
  readonly requestBody: NetworkBody;
  readonly responseBody: NetworkBody;
}

export type NetworkListMode = 'recent' | 'endpoint_sample';

export interface NetworkGetRequest {
  readonly requestId: string;
  readonly includeRequestBody: boolean;
  readonly includeResponseBody: boolean;
}

export type NetworkGetResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly request: NetworkRequestDetails;
    }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly code: 'NETWORK_REQUEST_NOT_FOUND';
      readonly message: string;
    };

export interface NetworkCapturePort {
  start(tabId: number, signal: AbortSignal): Promise<NetworkCaptureStarted>;
  list(
    tabId: number,
    urlPattern: string,
    limit: number,
    mode: NetworkListMode,
    cursor: string,
  ): Promise<NetworkRequestPage>;
  get(tabId: number, requests: readonly NetworkGetRequest[]): Promise<readonly NetworkGetResult[]>;
  stop(tabId: number): Promise<NetworkCaptureStopped>;
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
  readonly requestMimeType: string | null;
  readonly hasPostData: boolean;
  responseHeaders: Readonly<Record<string, string>>;
}

interface CaptureState {
  readonly tabId: number;
  readonly generation: number;
  readonly startedAt: number;
  readonly records: CapturedRequest[];
  readonly byOpaqueId: Map<string, CapturedRequest>;
  readonly activeByCdpId: Map<string, CapturedRequest>;
  readonly inFlightByCdpId: Set<string>;
  readonly sessions: Map<string, DebuggerSession>;
  readonly listCursors: Map<string, NetworkListCursor>;
  stoppedAt: number | null;
  lastActivityAt: number | null;
  totalCaptured: number;
  droppedCount: number;
}

interface NetworkListCursor {
  readonly urlPattern: string;
  readonly mode: NetworkListMode;
  readonly results: readonly NetworkRequestSummary[];
  readonly matchedRequestCount: number;
  readonly coverage: NetworkCaptureCoverage;
  readonly offset: number;
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

function mimeTypeFromHeaders(value: unknown): string | null {
  const headers = plainRecord(value);
  if (!headers) return null;
  for (const [name, rawValue] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-type') continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') return null;
    return boundedString(
      String(rawValue)
        .replace(/[\r\n]+/g, ' ')
        .trim(),
      200,
    );
  }
  return null;
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

function isFormMimeType(mimeType: string | null): boolean {
  return mimeType !== null && /^application\/x-www-form-urlencoded(?:$|;)/i.test(mimeType);
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
): { text: string; truncated: boolean } | { reason: 'invalid_json' | 'too_large' } {
  let sanitized = text;
  if (isJsonMimeType(mimeType) || isFormMimeType(mimeType)) {
    if (text.length > MAX_JSON_SANITIZE_CHARACTERS) return { reason: 'too_large' };
  }
  if (isJsonMimeType(mimeType)) {
    try {
      sanitized = JSON.stringify(redactJson(JSON.parse(text)));
    } catch {
      return { reason: 'invalid_json' };
    }
  } else if (isFormMimeType(mimeType)) {
    const redacted = new URLSearchParams();
    let count = 0;
    for (const [rawName, value] of new URLSearchParams(text)) {
      if (count >= 1_000) break;
      const name = rawName.slice(0, 200);
      redacted.append(name, sensitiveName(name) ? '[redacted]' : value);
      count += 1;
    }
    sanitized = redacted.toString();
  }
  return truncateUtf8(sanitized, MAX_BODY_BYTES);
}

function endpointSignature(record: CapturedRequest): string {
  try {
    const url = new URL(record.url);
    const queryNames = [...new Set(url.searchParams.keys())].sort().join('&');
    return `${record.method}\u001f${url.origin}\u001f${url.pathname}\u001f${queryNames}`;
  } catch {
    return `${record.method}\u001f${record.url}`;
  }
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

function bodyWithCharacterLimit(body: NetworkBody, maximum: number): NetworkBody {
  if (body.text === undefined || body.text.length <= maximum) return body;
  return { ...body, text: body.text.slice(0, maximum), truncated: true };
}

function resultWithBodyLimit(result: NetworkGetResult, maximum: number): NetworkGetResult {
  if (!result.ok) return result;
  return {
    ...result,
    request: {
      ...result.request,
      requestBody: bodyWithCharacterLimit(result.request.requestBody, maximum),
      responseBody: bodyWithCharacterLimit(result.request.responseBody, maximum),
    },
  };
}

function boundedGetResults(results: readonly NetworkGetResult[]): readonly NetworkGetResult[] {
  if (JSON.stringify(results).length <= MAX_GET_RESULTS_CHARACTERS) return results;
  let high = 0;
  for (const result of results) {
    if (!result.ok) continue;
    high = Math.max(
      high,
      result.request.requestBody.text?.length ?? 0,
      result.request.responseBody.text?.length ?? 0,
    );
  }
  let low = 0;
  let fitted = results.map((item) => resultWithBodyLimit(item, 0));
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = results.map((item) => resultWithBodyLimit(item, middle));
    if (JSON.stringify(candidate).length <= MAX_GET_RESULTS_CHARACTERS) {
      fitted = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return fitted;
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
    if (existing && existing.stoppedAt === null) {
      return {
        tabId,
        generation: existing.generation,
        alreadyActive: true,
        startedAt: existing.startedAt,
        capacity: MAX_CAPTURED_REQUESTS,
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
      if (existing !== undefined && existing.stoppedAt !== null) {
        this.#captures.set(tabId, existing);
      } else {
        this.#captures.delete(tabId);
      }
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
      startedAt: state.startedAt,
      capacity: MAX_CAPTURED_REQUESTS,
      message: CAPTURE_STARTED_MESSAGE,
    };
  }

  async list(
    tabId: number,
    urlPattern: string,
    limit: number,
    mode: NetworkListMode,
    cursor: string,
  ): Promise<NetworkRequestPage> {
    const state = this.#requiredState(tabId);
    const pattern = urlPattern.slice(0, 500).toLowerCase();
    const boundedLimit = Math.max(1, Math.min(MAX_LIST_RESULTS, Math.floor(limit)));
    if (cursor.length > 0) {
      const saved = state.listCursors.get(cursor);
      if (!saved || saved.urlPattern !== pattern || saved.mode !== mode) {
        throw new NetworkCaptureError(
          'NETWORK_LIST_CURSOR_INVALID',
          'The network list cursor is unavailable. Start listing again with an empty cursor.',
          true,
        );
      }
      state.listCursors.delete(cursor);
      return this.#page(state, saved, boundedLimit);
    }
    const matched = state.records.filter(
      (record) => pattern.length === 0 || record.url.toLowerCase().includes(pattern),
    );
    let results: readonly NetworkRequestSummary[];
    if (mode === 'endpoint_sample') {
      const samples = new Map<string, { record: CapturedRequest; occurrenceCount: number }>();
      for (const record of [...matched].reverse()) {
        const key = endpointSignature(record);
        const existing = samples.get(key);
        if (existing) existing.occurrenceCount += 1;
        else samples.set(key, { record, occurrenceCount: 1 });
      }
      results = [...samples.values()].map(({ record, occurrenceCount }) => ({
        ...summary(record),
        occurrenceCount,
      }));
    } else results = [...matched].reverse().map(summary);
    const snapshot: NetworkListCursor = {
      urlPattern: pattern,
      mode,
      results,
      matchedRequestCount: matched.length,
      coverage: this.#coverage(state, this.#dependencies.clock.now()),
      offset: 0,
    };
    return this.#page(state, snapshot, boundedLimit);
  }

  async get(
    tabId: number,
    requests: readonly NetworkGetRequest[],
  ): Promise<readonly NetworkGetResult[]> {
    const state = this.#requiredState(tabId);
    const seen = new Set<string>();
    const results: NetworkGetResult[] = [];
    for (const input of requests.slice(0, MAX_GET_REQUESTS)) {
      if (seen.has(input.requestId)) continue;
      seen.add(input.requestId);
      const record = state.byOpaqueId.get(input.requestId);
      if (!record) {
        results.push({
          ok: false,
          requestId: input.requestId,
          code: 'NETWORK_REQUEST_NOT_FOUND',
          message: 'The captured network request is no longer available.',
        });
        continue;
      }
      const requestBody = input.includeRequestBody
        ? await this.#requestBody(state, record)
        : this.#requestBodyMetadata(state, record);
      const responseBody = input.includeResponseBody
        ? await this.#responseBody(state, record)
        : this.#responseBodyMetadata(state, record);
      results.push({
        ok: true,
        requestId: input.requestId,
        request: {
          ...summary(record),
          requestHeaders: record.requestHeaders,
          responseHeaders: record.responseHeaders,
          protocol: record.protocol,
          statusText: record.statusText,
          requestBody,
          responseBody,
        },
      });
    }
    return boundedGetResults(results);
  }

  async stop(tabId: number): Promise<NetworkCaptureStopped> {
    const state = this.#captures.get(tabId);
    const stoppedAt = this.#dependencies.clock.now();
    if (!state) {
      return {
        stopped: true,
        alreadyStopped: true,
        startedAt: null,
        stoppedAt,
        lastActivityAt: null,
        totalCaptured: 0,
        retainedCount: 0,
        droppedCount: 0,
        inFlightCount: 0,
        bufferLossless: true,
      };
    }
    const alreadyStopped = state.stoppedAt !== null;
    state.stoppedAt ??= stoppedAt;
    return {
      stopped: true,
      alreadyStopped,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      lastActivityAt: state.lastActivityAt,
      totalCaptured: state.totalCaptured,
      retainedCount: state.records.length,
      droppedCount: state.droppedCount,
      inFlightCount: state.inFlightByCdpId.size,
      bufferLossless: state.droppedCount === 0,
    };
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
      startedAt: this.#dependencies.clock.now(),
      records: [],
      byOpaqueId: new Map(),
      activeByCdpId: new Map(),
      inFlightByCdpId: new Set(),
      sessions,
      listCursors: new Map(),
      stoppedAt: null,
      lastActivityAt: null,
      totalCaptured: 0,
      droppedCount: 0,
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

  #coverage(state: CaptureState, snapshotAt: number): NetworkCaptureCoverage {
    return {
      startedAt: state.startedAt,
      snapshotAt: state.stoppedAt ?? snapshotAt,
      lastActivityAt: state.lastActivityAt,
      totalCaptured: state.totalCaptured,
      retainedCount: state.records.length,
      droppedCount: state.droppedCount,
      inFlightCount: state.inFlightByCdpId.size,
      bufferLossless: state.droppedCount === 0,
    };
  }

  #page(state: CaptureState, snapshot: NetworkListCursor, limit: number): NetworkRequestPage {
    const end = Math.min(snapshot.results.length, snapshot.offset + limit);
    const hasMore = end < snapshot.results.length;
    let nextCursor: string | null = null;
    if (hasMore) {
      nextCursor = this.#cursorId(state);
      state.listCursors.set(nextCursor, { ...snapshot, offset: end });
      while (state.listCursors.size > MAX_LIST_CURSORS) {
        const oldest = state.listCursors.keys().next().value;
        if (typeof oldest !== 'string') break;
        state.listCursors.delete(oldest);
      }
    }
    return {
      requests: snapshot.results.slice(snapshot.offset, end),
      mode: snapshot.mode,
      matchedRequestCount: snapshot.matchedRequestCount,
      resultCount: snapshot.results.length,
      hasMore,
      nextCursor,
      coverage: snapshot.coverage,
    };
  }

  #handleEvent(
    session: DebuggerSession,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const state = this.#captures.get(session.tabId);
    if (!state || state.stoppedAt !== null) return;
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
    const key = requestKey(session, cdpRequestId);
    const record = state.activeByCdpId.get(key);
    if (method === 'Network.responseReceived') {
      if (record) this.#recordResponse(state, record, params);
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      state.inFlightByCdpId.delete(key);
      if (record) this.#finishRequest(state, record, params, method === 'Network.loadingFailed');
    }
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
    if (current) {
      state.activeByCdpId.set(key, current);
      state.inFlightByCdpId.add(key);
    }
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
    const startedAt = this.#dependencies.clock.now();
    state.lastActivityAt = startedAt;
    state.totalCaptured += 1;
    const opaqueId = this.#opaqueId(state);
    if (!opaqueId) {
      state.droppedCount += 1;
      return null;
    }
    const record: CapturedRequest = {
      opaqueId,
      cdpRequestId,
      session: { ...session },
      url,
      method: (boundedString(request.method, 20) ?? 'GET').toUpperCase(),
      resourceType: boundedString(params.type, 100) ?? 'Other',
      startedAt,
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
      requestMimeType: mimeTypeFromHeaders(request.headers),
      hasPostData: request.hasPostData === true,
      responseHeaders: {},
    };
    state.records.push(record);
    state.byOpaqueId.set(opaqueId, record);
    while (state.records.length > MAX_CAPTURED_REQUESTS) {
      const removed = state.records.shift();
      if (!removed) break;
      state.droppedCount += 1;
      state.byOpaqueId.delete(removed.opaqueId);
      const key = requestKey(removed.session, removed.cdpRequestId);
      if (state.activeByCdpId.get(key) === removed) state.activeByCdpId.delete(key);
    }
    return record;
  }

  #recordResponse(
    state: CaptureState,
    record: CapturedRequest,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const response = plainRecord(params.response);
    if (!response) return;
    this.#applyResponse(record, response);
    record.resourceType = boundedString(params.type, 100) ?? record.resourceType;
    state.lastActivityAt = this.#dependencies.clock.now();
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
    state: CaptureState,
    record: CapturedRequest,
    params: Readonly<Record<string, unknown>>,
    failed: boolean,
  ): void {
    record.completed = true;
    record.failed = failed;
    record.durationMs = this.#duration(record, finiteNumber(params.timestamp));
    record.encodedDataLength = failed ? null : finiteNumber(params.encodedDataLength);
    state.lastActivityAt = this.#dependencies.clock.now();
  }

  #duration(record: CapturedRequest, endTimestamp: number | null): number | null {
    return record.startTimestamp === null || endTimestamp === null
      ? null
      : Math.max(0, Math.round((endTimestamp - record.startTimestamp) * 1_000));
  }

  #requestBodyMetadata(state: CaptureState, record: CapturedRequest): NetworkBody {
    return {
      included: false,
      available:
        record.hasPostData &&
        !record.redirected &&
        state.sessions.has(sessionKey(record.session)) &&
        isTextMimeType(record.requestMimeType),
      encoding: null,
      truncated: false,
    };
  }

  #responseBodyMetadata(state: CaptureState, record: CapturedRequest): NetworkBody {
    return {
      included: false,
      available:
        record.completed &&
        !record.failed &&
        !record.redirected &&
        state.sessions.has(sessionKey(record.session)) &&
        isTextMimeType(record.mimeType),
      encoding: null,
      truncated: false,
    };
  }

  async #requestBody(state: CaptureState, record: CapturedRequest): Promise<NetworkBody> {
    if (!record.hasPostData) {
      return {
        included: true,
        available: false,
        encoding: null,
        truncated: false,
        reason: 'no_body',
      };
    }
    if (
      record.redirected ||
      !state.sessions.has(sessionKey(record.session)) ||
      !isTextMimeType(record.requestMimeType)
    ) {
      return {
        included: true,
        available: false,
        encoding: null,
        truncated: false,
        reason: isTextMimeType(record.requestMimeType) ? 'unavailable' : 'binary',
      };
    }
    try {
      const response =
        await this.#dependencies.transport.send<Protocol.Network.GetRequestPostDataResponse>(
          record.session,
          'Network.getRequestPostData',
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
      const sanitized = sanitizeBodyText(response.postData, record.requestMimeType);
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

  async #responseBody(state: CaptureState, record: CapturedRequest): Promise<NetworkBody> {
    if (
      !record.completed ||
      record.failed ||
      record.redirected ||
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

  #cursorId(state: CaptureState): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.#dependencies.ids.create('networkCursor').trim();
      if (id.length > 0 && id.length <= 512 && !state.listCursors.has(id)) return id;
    }
    throw new NetworkCaptureError(
      'NETWORK_CAPTURE_LOST',
      'A network list cursor could not be created. Start listing again with an empty cursor.',
      true,
    );
  }
}
