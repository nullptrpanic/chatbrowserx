import { providerErrorFromCode } from '../agent/model/model-provider-error';
import { inspectHttpFailure } from '../shared/net/http-failure';

/** Maps an HTTP failure into the shared redacted provider taxonomy. */
export async function throwProviderHttpError(response: Response): Promise<never> {
  const failure = await inspectHttpFailure(response);
  if (failure.status === 401 || failure.status === 403) {
    throw providerErrorFromCode('AUTH', { status: failure.status });
  }
  if (failure.status === 429) {
    throw providerErrorFromCode('RATE_LIMIT', {
      status: failure.status,
      retryAfterMs: failure.retryAfterMs,
    });
  }
  if (failure.status >= 500) {
    throw providerErrorFromCode('TRANSIENT', {
      status: failure.status,
      retryAfterMs: failure.retryAfterMs,
    });
  }
  throw providerErrorFromCode('INVALID_RESPONSE', { status: failure.status });
}
