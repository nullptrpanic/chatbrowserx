import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEvaluationCatalog } from '../../runner/evaluation-catalog';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

describe('checked-in E2E example', () => {
  it('rebuilds a valid catalog from only the portable example and its benchmark batch', async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-example-'));
    try {
      const source = resolve(repositoryRoot, 'e2e/samples/example');
      const destination = resolve(isolatedRoot, 'e2e/samples/example');
      await mkdir(destination, { recursive: true });
      await cp(resolve(source, 'sample.json'), resolve(destination, 'sample.json'));
      // Import the declared portable fixture, not machine-local evaluation batches.
      await cp(
        resolve(source, 'benchmark/20260101T000000.000Z'),
        resolve(destination, 'benchmark/20260101T000000.000Z'),
        { recursive: true },
      );
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
