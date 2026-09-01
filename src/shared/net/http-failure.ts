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

/** Cancels an untrusted error body without delaying status-based classification. */
export async function inspectHttpFailure(response: Response): Promise<HttpFailure> {
  const retryAfter = retryAfterMs(response.headers.get('Retry-After'));
  if (response.body !== null) {
    try {
      void response.body.cancel().catch(() => undefined);
    } catch {
      // HTTP status remains authoritative when cancellation itself is unavailable.
    }
  }
  return { status: response.status, retryAfterMs: retryAfter };
}
