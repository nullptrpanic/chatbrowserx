export type TavilyErrorCode = 'AUTH' | 'RATE_LIMIT' | 'TRANSIENT' | 'INVALID_RESPONSE' | 'ABORTED';

export interface TavilyErrorOptions {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
}

const messages: Readonly<Record<TavilyErrorCode, string>> = Object.freeze({
  AUTH: 'Tavily authentication failed.',
  RATE_LIMIT: 'The Tavily rate limit was reached.',
  TRANSIENT: 'Tavily is temporarily unavailable.',
  INVALID_RESPONSE: 'Tavily returned an invalid response.',
  ABORTED: 'The Tavily request was aborted.',
});

/** Carries only bounded Tavily failure metadata across the registered tool boundary. */
export class TavilyError extends Error {
  readonly code: TavilyErrorCode;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(code: TavilyErrorCode, options: TavilyErrorOptions = {}) {
    super(messages[code]);
    this.name = code === 'ABORTED' ? 'AbortError' : 'TavilyError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function tavilyErrorFromCode(
  code: TavilyErrorCode,
  options: TavilyErrorOptions = {},
): TavilyError {
  return new TavilyError(code, options);
}

export function isTavilyError(error: unknown): error is TavilyError {
  return error instanceof TavilyError;
}
