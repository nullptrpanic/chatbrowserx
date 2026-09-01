import { isAbsolute, resolve } from 'node:path';
import { acquireLiveFileLock, LiveFileLockConflictError, type LiveFileLock } from './live-lock';

export const LIVE_PROFILE_ENV = 'CHATBROWSERX_LIVE_E2E_PROFILE';

export type LiveProfileLock = LiveFileLock;

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

/** Acquires one cooperative process lock adjacent to the persistent Chrome profile. */
export async function acquireLiveProfileLock(profilePath: string): Promise<LiveProfileLock> {
  const lockPath = `${resolve(profilePath)}.lock`;
  try {
    return await acquireLiveFileLock(lockPath, { kind: 'profile' });
  } catch (error) {
    if (error instanceof LiveFileLockConflictError) {
      throw new Error(`Live E2E profile is already in use by ${error.owner}.`, {
        cause: error,
      });
    }
    throw error;
  }
}
