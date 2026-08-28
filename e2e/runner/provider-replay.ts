import type { BrowserContext, Request } from '@playwright/test';
import { CODEX_RESPONSES_URL } from '../../src/providers/codex/codex-constants';
import type { LiveProviderRequestBodySummary } from './live-types';
import { summarizeProviderSse } from './provider-sse';
import { summarizeResponsesRequestBody } from './provider-trace';

const OMITTED_REPLAY_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
]);

/** Drops transport-only headers while retaining credentials only in the caller's memory. */
export function sanitizeReplayHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLocaleLowerCase();
      return !normalized.startsWith(':') && !OMITTED_REPLAY_HEADERS.has(normalized);
    }),
  );
}

export interface ProviderReplayResponseSummary {
  readonly status: number;
  readonly contentType: string | null;
  readonly bodyBytes: number;
  readonly bodyTooLarge: boolean;
  readonly completed: boolean;
  readonly failed: boolean;
  readonly eventTypes: readonly string[];
  readonly errorCodes: readonly string[];
  readonly errorTypes: readonly string[];
}

export interface ProviderReplayResult {
  readonly request: LiveProviderRequestBodySummary;
  readonly response: ProviderReplayResponseSummary;
}

/** Returns only structural SSE and error labels; response text and model output are discarded. */
export function summarizeReplaySseResponse(
  body: Buffer,
  status: number,
  contentType: string | null,
): ProviderReplayResponseSummary {
  const summary = summarizeProviderSse(body, status);
  return {
    status,
    contentType,
    bodyBytes: summary.bodyBytes,
    bodyTooLarge: summary.bodyTooLarge,
    completed: summary.completed,
    failed: summary.failed,
    eventTypes: summary.eventTypes,
    errorCodes: summary.errorCodes,
    errorTypes: summary.errorTypes,
  };
}

interface ReplayCandidate {
  readonly body: Buffer;
  readonly headers: Promise<Record<string, string>>;
  readonly requestSummary: LiveProviderRequestBodySummary;
}

/** Retains one request only in memory and replays it without exposing credentials or raw content. */
export class ResponsesRequestReplayProbe {
  readonly #context: BrowserContext;
  readonly #extensionOrigin: string;
  #activeUserText = '';
  #capturing = false;
  #latest: ReplayCandidate | null = null;

  constructor(context: BrowserContext, extensionId: string) {
    this.#context = context;
    this.#extensionOrigin = `chrome-extension://${extensionId}`;
    context.on('request', this.#onRequest);
  }

  start(activeUserText: string): void {
    this.#activeUserText = activeUserText;
    this.#latest = null;
    this.#capturing = true;
  }

  async replayLatest(timeoutMs = 120_000): Promise<ProviderReplayResult> {
    this.#capturing = false;
    const candidate = this.#latest;
    this.#latest = null;
    if (candidate === null) throw new Error('No extension-owned Responses request was captured.');
    const capturedHeaders = await candidate.headers;
    const headers = sanitizeReplayHeaders(capturedHeaders);
    const response = await this.#context.request.fetch(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers,
      data: candidate.body,
      failOnStatusCode: false,
      timeout: timeoutMs,
    });
    const body = await response.body();
    return {
      request: candidate.requestSummary,
      response: summarizeReplaySseResponse(
        body,
        response.status(),
        response.headers()['content-type'] ?? null,
      ),
    };
  }

  readonly #onRequest = (request: Request): void => {
    if (
      !this.#capturing ||
      request.url() !== CODEX_RESPONSES_URL ||
      request.method() !== 'POST' ||
      !(request.serviceWorker()?.url() ?? '').startsWith(this.#extensionOrigin)
    ) {
      return;
    }
    const body = request.postDataBuffer();
    if (body === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      parsed = null;
    }
    this.#latest = {
      body: Buffer.from(body),
      headers: request.allHeaders(),
      requestSummary: summarizeResponsesRequestBody(parsed, this.#activeUserText),
    };
  };
}
