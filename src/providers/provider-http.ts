import { providerErrorFromCode } from './provider-errors';

const MAX_ERROR_BODY_BYTES = 8 * 1024;

/** Detects abort-shaped platform failures without retaining provider-controlled messages. */
export function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

async function discardErrorBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return;
  const reader = body.getReader();
  let consumed = 0;
  try {
    while (consumed < MAX_ERROR_BODY_BYTES) {
      const next = await reader.read();
      if (next.done) return;
      consumed += next.value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
  } catch {
    // The HTTP status remains authoritative when an unsafe error body cannot be discarded.
  } finally {
    reader.releaseLock();
  }
}

/** Maps an HTTP failure into the shared redacted provider taxonomy. */
export async function throwProviderHttpError(response: Response): Promise<never> {
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
