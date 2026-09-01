import type { CredentialStore } from '../../persistence/credential-store';
import {
  isProviderError,
  providerErrorFromCode,
  throwWithInvalidResponseStage,
} from '../../agent/model/model-provider-error';
import { isAbortFailure } from '../../shared/net/http-failure';
import { throwProviderHttpError } from '../provider-http';
import type { ModelProviderPort, ModelRequest } from '../../agent/model/model-provider';
import { decodeSseStream } from '../sse-decoder';
import type { ModelStreamEvent } from '../../agent/model/model-stream-event';
import { extractChatGptAccountId } from './access-token';
import { CodexEventTranslator } from './codex-event-translator';
import { buildCodexRequest } from './codex-request';

export type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const CODEX_STREAM_IDLE_TIMEOUT_MS = 90_000;
export class CodexProvider implements ModelProviderPort {
  readonly #credentials: CredentialStore;
  readonly #fetch: FetchPort;

  /** Creates the fixed Codex adapter around trusted credentials and an injectable fetch boundary. */
  constructor(credentials: CredentialStore, fetchPort: FetchPort = globalThis.fetch) {
    this.#credentials = credentials;
    this.#fetch = (input, init) => fetchPort(input, init);
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
