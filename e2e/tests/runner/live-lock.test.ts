import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLiveFileLock } from '../../runner/live-lock';

async function exitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  const pid = child.pid;
  if (pid === undefined) throw new Error('Failed to start the fixture process.');
  await once(child, 'exit');
  return pid;
}

describe('live E2E file lock', () => {
  it('reclaims a lock whose owner process exited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-live-lock-'));
    const path = join(root, 'resource.lock');
    try {
      await writeFile(path, JSON.stringify({ pid: await exitedProcessId() }), 'utf8');
      const lock = await acquireLiveFileLock(path, { sampleId: 'replacement' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        pid: process.pid,
        sampleId: 'replacement',
      });
      await lock.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not reclaim a lock owned by a live process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-live-lock-'));
    const path = join(root, 'resource.lock');
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid }), 'utf8');
      await expect(acquireLiveFileLock(path, { sampleId: 'blocked' })).rejects.toThrow(
        `PID ${String(process.pid)}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
