const MAX_ERROR_BODY_BYTES = 8 * 1024;

export interface HttpFailure {
  readonly status: number;
  readonly retryAfterMs: number | null;
}

/** Detects abort-shaped platform failures without retaining upstream messages. */
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

/** Discards a bounded error body and returns only safe transport metadata. */
export async function inspectHttpFailure(response: Response): Promise<HttpFailure> {
  const retryAfter = retryAfterMs(response.headers.get('Retry-After'));
  if (response.body !== null) {
    const reader = response.body.getReader();
    let consumed = 0;
    try {
      while (consumed < MAX_ERROR_BODY_BYTES) {
        const next = await reader.read();
        if (next.done) break;
        consumed += next.value.byteLength;
      }
      if (consumed >= MAX_ERROR_BODY_BYTES) await reader.cancel().catch(() => undefined);
    } catch {
      // HTTP status remains authoritative when an unsafe body cannot be discarded.
    } finally {
      reader.releaseLock();
    }
  }
  return { status: response.status, retryAfterMs: retryAfter };
}
