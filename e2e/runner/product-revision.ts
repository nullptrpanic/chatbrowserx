import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const PRODUCT_PATHS = Object.freeze([
  'src',
  'public',
  'manifest.config.ts',
  'vite.config.ts',
  'tsconfig.json',
  'package-lock.json',
]);
const EXTERNAL_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,199}$/;

export interface LiveProductTarget {
  readonly extensionPath: string;
  readonly productRevision: string;
}

export interface LiveProductTargetInput {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly repositoryRoot: string;
  readonly workspaceRevision: string;
}

export interface UntrackedRevisionEntry {
  readonly path: string;
  readonly mode: number;
  readonly objectId: string;
}

/** Resolves the build under test while preventing an external build from being mislabeled. */
export function resolveLiveProductTarget(input: LiveProductTargetInput): LiveProductTarget {
  const externalPath = input.environment.CHATBROWSERX_LIVE_EXTENSION_PATH?.trim() ?? '';
  const externalRevision = input.environment.CHATBROWSERX_LIVE_PRODUCT_REVISION?.trim() ?? '';
  if ((externalPath.length === 0) !== (externalRevision.length === 0)) {
    throw new Error(
      'CHATBROWSERX_LIVE_EXTENSION_PATH and CHATBROWSERX_LIVE_PRODUCT_REVISION must be set together.',
    );
  }
  if (externalPath.length === 0) {
    return {
      extensionPath: resolve(input.repositoryRoot, 'dist'),
      productRevision: input.workspaceRevision,
    };
  }
  if (!EXTERNAL_REVISION_PATTERN.test(externalRevision)) {
    throw new Error('External live E2E revision label is invalid.');
  }
  return {
    extensionPath: resolve(input.repositoryRoot, externalPath),
    productRevision: externalRevision,
  };
}

/** Produces an opaque revision that distinguishes dirty workspaces without retaining their data. */
export function productRevisionForState(
  head: string,
  trackedDiff: string,
  untrackedEntries: readonly UntrackedRevisionEntry[],
): string {
  const revision = head.trim();
  if (revision.length === 0) throw new Error('Git returned an empty product revision.');
  if (trackedDiff.length === 0 && untrackedEntries.length === 0) return revision;

  const digest = createHash('sha256');
  digest.update(revision);
  digest.update('\0tracked\0');
  digest.update(trackedDiff);
  for (const entry of [...untrackedEntries].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    digest.update('\0untracked\0');
    digest.update(entry.path);
    digest.update('\0');
    digest.update(String(entry.mode));
    digest.update('\0');
    digest.update(entry.objectId);
  }
  return `${revision}-dirty-${digest.digest('hex').slice(0, 16)}`;
}

function gitMode(stats: Stats): number {
  if (stats.isSymbolicLink()) return 0o120000;
  return (stats.mode & 0o111) === 0 ? 0o100644 : 0o100755;
}

/** Resolves the commit plus an opaque dirty-workspace fingerprint before external mutation. */
export async function resolveProductRevision(repositoryRoot: string): Promise<string> {
  const options = {
    cwd: repositoryRoot,
    encoding: 'utf8' as const,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  };
  const [{ stdout: head }, { stdout: trackedDiff }, { stdout: untrackedPaths }] = await Promise.all(
    [
      execFileAsync('git', ['rev-parse', 'HEAD'], options),
      execFileAsync(
        'git',
        ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', ...PRODUCT_PATHS],
        options,
      ),
      execFileAsync(
        'git',
        ['ls-files', '--others', '--exclude-standard', '-z', '--', ...PRODUCT_PATHS],
        options,
      ),
    ],
  );
  const untrackedEntries = await Promise.all(
    untrackedPaths
      .split('\0')
      .filter((path) => path.length > 0)
      .map(async (path): Promise<UntrackedRevisionEntry> => {
        const [{ stdout: objectId }, stats] = await Promise.all([
          execFileAsync('git', ['hash-object', '--', path], options),
          lstat(resolve(repositoryRoot, path)),
        ]);
        const normalizedObjectId = objectId.trim();
        if (normalizedObjectId.length === 0) throw new Error('Git returned an empty object ID.');
        return { path, mode: gitMode(stats), objectId: normalizedObjectId };
      }),
  );
  return productRevisionForState(head, trackedDiff, untrackedEntries);
}
