import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveProductRevision } from '../../runner/product-revision';

const execFileAsync = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-revision-'));
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'e2e@example.com'], {
    cwd: root,
  });
  await execFileAsync('git', ['config', 'user.name', 'E2E Test'], {
    cwd: root,
  });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
  await execFileAsync('git', ['add', 'src/app.ts'], { cwd: root });
  await execFileAsync('git', ['commit', '--quiet', '-m', 'initial'], {
    cwd: root,
  });
  return root;
}

describe('evaluation result revision isolation', () => {
  it('does not change the product revision when an untracked evaluation result is added', async () => {
    const root = await repository();
    const before = await resolveProductRevision(root);
    const results = join(root, 'e2e', 'samples', 'example-read', 'results');
    await mkdir(results, { recursive: true });
    await writeFile(
      join(results, '20260827T123346.514Z__live_abc.json'),
      '{"success":false}\n',
      'utf8',
    );

    const after = await resolveProductRevision(root);

    expect(after).toBe(before);
  });

  it('does not change the product revision for untracked evaluation code', async () => {
    const root = await repository();
    const before = await resolveProductRevision(root);
    await mkdir(join(root, 'e2e', 'runner'), { recursive: true });
    await writeFile(
      join(root, 'e2e', 'runner', 'new-evaluator.ts'),
      'export const evaluator = 1;\n',
    );

    const after = await resolveProductRevision(root);

    expect(after).toBe(before);
  });

  it('changes the product revision for untracked extension source', async () => {
    const root = await repository();
    const before = await resolveProductRevision(root);
    await writeFile(join(root, 'src', 'new-runtime.ts'), 'export const runtime = 1;\n');

    const after = await resolveProductRevision(root);

    expect(after).not.toBe(before);
  });
});
