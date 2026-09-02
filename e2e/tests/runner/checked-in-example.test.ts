import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEvaluationCatalog } from '../../runner/evaluation-catalog';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

describe('checked-in E2E example', () => {
  it('rebuilds a valid catalog from only the portable example and its benchmark batch', async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-example-'));
    await cp(
      resolve(repositoryRoot, 'e2e/samples/example'),
      resolve(isolatedRoot, 'e2e/samples/example'),
      { recursive: true },
    );

    try {
      const catalog = await validateEvaluationCatalog(isolatedRoot);

      expect(catalog.samples).toEqual([
        expect.objectContaining({
          schemaVersion: 4,
          id: 'example',
          contractVersion: 1,
          requiredRuns: 1,
          target: {
            url: 'https://example.com/',
            expectedOrigin: 'https://example.com',
            readinessTimeoutMs: 30_000,
          },
          sideEffects: { mode: 'read_only' },
          benchmark: {
            attempts: 1,
            passed: 1,
            currentContractAttempts: 1,
            currentContractPassed: 1,
            revisionBatches: [
              {
                productRevision: 'example-only-not-a-measurement',
                attempts: 1,
                passed: 1,
              },
            ],
          },
        }),
      ]);
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});
