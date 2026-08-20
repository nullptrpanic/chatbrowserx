import type { CredentialStore } from '../../persistence/credential-store';
import { isProviderError, providerErrorFromCode } from '../provider-errors';
import { isAbortFailure, throwProviderHttpError } from '../provider-http';
import type { ModelProvider, ModelRequest } from '../provider-types';
import { decodeSseStream } from '../sse-decoder';
import type { ModelStreamEvent } from '../stream-events';
import { extractChatGptAccountId } from './access-token';
import { CodexEventTranslator } from './codex-event-translator';
import { buildCodexRequest } from './codex-request';

export type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
