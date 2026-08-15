import { providerErrorFromCode } from '../provider-errors';

const MAX_ERROR_BODY_BYTES = 8 * 1024;

/** Parses a standard Retry-After value without copying any other header into the error. */
function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Discards a bounded error-body prefix without decoding or returning its contents. */
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
    // The status remains authoritative when an unsafe body cannot be drained.
  } finally {
    reader.releaseLock();
  }
}

/** Converts one failed Tavily HTTP response to the shared sanitized Provider taxonomy. */
export async function throwTavilyHttpError(response: Response): Promise<never> {
  const delay = retryAfterMs(response.headers.get('Retry-After'));
  await discardErrorBody(response.body);
  if (response.status === 401) {
    throw providerErrorFromCode('AUTH', { status: response.status });
  }
  if ([429, 432, 433].includes(response.status)) {
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
