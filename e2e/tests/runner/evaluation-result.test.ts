import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEvaluationBatch,
  createEvaluationResult,
  evaluationResultFilename,
  parseEvaluationResult,
  writeEvaluationResult,
} from '../../runner/evaluation-result';
import type { LiveRunReport } from '../../runner/live-types';
import { liveRunReport, liveScenario } from './fixtures';

const scenario = liveScenario();
const batch = createEvaluationBatch('results', '2026-08-27T12:30:00.000Z', 5);

function report(overrides: Partial<LiveRunReport> = {}): LiveRunReport {
  const base = liveRunReport();
  return liveRunReport({
    executionMetrics: {
      ...base.executionMetrics,
      providerRetries: 1,
      providerRetryCounts: { 'transient_model_retry:upstream_failure': 1 },
    },
    ...overrides,
  });
}

describe('evaluation result', () => {
  it('records one self-contained batch attempt with comparison facts and diagnostic evidence', () => {
    const result = createEvaluationResult(scenario, batch, 2, report());

    expect(result).toEqual(
      expect.objectContaining({
        schemaVersion: 4,
        sampleId: 'example-read',
        batch: {
          collection: 'results',
          id: '20260827T123000.000Z',
          startedAt: '2026-08-27T12:30:00.000Z',
          requestedRuns: 5,
          attempt: 2,
        },
        runId: 'live_abc-123',
        productRevision: 'revision-dirty-fingerprint',
        scenarioContractVersion: 3,
        startedAt: '2026-08-27T12:33:46.514Z',
        endedAt: '2026-08-27T12:33:58.014Z',
        elapsedMs: 11_500,
        terminalStatus: 'completed',
        success: true,
        input: { text: 'Read marker live_abc-123 without changing anything.' },
        output: { text: 'Example read is complete.' },
        tokenUsage: {
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          reasoningOutputTokens: 10,
        },
        execution: expect.objectContaining({
          modelElapsedMs: 9_000,
          providerRequests: 2,
          firstEventMs: 0,
          firstTextMs: 0,
          providerRetries: 1,
          providerRetryCounts: { 'transient_model_retry:upstream_failure': 1 },
          toolCalls: 1,
          toolCounts: { browser_inspect: 1 },
          fullInteractiveObservations: 1,
          screenshotFallbackReasons: {},
          enabledToolsets: [],
          skillCatalogDisclosureCount: 0,
          exactReads: 0,
          toolDefinitionCharactersTotal: 11_000,
          toolDefinitionCharactersMax: 5_500,
          toolDefinitionSchemaChanges: 0,
          toolDefinitionSchemaVariants: 0,
        }),
        evidence: {
          taskId: 'task_1',
          conversationId: 'conversation_1',
          toolResults: [],
          providerTrace: { requestCount: 2, requests: [] },
        },
      }),
    );
    expect(result).not.toHaveProperty('sourceReport');
  });

  it('uses one sortable timestamp directory and simple ordered attempt filenames', () => {
    expect(batch.id).toBe('20260827T123000.000Z');
    expect(evaluationResultFilename(1)).toBe('01.json');
    expect(evaluationResultFilename(5)).toBe('05.json');
  });

  it('rejects fields outside the current result schema', () => {
    const result = {
      ...createEvaluationResult(scenario, batch, 2, report()),
      extraMetric: 1,
    };

    expect(() => parseEvaluationResult(result, scenario.name, batch.id, '02.json')).toThrow(
      'extraMetric is not supported',
    );
  });

  it('rejects a v4 failure that omits a required field', () => {
    const result = createEvaluationResult(
      scenario,
      batch,
      1,
      report({
        acceptance: { passed: false, checks: [] },
        taskError: 'Product task failed.',
      }),
    );
    const failure = { ...result.failure } as Record<string, unknown>;
    delete failure.taskError;

    expect(() =>
      parseEvaluationResult({ ...result, failure }, scenario.name, batch.id, '01.json'),
    ).toThrow('failure.taskError');
  });

  it('records product task failures separately from harness failures', () => {
    const result = createEvaluationResult(
      scenario,
      batch,
      1,
      report({
        terminalStatus: 'paused',
        finalText: '',
        acceptance: {
          passed: false,
          checks: [
            {
              name: 'terminal-status',
              passed: false,
              detail: 'Terminal status: paused.',
            },
          ],
        },
        taskError: 'The provider is temporarily unavailable.',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({
      taskError: 'The provider is temporarily unavailable.',
      harnessError: null,
      failedChecks: [{ name: 'terminal-status', detail: 'Terminal status: paused.' }],
    });
  });

  it('represents unavailable preflight execution identities as null', () => {
    const result = createEvaluationResult(
      scenario,
      batch,
      1,
      report({
        terminalStatus: 'preflight_failed',
        taskId: '',
        conversationId: '',
        finalText: '',
        acceptance: { passed: false, checks: [] },
        harnessError: 'Authentication is unavailable.',
      }),
    );

    expect(result.evidence).toMatchObject({
      taskId: null,
      conversationId: null,
    });
    expect(() => parseEvaluationResult(result, scenario.name, batch.id, '01.json')).not.toThrow();
  });

  it('writes one report directly below its batch directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-result-'));
    await writeEvaluationResult(root, scenario, batch, 1, report({ runId: 'live_first' }));

    const path = await writeEvaluationResult(root, scenario, batch, 2, report());

    expect(path).toBe(
      join(root, 'e2e', 'samples', 'example-read', 'results', '20260827T123000.000Z', '02.json'),
    );
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      success: boolean;
      runId: string;
      batch: { attempt: number };
    };
    expect(stored).toEqual(
      expect.objectContaining({
        success: true,
        runId: 'live_abc-123',
        batch: expect.objectContaining({ attempt: 2 }),
      }),
    );
  });

  it('updates one aggregate-only report after every persisted attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-summary-'));
    const first = report({ runId: 'live_first' });
    const secondBase = report();
    const second = report({
      runId: 'live_second',
      elapsedMs: 8_500,
      modelMetrics: {
        ...secondBase.modelMetrics,
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        elapsedMs: 6_000,
      },
      executionMetrics: {
        ...secondBase.executionMetrics,
        modelRounds: 3,
        toolCalls: 3,
        toolCounts: { browser_inspect: 3 },
      },
      providerTrace: { requestCount: 3, requests: [] },
      acceptance: { passed: false, checks: [] },
      harnessError: 'Synthetic harness failure.',
    });

    await writeEvaluationResult(root, scenario, batch, 1, first);
    await writeEvaluationResult(root, scenario, batch, 2, second);

    const summaryPath = join(
      root,
      'e2e',
      'samples',
      'example-read',
      'results',
      '20260827T123000.000Z',
      'report.json',
    );
    expect(JSON.parse(await readFile(summaryPath, 'utf8'))).toEqual({
      schemaVersion: 1,
      sampleId: 'example-read',
      collection: 'results',
      batchId: '20260827T123000.000Z',
      requestedRuns: 5,
      completedRuns: 2,
      successfulRuns: 1,
      failedRuns: 1,
      totalProviderRequests: 5,
      totalProviderRequestElapsedMs: 15_000,
      averageTotalTokens: 200,
      averageElapsedMs: 10_000,
      averageToolCalls: 2,
      averageProviderRequestElapsedMs: 3_000,
    });
  });

  it('rejects an attempt that would create a gap in its batch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-gap-'));

    await expect(writeEvaluationResult(root, scenario, batch, 2, report())).rejects.toThrow(
      'previous batch attempt 01.json is missing',
    );
  });

  it('uses the same report layout in the parallel benchmark collection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-benchmark-'));
    const benchmark = createEvaluationBatch('benchmark', '2026-08-27T12:31:00.000Z', 5);
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await writeEvaluationResult(
        root,
        scenario,
        benchmark,
        attempt,
        report({ runId: `live_${String(attempt)}` }),
      );
    }

    const path = await writeEvaluationResult(root, scenario, benchmark, 5, report());

    expect(path).toBe(
      join(root, 'e2e', 'samples', 'example-read', 'benchmark', '20260827T123100.000Z', '05.json'),
    );
  });
});
