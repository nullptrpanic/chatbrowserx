export type ProviderErrorCode =
  'AUTH' | 'RATE_LIMIT' | 'TRANSIENT' | 'INVALID_RESPONSE' | 'ABORTED';

export interface ProviderErrorOptions {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
}

const ERROR_METADATA: Readonly<
  Record<ProviderErrorCode, { readonly message: string; readonly retryable: boolean }>
> = Object.freeze({
  AUTH: { message: 'Provider authentication failed.', retryable: false },
  RATE_LIMIT: { message: 'The model provider rate limit was reached.', retryable: true },
  TRANSIENT: { message: 'The model provider is temporarily unavailable.', retryable: true },
  INVALID_RESPONSE: {
    message: 'The model provider returned an invalid response.',
    retryable: false,
  },
  ABORTED: { message: 'The model request was aborted.', retryable: false },
});

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  /** Creates a provider-safe error whose public text cannot include upstream credentials. */
  constructor(code: ProviderErrorCode, options: ProviderErrorOptions = {}) {
    const metadata = ERROR_METADATA[code];
    super(metadata.message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = metadata.retryable;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Creates a normalized provider error without accepting unsafe upstream message text. */
export function providerErrorFromCode(
  code: ProviderErrorCode,
  options: ProviderErrorOptions = {},
): ProviderError {
  return new ProviderError(code, options);
}

/** Narrows unknown failures to the normalized provider error class. */
export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}
