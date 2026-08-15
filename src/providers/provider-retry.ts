import { isProviderError, providerErrorFromCode } from './provider-errors';

const BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const MAX_RETRY_AFTER_MS = 30_000;

export interface ProviderRetryDependencies {
  readonly random?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

/** Waits for one retry delay and rejects immediately when the task is aborted. */
async function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw providerErrorFromCode('ABORTED');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(providerErrorFromCode('ABORTED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Applies bounded jitter or a capped server Retry-After to one retry index. */
function retryDelay(
  error: { readonly code: string; readonly retryAfterMs: number | null },
  retryIndex: number,
  random: () => number,
): number {
  if (error.code === 'RATE_LIMIT' && error.retryAfterMs !== null) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, error.retryAfterMs));
  }
  const base = BACKOFF_MS[retryIndex] ?? BACKOFF_MS.at(-1) ?? 4_000;
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(base * (0.8 + unit * 0.4));
}

/** Retries one incomplete Provider operation at most three times with abortable backoff. */
export async function retryProviderOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  dependencies: ProviderRetryDependencies = {},
): Promise<T> {
  const random = dependencies.random ?? Math.random;
  const sleep = dependencies.sleep ?? abortableSleep;

  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw providerErrorFromCode('ABORTED');
    try {
      return await operation();
    } catch (error) {
      if (signal.aborted) throw providerErrorFromCode('ABORTED');
      if (
        !isProviderError(error) ||
        (error.code !== 'TRANSIENT' && error.code !== 'RATE_LIMIT') ||
        attempt >= BACKOFF_MS.length
      ) {
        throw error;
      }
      await sleep(retryDelay(error, attempt, random), signal);
    }
  }
}
