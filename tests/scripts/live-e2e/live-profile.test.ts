import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireLiveProfileLock,
  resolveLiveProfilePath,
} from '../../../scripts/live-e2e/live-profile';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('live E2E profile path', () => {
  it('defaults to one dedicated ignored profile inside the repository', () => {
    expect(resolveLiveProfilePath({}, '/repo/chatbrowserx')).toBe(
      '/repo/chatbrowserx/.chatbrowserx-live-e2e/profile',
    );
  });

  it('accepts an absolute override outside the repository', () => {
    expect(
      resolveLiveProfilePath(
        { CHATBROWSERX_LIVE_E2E_PROFILE: '/tmp/chatbrowserx-profile' },
        '/repo/chatbrowserx',
      ),
    ).toBe('/tmp/chatbrowserx-profile');
  });

  it('rejects relative overrides but accepts a dedicated repository-contained override', () => {
    expect(() =>
      resolveLiveProfilePath({ CHATBROWSERX_LIVE_E2E_PROFILE: './profile' }, '/repo/chatbrowserx'),
    ).toThrow(/absolute/i);
    expect(
      resolveLiveProfilePath(
        { CHATBROWSERX_LIVE_E2E_PROFILE: '/repo/chatbrowserx/.profile' },
        '/repo/chatbrowserx',
      ),
    ).toBe('/repo/chatbrowserx/.profile');
  });
});

describe('live E2E profile lock', () => {
  it('allows only one owner until that owner releases the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-live-profile-test-'));
    temporaryRoots.push(root);
    const profile = join(root, 'profile');
    const first = await acquireLiveProfileLock(profile);

    await expect(acquireLiveProfileLock(profile)).rejects.toThrow(
      new RegExp(`already in use.*${String(process.pid)}`, 'i'),
    );

    await first.release();
    await first.release();
    const second = await acquireLiveProfileLock(profile);
    await second.release();
  });
});
