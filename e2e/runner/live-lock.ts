import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LiveFileLock {
  readonly path: string;
  release(): Promise<void>;
}

export class LiveFileLockConflictError extends Error {
  readonly owner: string;

  constructor(path: string, owner: string, cause: unknown) {
    super(`Live E2E lock ${path} is already held by ${owner}.`, { cause });
    this.name = 'LiveFileLockConflictError';
    this.owner = owner;
  }
}

function ownerDescription(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return 'an unknown owner';
    const owner = parsed as {
      readonly pid?: unknown;
      readonly sampleId?: unknown;
      readonly startedAt?: unknown;
    };
    const pid = typeof owner.pid === 'number' ? `PID ${String(owner.pid)}` : 'an unknown PID';
    const sample = typeof owner.sampleId === 'string' ? ` for ${owner.sampleId}` : '';
    const startedAt = typeof owner.startedAt === 'string' ? ` since ${owner.startedAt}` : '';
    return `${pid}${sample}${startedAt}`;
  } catch {
    return 'an unknown owner';
  }
}

function ownerProcessId(value: string): number | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const pid = (parsed as { readonly pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    );
  }
}

async function reclaimDeadOwner(path: string): Promise<boolean> {
  const reclaimPath = `${path}.reclaim`;
  let reclaimHandle;
  try {
    reclaimHandle = await open(reclaimPath, 'wx');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  try {
    const currentOwner = await readFile(path, 'utf8').catch((error: unknown) => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null;
      }
      throw error;
    });
    if (currentOwner === null) return true;
    const pid = ownerProcessId(currentOwner);
    if (pid === null || processIsAlive(pid)) return false;
    await unlink(path);
    return true;
  } finally {
    await reclaimHandle.close();
    await unlink(reclaimPath).catch(() => undefined);
  }
}

async function createLiveFileLock(
  path: string,
  owner: Readonly<Record<string, unknown>>,
): Promise<LiveFileLock | null> {
  let handle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      return null;
    }
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({
        ...owner,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
      'utf8',
    );
  } finally {
    await handle.close();
  }

  let released = false;
  return {
    path,
    async release() {
      if (released) return;
      released = true;
      await unlink(path).catch((error: unknown) => {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        ) {
          throw error;
        }
      });
    },
  };
}

export async function tryAcquireLiveFileLock(
  path: string,
  owner: Readonly<Record<string, unknown>>,
): Promise<LiveFileLock | null> {
  await mkdir(dirname(path), { recursive: true });
  const created = await createLiveFileLock(path, owner);
  if (created !== null) return created;
  if (!(await reclaimDeadOwner(path))) return null;
  return createLiveFileLock(path, owner);
}

export async function acquireLiveFileLock(
  path: string,
  owner: Readonly<Record<string, unknown>>,
): Promise<LiveFileLock> {
  const lock = await tryAcquireLiveFileLock(path, owner);
  if (lock !== null) return lock;
  const currentOwner = await readFile(path, 'utf8').catch(() => '');
  throw new LiveFileLockConflictError(path, ownerDescription(currentOwner), undefined);
}
