import { stat } from 'node:fs/promises';
import {
  createLoadedExtensionSession,
  type ExtensionSession,
  type LoadedExtensionSessionOptions,
} from './extension-session';
import {
  acquireLiveProfileLock,
  resolveLiveProfilePath,
  type LiveProfileLock,
} from './live-profile';
import type { LiveProductTarget } from './product-revision';
import { acquireLiveExecutionLease, type LiveExecutionLease } from './live-resources';

export interface ExistingLiveSessionInput {
  readonly repositoryRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly productTarget: LiveProductTarget;
  readonly execution?: {
    readonly sampleId: string;
    readonly exclusiveResources: readonly string[];
  };
}

export interface LiveSessionDependencies {
  profileExists(path: string): Promise<boolean>;
  acquireProfileLock(path: string): Promise<LiveProfileLock>;
  acquireExecutionLease(
    repositoryRoot: string,
    sampleId: string,
    exclusiveResources: readonly string[],
  ): Promise<LiveExecutionLease>;
  createSession(options: LoadedExtensionSessionOptions): Promise<ExtensionSession>;
}

const defaultDependencies: LiveSessionDependencies = {
  async profileExists(path) {
    return stat(path)
      .then((entry) => entry.isDirectory())
      .catch(() => false);
  },
  acquireProfileLock: acquireLiveProfileLock,
  acquireExecutionLease: acquireLiveExecutionLease,
  createSession: createLoadedExtensionSession,
};

const LIVE_E2E_VIEWPORT = Object.freeze({ width: 1_440, height: 900 });

/** Runs one operation with the configured existing profile and owns all session cleanup. */
export async function withExistingLiveSession<Result>(
  input: ExistingLiveSessionInput,
  operation: (session: ExtensionSession) => Promise<Result>,
  dependencies: LiveSessionDependencies = defaultDependencies,
): Promise<Result> {
  const profilePath = resolveLiveProfilePath(input.environment, input.repositoryRoot);
  if (!(await dependencies.profileExists(profilePath))) {
    throw new Error('Dedicated Live E2E Profile is missing. Run npm run e2e:live:setup first.');
  }

  const executionLease = input.execution
    ? await dependencies.acquireExecutionLease(
        input.repositoryRoot,
        input.execution.sampleId,
        input.execution.exclusiveResources,
      )
    : null;
  let lock: LiveProfileLock | null = null;
  let session: ExtensionSession | null = null;
  try {
    lock = await dependencies.acquireProfileLock(profilePath);
    session = await dependencies.createSession({
      profilePath,
      removeProfileOnClose: false,
      channel: input.environment.PLAYWRIGHT_CHANNEL ?? 'chromium',
      headless: false,
      extensionPath: input.productTarget.extensionPath,
      viewport: LIVE_E2E_VIEWPORT,
    });
    return await operation(session);
  } finally {
    await session?.close().catch(() => undefined);
    await lock?.release();
    await executionLease?.release();
  }
}
