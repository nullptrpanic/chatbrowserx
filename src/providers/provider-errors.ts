export type ProviderErrorCode =
  'AUTH' | 'RATE_LIMIT' | 'TRANSIENT' | 'INVALID_RESPONSE' | 'ABORTED';

export type ProviderInvalidResponseStage =
  | 'request_contract'
  | 'response_transport'
  | 'sse_decode'
  | 'sse_protocol'
  | 'model_turn'
  | 'tool_call'
  | 'compaction_schema';

export interface ProviderErrorOptions {
  readonly status?: number | null;
  readonly retryAfterMs?: number | null;
  readonly invalidResponseStage?: ProviderInvalidResponseStage | null;
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
  readonly invalidResponseStage: ProviderInvalidResponseStage | null;

  /** Creates a provider-safe error whose public text cannot include upstream credentials. */
  constructor(code: ProviderErrorCode, options: ProviderErrorOptions = {}) {
    const metadata = ERROR_METADATA[code];
    super(metadata.message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = metadata.retryable;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.invalidResponseStage =
      code === 'INVALID_RESPONSE' ? (options.invalidResponseStage ?? null) : null;
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

/** Rethrows an invalid response with a bounded stage while preserving normalized metadata. */
export function throwWithInvalidResponseStage(
  error: unknown,
  stage: ProviderInvalidResponseStage,
): never {
  if (
    isProviderError(error) &&
    error.code === 'INVALID_RESPONSE' &&
    error.invalidResponseStage === null
  ) {
    throw providerErrorFromCode('INVALID_RESPONSE', {
      status: error.status,
      retryAfterMs: error.retryAfterMs,
      invalidResponseStage: stage,
    });
  }
  throw error;
}
