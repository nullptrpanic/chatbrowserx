import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationBatchReport,
  writeEvaluationBatchReport,
} from '../../runner/evaluation-batch-report';
import { validateEvaluationCatalog } from '../../runner/evaluation-catalog';
import { loadEvaluationResults } from '../../runner/evaluation-result-loader';
import type { EvaluationResult } from '../../runner/evaluation-result';
import { evaluationResult, evaluationSampleDefinition } from './fixtures';

const validDefinition = evaluationSampleDefinition({ contractVersion: 2 });

async function createRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-catalog-'));
}

async function createSample(
  root: string,
  directoryName = 'example-read',
  definition: unknown = validDefinition,
  createResults = true,
): Promise<void> {
  const directory = join(root, 'e2e', 'samples', directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'sample.json'), `${JSON.stringify(definition)}\n`, 'utf8');
  if (createResults) await mkdir(join(directory, 'results'));
}

async function writeResult(
  root: string,
  input: {
    readonly runId: string;
    readonly startedAt: string;
    readonly contractVersion: number;
    readonly productRevision: string;
    readonly success: boolean;
    readonly toolCalls?: number;
    readonly schemaVersion?: number;
    readonly collection?: 'results' | 'benchmark';
    readonly batchStartedAt?: string;
    readonly requestedRuns?: number;
    readonly attempt?: number;
  },
): Promise<void> {
  const batchStartedAt = input.batchStartedAt ?? input.startedAt;
  const batchId = batchStartedAt.replaceAll('-', '').replaceAll(':', '');
  const collection = input.collection ?? 'results';
  const attempt = input.attempt ?? 1;
  const base = evaluationResult();
  const result = evaluationResult({
    batch: {
      collection,
      id: batchId,
      startedAt: batchStartedAt,
      requestedRuns: input.requestedRuns ?? 1,
      attempt,
    },
    runId: input.runId,
    productRevision: input.productRevision,
    scenarioContractVersion: input.contractVersion,
    startedAt: input.startedAt,
    endedAt: input.startedAt,
    elapsedMs: 1,
    terminalStatus: input.success ? 'completed' : 'failed',
    success: input.success,
    input: { text: 'Read the page.' },
    output: { text: input.success ? 'complete' : '' },
    execution: {
      ...base.execution,
      toolCalls: input.toolCalls ?? 1,
      toolCounts: { browser_inspect: input.toolCalls ?? 1 },
    },
    acceptance: { passed: input.success, checks: [] },
    failure: input.success
      ? null
      : {
          taskError: null,
          harnessError: 'Synthetic failure.',
          failedChecks: [],
        },
  });
  const directory = join(root, 'e2e', 'samples', 'example-read', collection, batchId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${String(attempt).padStart(2, '0')}.json`),
    `${JSON.stringify({ ...result, schemaVersion: input.schemaVersion ?? 4 })}\n`,
    'utf8',
  );
  const attempts = await Promise.all(
    (await readdir(directory))
      .filter((entry) => /^\d{2}\.json$/.test(entry))
      .toSorted()
      .map(
        async (entry) =>
          JSON.parse(await readFile(join(directory, entry), 'utf8')) as EvaluationResult,
      ),
  );
  await writeEvaluationBatchReport(
    directory,
    createEvaluationBatchReport(
      attempts.map((entry) => ({
        ...entry,
        execution: {
          ...entry.execution,
          // Malformed-attempt tests still need a syntactically valid derived file so
          // the loader reaches the attempt contract before checking the summary.
          toolCalls: Math.max(0, entry.execution.toolCalls),
        },
      })),
    ),
  );
}

describe('evaluation catalog', () => {
  it('loads a self-contained sample and its reconstructed scenario', async () => {
    const root = await createRoot();
    await createSample(root);

    const catalog = await validateEvaluationCatalog(root);

    expect(catalog.samples).toEqual([
      expect.objectContaining({
        id: 'example-read',
        contractVersion: 2,
        requiredRuns: 5,
        scenario: expect.objectContaining({
          name: 'example-read',
          startUrl: 'https://example.com/document',
          taskText: 'Read the complete page without changing it.',
        }),
        results: {
          attempts: 0,
          passed: 0,
          currentContractAttempts: 0,
          currentContractPassed: 0,
          revisionBatches: [],
        },
        benchmark: {
          attempts: 0,
          passed: 0,
          currentContractAttempts: 0,
          currentContractPassed: 0,
          revisionBatches: [],
        },
      }),
    ]);
  });

  it('indexes only schema-v4 batch attempts and groups results by product revision', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_current_pass',
      startedAt: '2026-08-27T10:01:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
    });
    await writeResult(root, {
      runId: 'live_current_fail',
      startedAt: '2026-08-27T10:02:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: false,
    });

    const catalog = await validateEvaluationCatalog(root);

    expect(catalog.samples[0]).toMatchObject({
      results: {
        attempts: 2,
        passed: 1,
        currentContractAttempts: 2,
        currentContractPassed: 1,
        revisionBatches: [
          {
            productRevision: 'revision_current',
            attempts: 2,
            passed: 1,
          },
        ],
      },
    });
  });

  it('rejects a non-v4 report instead of treating it as a compatible archive', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_archived',
      startedAt: '2026-08-27T10:00:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
      schemaVersion: 3,
    });

    await expect(
      loadEvaluationResults(
        join(root, 'e2e', 'samples', 'example-read', 'results'),
        'example-read',
      ),
    ).rejects.toThrow('schemaVersion must equal 4');
  });

  it('treats a sample without a results directory as having no historical attempts', async () => {
    const root = await createRoot();
    await createSample(root, 'example-read', validDefinition, false);

    await expect(validateEvaluationCatalog(root)).resolves.toMatchObject({
      samples: [
        {
          results: {
            attempts: 0,
            passed: 0,
            currentContractAttempts: 0,
            currentContractPassed: 0,
            revisionBatches: [],
          },
        },
      ],
    });
  });

  it('rejects zero required attempts', async () => {
    const root = await createRoot();
    await createSample(root, 'example-read', {
      ...validDefinition,
      requiredRuns: 0,
    });

    await expect(validateEvaluationCatalog(root)).rejects.toThrow(
      'requiredRuns must be a positive safe integer',
    );
  });

  it('rejects an entry outside a sortable UTC batch directory', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeFile(
      join(root, 'e2e', 'samples', 'example-read', 'results', 'live_abc.json'),
      '{}\n',
      'utf8',
    );

    await expect(validateEvaluationCatalog(root)).rejects.toThrow(
      'must be a sortable UTC batch directory',
    );
  });

  it('loads benchmark attempts independently from ordinary results', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_result',
      startedAt: '2026-08-27T10:00:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_result',
      success: true,
    });
    await writeResult(root, {
      runId: 'live_benchmark_1',
      startedAt: '2026-08-27T10:01:00.000Z',
      batchStartedAt: '2026-08-27T10:00:30.000Z',
      contractVersion: 2,
      productRevision: 'revision_benchmark',
      success: true,
      collection: 'benchmark',
      requestedRuns: 2,
      attempt: 1,
    });
    await writeResult(root, {
      runId: 'live_benchmark_2',
      startedAt: '2026-08-27T10:02:00.000Z',
      batchStartedAt: '2026-08-27T10:00:30.000Z',
      contractVersion: 2,
      productRevision: 'revision_benchmark',
      success: true,
      collection: 'benchmark',
      requestedRuns: 2,
      attempt: 2,
    });

    const results = await loadEvaluationResults(
      join(root, 'e2e', 'samples', 'example-read', 'results'),
      'example-read',
    );
    const benchmark = await loadEvaluationResults(
      join(root, 'e2e', 'samples', 'example-read', 'benchmark'),
      'example-read',
    );

    expect(results.map(({ runId }) => runId)).toEqual(['live_result']);
    expect(benchmark.map(({ runId }) => runId)).toEqual(['live_benchmark_1', 'live_benchmark_2']);
    const catalog = await validateEvaluationCatalog(root);
    expect(catalog.samples[0]).toMatchObject({
      results: { attempts: 1 },
      benchmark: { attempts: 2, passed: 2 },
    });
  });

  it('loads attempt files alongside their aggregate-only batch report', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_summary',
      startedAt: '2026-08-27T10:00:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
    });
    await expect(
      loadEvaluationResults(
        join(root, 'e2e', 'samples', 'example-read', 'results'),
        'example-read',
      ),
    ).resolves.toHaveLength(1);
  });

  it('rejects a batch report that no longer matches its immutable attempts', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_summary_mismatch',
      startedAt: '2026-08-27T10:00:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
    });
    const reportPath = join(
      root,
      'e2e',
      'samples',
      'example-read',
      'results',
      '20260827T100000.000Z',
      'report.json',
    );
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>;
    await writeFile(reportPath, `${JSON.stringify({ ...report, averageToolCalls: 99 })}\n`, 'utf8');

    await expect(validateEvaluationCatalog(root)).rejects.toThrow(
      'report.json does not match its attempts',
    );
  });

  it('rejects a batch without its aggregate report', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_summary_missing',
      startedAt: '2026-08-27T10:00:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
    });
    await rm(
      join(
        root,
        'e2e',
        'samples',
        'example-read',
        'results',
        '20260827T100000.000Z',
        'report.json',
      ),
    );

    await expect(validateEvaluationCatalog(root)).rejects.toThrow('report.json is missing');
  });

  it('rejects a batch whose persisted attempt sequence starts after 01', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_gap',
      startedAt: '2026-08-27T10:01:00.000Z',
      batchStartedAt: '2026-08-27T10:00:30.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
      requestedRuns: 2,
      attempt: 2,
    });

    await expect(validateEvaluationCatalog(root)).rejects.toThrow(
      'attempt files must be contiguous from 01.json',
    );
  });

  it('rejects inconsistent metadata inside one batch directory', async () => {
    const root = await createRoot();
    await createSample(root);
    const common = {
      batchStartedAt: '2026-08-27T10:00:30.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
      requestedRuns: 2,
    } as const;
    await writeResult(root, {
      ...common,
      runId: 'live_consistent_1',
      startedAt: '2026-08-27T10:01:00.000Z',
      attempt: 1,
    });
    await writeResult(root, {
      ...common,
      runId: 'live_inconsistent_2',
      startedAt: '2026-08-27T10:02:00.000Z',
      productRevision: 'revision_other',
      attempt: 2,
    });

    await expect(validateEvaluationCatalog(root)).rejects.toThrow(
      'product revision must be consistent within its batch',
    );
  });

  it('rejects malformed execution facts before they can enter a comparison', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_invalid_metrics',
      startedAt: '2026-08-27T10:00:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: false,
      toolCalls: -1,
    });

    await expect(validateEvaluationCatalog(root)).rejects.toThrow(
      'execution.toolCalls must be a non-negative safe integer',
    );
  });
});
