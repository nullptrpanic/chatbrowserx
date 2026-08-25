import type { CredentialStore } from '../../persistence/credential-store';
import {
  isProviderError,
  providerErrorFromCode,
  throwWithInvalidResponseStage,
} from '../provider-errors';
import { isAbortFailure, throwProviderHttpError } from '../provider-http';
import type { ModelCompactionResult, ModelProvider, ModelRequest } from '../provider-types';
import { decodeSseStream } from '../sse-decoder';
import type { ModelStreamEvent } from '../stream-events';
import { extractChatGptAccountId } from './access-token';
import { CodexEventTranslator } from './codex-event-translator';
import { parseCodexCompactResponse } from './codex-compact-response';
import { buildCodexCompactRequest, buildCodexRequest } from './codex-request';

export type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const CODEX_STREAM_IDLE_TIMEOUT_MS = 90_000;
const MAX_CODEX_COMPACT_RESPONSE_BYTES = 12 * 1024 * 1024;

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_CODEX_COMPACT_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw providerErrorFromCode('INVALID_RESPONSE', {
      status: response.status,
      invalidResponseStage: 'compaction_schema',
    });
  }
  const body = response.body;
  if (body === null) {
    throw providerErrorFromCode('INVALID_RESPONSE', {
      status: response.status,
      invalidResponseStage: 'compaction_schema',
    });
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_CODEX_COMPACT_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw providerErrorFromCode('INVALID_RESPONSE', {
          status: response.status,
          invalidResponseStage: 'compaction_schema',
        });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE', {
      status: response.status,
      invalidResponseStage: 'compaction_schema',
    });
  }
}

export class CodexProvider implements ModelProvider {
  readonly #credentials: CredentialStore;
  readonly #fetch: FetchPort;

  /** Creates the fixed Codex adapter around trusted credentials and an injectable fetch boundary. */
  constructor(credentials: CredentialStore, fetchPort: FetchPort = globalThis.fetch) {
    this.#credentials = credentials;
    this.#fetch = (input, init) => fetchPort(input, init);
  }

  /** Compacts one active WorkSession through the fixed unary Codex endpoint. */
  async compact(request: ModelRequest, signal: AbortSignal): Promise<ModelCompactionResult> {
    if (signal.aborted) throw providerErrorFromCode('ABORTED');
    const { accessToken, accountId } = await this.#credentialsForRequest();
    const outbound = buildCodexCompactRequest({ accessToken, accountId, request });
    let response: Response;
    try {
      response = await this.#fetch(outbound.url, {
        method: 'POST',
        headers: outbound.headers,
        body: JSON.stringify(outbound.body),
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) throw providerErrorFromCode('ABORTED');
      throw providerErrorFromCode('TRANSIENT');
    }
    if (!response.ok) return await throwProviderHttpError(response);
    if (signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw providerErrorFromCode('ABORTED');
    }
    const contentType = response.headers.get('Content-Type')?.trim().toLowerCase() ?? '';
    if (contentType.length > 0 && !contentType.includes('application/json')) {
      await response.body?.cancel().catch(() => undefined);
      throw providerErrorFromCode('INVALID_RESPONSE', {
        status: response.status,
        invalidResponseStage: 'compaction_schema',
      });
    }
    try {
      return parseCodexCompactResponse(await readBoundedJson(response));
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) throw providerErrorFromCode('ABORTED');
      if (isProviderError(error)) throw error;
      throw providerErrorFromCode('TRANSIENT', { status: response.status });
    }
  }

  async #credentialsForRequest(): Promise<{ accessToken: string; accountId: string }> {
    let accessToken: string | undefined;
    try {
      accessToken = await this.#credentials.getCodexAccessToken();
    } catch {
      throw providerErrorFromCode('AUTH');
    }
    if (!accessToken) throw providerErrorFromCode('AUTH');
    return { accessToken, accountId: extractChatGptAccountId(accessToken) };
  }

  /** Streams one fixed-endpoint Codex response as normalized provider events. */
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelStreamEvent> {
    if (signal.aborted) {
      throw providerErrorFromCode('ABORTED');
    }

    const { accessToken, accountId } = await this.#credentialsForRequest();
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
      return await throwProviderHttpError(response);
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
      throw providerErrorFromCode('INVALID_RESPONSE', {
        status: response.status,
        invalidResponseStage: 'response_transport',
      });
    }

    const translator = new CodexEventTranslator();
    try {
      for await (const decoded of decodeSseStream(response.body, {
        idleTimeoutMs: CODEX_STREAM_IDLE_TIMEOUT_MS,
      })) {
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
        if (error.code === 'INVALID_RESPONSE') {
          throwWithInvalidResponseStage(error, 'sse_protocol');
        }
        throw error;
      }
      throw providerErrorFromCode('TRANSIENT');
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
  }
}
