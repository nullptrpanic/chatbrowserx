import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  acquireLiveFileLock,
  LiveFileLockConflictError,
  tryAcquireLiveFileLock,
  type LiveFileLock,
} from './live-lock';

const MAX_CONCURRENT_LIVE_RUNS = 5;

export interface LiveExecutionLease {
  release(): Promise<void>;
}

function resourceLockName(resource: string): string {
  return createHash('sha256').update(resource).digest('hex');
}

/** Caps live fan-out and serializes samples that declare the same remote resource. */
export async function acquireLiveExecutionLease(
  repositoryRoot: string,
  sampleId: string,
  exclusiveResources: readonly string[],
): Promise<LiveExecutionLease> {
  const lockRoot = join(repositoryRoot, 'e2e', '.runtime', 'live-locks');
  let workerSlot: LiveFileLock | null = null;
  for (let slot = 1; slot <= MAX_CONCURRENT_LIVE_RUNS; slot += 1) {
    workerSlot = await tryAcquireLiveFileLock(join(lockRoot, `worker-${String(slot)}.lock`), {
      kind: 'worker',
      sampleId,
    });
    if (workerSlot !== null) break;
  }
  if (workerSlot === null) {
    throw new Error(`Live E2E concurrency limit of ${String(MAX_CONCURRENT_LIVE_RUNS)} reached.`);
  }

  const resourceLocks: LiveFileLock[] = [];
  const resources = [...new Set([`sample:${sampleId}`, ...exclusiveResources])].toSorted();
  try {
    for (const resource of resources) {
      try {
        resourceLocks.push(
          await acquireLiveFileLock(
            join(lockRoot, 'resources', `${resourceLockName(resource)}.lock`),
            { kind: 'resource', resource, sampleId },
          ),
        );
      } catch (error) {
        if (error instanceof LiveFileLockConflictError) {
          throw new Error(
            `Live E2E exclusive resource "${resource}" is already in use by ${error.owner}.`,
            { cause: error },
          );
        }
        throw error;
      }
    }
  } catch (error) {
    await Promise.all(resourceLocks.map(async (lock) => lock.release()));
    await workerSlot.release();
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      for (const lock of resourceLocks.toReversed()) await lock.release();
      await workerSlot.release();
    },
  };
}
