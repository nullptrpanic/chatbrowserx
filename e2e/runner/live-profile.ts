import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export const LIVE_PROFILE_ENV = 'CHATBROWSERX_LIVE_E2E_PROFILE';

export interface LiveProfileLock {
  readonly path: string;
  release(): Promise<void>;
}

/** Resolves one dedicated live profile without ever falling back to the daily Chrome profile. */
export function resolveLiveProfilePath(
  environment: Readonly<Record<string, string | undefined>>,
  repositoryRoot: string,
): string {
  const override = environment[LIVE_PROFILE_ENV]?.trim();
  if (override !== undefined && override.length > 0 && !isAbsolute(override)) {
    throw new Error(`${LIVE_PROFILE_ENV} must be an absolute path.`);
  }
  const profilePath = resolve(
    override === undefined || override.length === 0
      ? resolve(repositoryRoot, 'e2e/.runtime/profile')
      : override,
  );
  if (profilePath === resolve(repositoryRoot)) {
    throw new Error('The repository root itself cannot be used as a Chrome profile.');
  }
  return profilePath;
}

function ownerDescription(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return 'an unknown owner';
    const owner = parsed as {
      readonly pid?: unknown;
      readonly startedAt?: unknown;
    };
    const pid = typeof owner.pid === 'number' ? `PID ${String(owner.pid)}` : 'an unknown PID';
    const startedAt = typeof owner.startedAt === 'string' ? ` since ${owner.startedAt}` : '';
    return `${pid}${startedAt}`;
  } catch {
    return 'an unknown owner';
  }
}

/** Acquires one cooperative process lock adjacent to the persistent Chrome profile. */
export async function acquireLiveProfileLock(profilePath: string): Promise<LiveProfileLock> {
  const lockPath = `${resolve(profilePath)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      const owner = await readFile(lockPath, 'utf8').catch(() => '');
      throw new Error(`Live E2E profile is already in use by ${ownerDescription(owner)}.`, {
        cause: error,
      });
    }
    throw error;
  }
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    'utf8',
  );
  await handle.close();

  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      await unlink(lockPath).catch((error: unknown) => {
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
