import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLiveExecutionLease } from '../../runner/live-resources';

async function temporaryRepository(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'chatbrowserx-live-resources-'));
}

describe('live E2E execution resources', () => {
  it('serializes different samples that declare the same exclusive resource', async () => {
    const root = await temporaryRepository();
    const first = await acquireLiveExecutionLease(root, 'first-sample', ['lark:chat:self']);
    try {
      await expect(
        acquireLiveExecutionLease(root, 'second-sample', ['lark:chat:self']),
      ).rejects.toThrow('lark:chat:self');
    } finally {
      await first.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('releases partial acquisitions when a later resource is busy', async () => {
    const root = await temporaryRepository();
    const owner = await acquireLiveExecutionLease(root, 'owner-sample', ['resource:b']);
    try {
      await expect(
        acquireLiveExecutionLease(root, 'blocked-sample', ['resource:a', 'resource:b']),
      ).rejects.toThrow('resource:b');
      const next = await acquireLiveExecutionLease(root, 'next-sample', ['resource:a']);
      await next.release();
    } finally {
      await owner.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('caps concurrently held live execution leases at five', async () => {
    const root = await temporaryRepository();
    const leases = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        acquireLiveExecutionLease(root, `sample-${String(index + 1)}`, []),
      ),
    );
    try {
      await expect(acquireLiveExecutionLease(root, 'sample-6', [])).rejects.toThrow(
        'concurrency limit of 5',
      );
    } finally {
      await Promise.all(leases.map(async (lease) => lease.release()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
