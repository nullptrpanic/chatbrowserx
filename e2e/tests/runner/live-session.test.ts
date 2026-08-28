import { describe, expect, it, vi } from 'vitest';
import type { ExtensionSession } from '../../runner/extension-session';
import type { LiveProfileLock } from '../../runner/live-profile';
import { withExistingLiveSession, type LiveSessionDependencies } from '../../runner/live-session';

const input = {
  repositoryRoot: '/repo/chatbrowserx',
  environment: {},
  productTarget: {
    extensionPath: '/repo/chatbrowserx/dist',
    productRevision: 'revision',
  },
};

function dependencies(
  options: {
    readonly profileExists?: boolean;
    readonly createError?: Error;
  } = {},
): {
  readonly dependencies: LiveSessionDependencies;
  readonly events: string[];
} {
  const events: string[] = [];
  const lock = {
    path: '/repo/chatbrowserx/e2e/.runtime/profile.lock',
    async release() {
      events.push('release');
    },
  } satisfies LiveProfileLock;
  const session = {
    async close() {
      events.push('close');
    },
  } as ExtensionSession;
  return {
    events,
    dependencies: {
      async profileExists(path) {
        events.push(`profile:${path}`);
        return options.profileExists ?? true;
      },
      async acquireProfileLock(path) {
        events.push(`lock:${path}`);
        return lock;
      },
      async createSession(sessionOptions) {
        events.push(
          `session:${sessionOptions.profilePath}:${sessionOptions.extensionPath ?? ''}:${sessionOptions.channel}:${sessionOptions.viewport?.width ?? 0}x${sessionOptions.viewport?.height ?? 0}`,
        );
        if (options.createError !== undefined) throw options.createError;
        return session;
      },
    },
  };
}

describe('existing live E2E session', () => {
  it('owns profile validation, locking, session creation, and cleanup', async () => {
    const fixture = dependencies();

    const value = await withExistingLiveSession(
      input,
      async () => {
        fixture.events.push('operation');
        return 'done';
      },
      fixture.dependencies,
    );

    expect(value).toBe('done');
    expect(fixture.events).toEqual([
      'profile:/repo/chatbrowserx/e2e/.runtime/profile',
      'lock:/repo/chatbrowserx/e2e/.runtime/profile',
      'session:/repo/chatbrowserx/e2e/.runtime/profile:/repo/chatbrowserx/dist:chromium:1440x900',
      'operation',
      'close',
      'release',
    ]);
  });

  it('requires setup before taking the profile lock', async () => {
    const fixture = dependencies({ profileExists: false });

    await expect(withExistingLiveSession(input, vi.fn(), fixture.dependencies)).rejects.toThrow(
      'npm run e2e:live:setup',
    );
    expect(fixture.events).toEqual(['profile:/repo/chatbrowserx/e2e/.runtime/profile']);
  });

  it('releases the profile lock when session creation fails', async () => {
    const fixture = dependencies({ createError: new Error('launch failed') });

    await expect(withExistingLiveSession(input, vi.fn(), fixture.dependencies)).rejects.toThrow(
      'launch failed',
    );
    expect(fixture.events.at(-1)).toBe('release');
    expect(fixture.events).not.toContain('close');
  });

  it('closes the session and releases the lock when the operation fails', async () => {
    const fixture = dependencies();

    await expect(
      withExistingLiveSession(
        input,
        async () => {
          throw new Error('operation failed');
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow('operation failed');
    expect(fixture.events.slice(-2)).toEqual(['close', 'release']);
  });
});
