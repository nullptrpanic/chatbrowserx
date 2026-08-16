import type { CredentialStore } from '../../persistence/credential-store';
import { isProviderError, providerErrorFromCode } from '../provider-errors';
import type { ModelProvider, ModelRequest } from '../provider-types';
import { decodeSseStream } from '../sse-decoder';
import type { ModelStreamEvent } from '../stream-events';
import { extractChatGptAccountId } from './access-token';
import { CodexEventTranslator } from './codex-event-translator';
import { buildCodexRequest } from './codex-request';

const MAX_ERROR_BODY_BYTES = 8 * 1024;

export type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Detects abort-shaped platform failures without retaining their unsafe messages. */
function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/** Parses a standard Retry-After header into a nonnegative millisecond delay. */
function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Reads and discards at most the bounded prefix of an error response body. */
async function discardErrorBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) {
    return;
  }
  const reader = body.getReader();
  let consumed = 0;
  try {
    while (consumed < MAX_ERROR_BODY_BYTES) {
      const next = await reader.read();
      if (next.done) {
        return;
      }
      consumed += next.value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
  } catch {
    // HTTP status remains authoritative when discarding an unsafe error body fails.
  } finally {
    reader.releaseLock();
  }
}

/** Maps an HTTP failure without copying its body or headers into public errors. */
async function httpError(response: Response): Promise<never> {
  const delay = retryAfterMs(response.headers.get('Retry-After'));
  await discardErrorBody(response.body);
  if (response.status === 401 || response.status === 403) {
    throw providerErrorFromCode('AUTH', { status: response.status });
  }
  if (response.status === 429) {
    throw providerErrorFromCode('RATE_LIMIT', {
      status: response.status,
      retryAfterMs: delay,
    });
  }
  if (response.status >= 500) {
    throw providerErrorFromCode('TRANSIENT', {
      status: response.status,
      retryAfterMs: delay,
    });
  }
  throw providerErrorFromCode('INVALID_RESPONSE', { status: response.status });
}

export class CodexProvider implements ModelProvider {
  readonly #credentials: CredentialStore;
  readonly #fetch: FetchPort;

  /** Creates the fixed Codex adapter around trusted credentials and an injectable fetch boundary. */
  constructor(credentials: CredentialStore, fetchPort: FetchPort = globalThis.fetch) {
    this.#credentials = credentials;
    this.#fetch = (input, init) => fetchPort(input, init);
  }

  /** Streams one fixed-endpoint Codex response as normalized provider events. */
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
    if (signal.aborted) {
      throw providerErrorFromCode('ABORTED');
    }

    let accessToken: string | undefined;
    try {
      accessToken = await this.#credentials.getCodexAccessToken();
    } catch {
      throw providerErrorFromCode('AUTH');
    }
    if (!accessToken) {
      throw providerErrorFromCode('AUTH');
    }
    const accountId = extractChatGptAccountId(accessToken);
    const outbound = buildCodexRequest({ accessToken, accountId, request });

    let response: Response;
    try {
      response = await this.#fetch(outbound.url, {
        method: 'POST',
        headers: outbound.headers,
        body: JSON.stringify(outbound.body),
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) {
        throw providerErrorFromCode('ABORTED');
      }
      throw providerErrorFromCode('TRANSIENT');
    }

    if (!response.ok) {
      return await httpError(response);
    }
    if (signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw providerErrorFromCode('ABORTED');
    }
    const contentType = response.headers.get('Content-Type')?.trim().toLowerCase() ?? '';
    if (
      response.body === null ||
      (contentType.length > 0 && !contentType.includes('text/event-stream'))
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw providerErrorFromCode('INVALID_RESPONSE', { status: response.status });
    }

    const translator = new CodexEventTranslator();
    try {
      for await (const decoded of decodeSseStream(response.body)) {
        if (signal.aborted) {
          throw providerErrorFromCode('ABORTED');
        }
        for (const event of translator.translate(decoded)) {
          yield event;
        }
      }
      translator.finish();
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) {
        throw providerErrorFromCode('ABORTED');
      }
      if (isProviderError(error)) {
        throw error;
      }
      throw providerErrorFromCode('TRANSIENT');
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
  }
}
