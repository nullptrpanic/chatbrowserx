import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateEvaluationCatalog } from '../../runner/evaluation-catalog';
import { loadEvaluationResults } from '../../runner/evaluation-result-loader';
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
  },
): Promise<void> {
  const timestamp = input.startedAt.replaceAll('-', '').replaceAll(':', '');
  const base = evaluationResult();
  const result = evaluationResult({
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
      : { taskError: null, harnessError: 'Synthetic failure.', failedChecks: [] },
    sourceReport: `e2e/.runtime/live-results/${input.runId}/report.json`,
  });
  await writeFile(
    join(root, 'e2e', 'samples', 'example-read', 'results', `${timestamp}__${input.runId}.json`),
    `${JSON.stringify({ ...result, schemaVersion: input.schemaVersion ?? 3 })}\n`,
    'utf8',
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
        resultCount: 0,
        passedResultCount: 0,
      }),
    ]);
  });

  it('indexes only the current result schema and groups results by product revision', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_old',
      startedAt: '2026-08-27T10:00:00.000Z',
      contractVersion: 1,
      productRevision: 'revision_old',
      success: true,
      schemaVersion: 99,
    });
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
      resultCount: 2,
      passedResultCount: 1,
      currentContractResultCount: 2,
      currentContractPassedResultCount: 1,
      currentContractRevisionBatches: [
        {
          productRevision: 'revision_current',
          resultCount: 2,
          passedResultCount: 1,
        },
      ],
    });
  });

  it('loads only strict current-schema results for comparisons', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeResult(root, {
      runId: 'live_archived',
      startedAt: '2026-08-27T10:00:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
      schemaVersion: 2,
    });
    await writeResult(root, {
      runId: 'live_current',
      startedAt: '2026-08-27T10:01:00.000Z',
      contractVersion: 2,
      productRevision: 'revision_current',
      success: true,
    });

    const results = await loadEvaluationResults(
      join(root, 'e2e', 'samples', 'example-read', 'results'),
      'example-read',
    );

    expect(results.map(({ runId }) => runId)).toEqual(['live_current']);
  });

  it('rejects a sample without its own results directory', async () => {
    const root = await createRoot();
    await createSample(root, 'example-read', validDefinition, false);

    await expect(validateEvaluationCatalog(root)).rejects.toThrow('results directory is missing');
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

  it('rejects a result filename without a sortable UTC timestamp', async () => {
    const root = await createRoot();
    await createSample(root);
    await writeFile(
      join(root, 'e2e', 'samples', 'example-read', 'results', 'live_abc.json'),
      '{}\n',
      'utf8',
    );

    await expect(validateEvaluationCatalog(root)).rejects.toThrow(
      'must use <UTC-timestamp>__<run-id>.json',
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
