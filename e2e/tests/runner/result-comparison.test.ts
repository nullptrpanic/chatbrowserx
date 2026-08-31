import { describe, expect, it } from 'vitest';
import type { EvaluationResult } from '../../runner/evaluation-result';
import { compareEvaluationResultBatches } from '../../runner/result-comparison';
import { evaluationResult } from './fixtures';

function result(
  runId: string,
  revision: string,
  startedAt: string,
  success: boolean,
  elapsedMs: number,
  inputTokens: number,
  toolCounts: Readonly<Record<string, number>>,
): EvaluationResult {
  const base = evaluationResult();
  const toolCalls = Object.values(toolCounts).reduce((total, count) => total + count, 0);
  return evaluationResult({
    runId,
    productRevision: revision,
    startedAt,
    endedAt: startedAt,
    elapsedMs,
    terminalStatus: success ? 'completed' : 'failed',
    success,
    output: { text: success ? 'Complete.' : '' },
    tokenUsage: {
      ...base.tokenUsage,
      inputTokens,
      outputTokens: 10,
      totalTokens: inputTokens + 10,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    },
    execution: {
      ...base.execution,
      modelElapsedMs: elapsedMs - 10,
      modelRounds: 1,
      toolCalls,
      toolCounts,
      providerRequests: 1,
    },
    acceptance: { passed: success, checks: [] },
    failure: success
      ? null
      : {
          taskError: 'Product task failed.',
          harnessError: null,
          failedChecks: [],
        },
  });
}

describe('evaluation result comparison', () => {
  it('compares the earliest declared attempts with deterministic metric and tool deltas', () => {
    const comparison = compareEvaluationResultBatches({
      sampleId: 'example-read',
      scenarioContractVersion: 3,
      runs: 2,
      leftRevision: 'baseline',
      rightRevision: 'candidate',
      results: [
        result('candidate_2', 'candidate', '2026-08-27T10:03:00.000Z', true, 80, 80, {
          browser_inspect: 1,
        }),
        result('baseline_2', 'baseline', '2026-08-27T10:01:00.000Z', false, 200, 200, {
          browser_inspect: 3,
        }),
        result('candidate_1', 'candidate', '2026-08-27T10:02:00.000Z', true, 120, 120, {
          browser_inspect: 1,
        }),
        result('baseline_1', 'baseline', '2026-08-27T10:00:00.000Z', true, 100, 100, {
          browser_inspect: 1,
        }),
        result('baseline_later', 'baseline', '2026-08-27T10:04:00.000Z', true, 1, 1, {
          browser_inspect: 1,
        }),
      ],
    });

    expect(comparison.selectionRule).toBe('earliest-started-at');
    expect(comparison).toMatchObject({
      schemaVersion: 3,
      evidenceIntegrity: 'valid',
      successRateComparable: true,
      performanceMetricsComparable: true,
    });
    expect(comparison.left).toMatchObject({
      productRevision: 'baseline',
      runIds: ['baseline_1', 'baseline_2'],
      passedRuns: 1,
      successRate: 0.5,
      mean: {
        elapsedMs: 150,
        inputTokens: 150,
        cacheReadRatio: 0,
        cacheWriteRatio: 0,
        toolCalls: 2,
        toolDefinitionCharactersTotal: 11_000,
      },
      toolCountsMean: { browser_inspect: 2 },
      auditOutputCharactersByToolMean: { browser_inspect: 2_000 },
      modelOutputCharactersByToolMean: { browser_inspect: 1_000 },
    });
    expect(comparison.right).toMatchObject({
      runIds: ['candidate_1', 'candidate_2'],
      passedRuns: 2,
      successRate: 1,
      mean: { elapsedMs: 100, inputTokens: 100, toolCalls: 1 },
      toolCountsMean: { browser_inspect: 1 },
      auditOutputCharactersByToolMean: { browser_inspect: 2_000 },
      modelOutputCharactersByToolMean: { browser_inspect: 1_000 },
    });
    expect(comparison.delta).toMatchObject({
      successRate: 0.5,
      mean: { elapsedMs: -50, inputTokens: -50, toolCalls: -1 },
      toolCountsMean: { browser_inspect: -1 },
      auditOutputCharactersByToolMean: { browser_inspect: 0 },
      modelOutputCharactersByToolMean: { browser_inspect: 0 },
    });
  });

  it('refuses a comparison when either revision lacks the predeclared attempt count', () => {
    expect(() =>
      compareEvaluationResultBatches({
        sampleId: 'example-read',
        scenarioContractVersion: 3,
        runs: 2,
        leftRevision: 'baseline',
        rightRevision: 'candidate',
        results: [
          result('baseline_1', 'baseline', '2026-08-27T10:00:00.000Z', true, 100, 100, {}),
          result('candidate_1', 'candidate', '2026-08-27T10:01:00.000Z', true, 100, 100, {}),
          result('candidate_2', 'candidate', '2026-08-27T10:02:00.000Z', true, 100, 100, {}),
        ],
      }),
    ).toThrow('baseline has 1 comparable result; 2 are required');
  });

  it('retains success-rate facts but suppresses deltas for evidence-corrupt attempts', () => {
    const baseline = result('baseline_1', 'baseline', '2026-08-27T10:00:00.000Z', true, 100, 100, {
      browser_inspect: 1,
    });
    const candidateBase = result(
      'candidate_1',
      'candidate',
      '2026-08-27T10:01:00.000Z',
      false,
      100,
      0,
      {},
    );
    const candidate: EvaluationResult = {
      ...candidateBase,
      execution: {
        ...candidateBase.execution,
        modelElapsedMs: 0,
        providerRequests: 8,
        modelRounds: 8,
      },
      failure: {
        taskError: null,
        harnessError: 'E2E_EVIDENCE_MISMATCH: Provider and TaskSnapshot disagree.',
        failedChecks: [],
      },
    };

    const comparison = compareEvaluationResultBatches({
      sampleId: 'example-read',
      scenarioContractVersion: 3,
      runs: 1,
      leftRevision: 'baseline',
      rightRevision: 'candidate',
      results: [baseline, candidate],
    });

    expect(comparison).toMatchObject({
      evidenceIntegrity: 'invalid',
      successRateComparable: false,
      performanceMetricsComparable: false,
      left: { successRate: 1, evidenceIntegrity: 'valid' },
      right: {
        successRate: 0,
        evidenceIntegrity: 'invalid',
        invalidEvidenceRunIds: ['candidate_1'],
        mean: null,
        p95: null,
      },
      delta: {
        successRate: null,
        mean: null,
        p95: null,
        toolCountsMean: null,
        toolCountsP95: null,
      },
    });
  });

  it('does not treat a preflight harness failure as a comparable product failure', () => {
    const baseline = result('baseline_1', 'baseline', '2026-08-27T10:00:00.000Z', true, 100, 100, {
      browser_inspect: 1,
    });
    const preflightBase = result(
      'candidate_1',
      'candidate',
      '2026-08-27T10:01:00.000Z',
      false,
      100,
      0,
      {},
    );
    const preflight: EvaluationResult = {
      ...preflightBase,
      terminalStatus: 'preflight_failed',
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      execution: {
        ...preflightBase.execution,
        modelElapsedMs: 0,
        modelRounds: 0,
        providerRequests: 0,
      },
      failure: {
        taskError: null,
        harnessError: 'Live E2E profile is already in use by a stale owner.',
        failedChecks: [],
      },
    };

    const comparison = compareEvaluationResultBatches({
      sampleId: 'example-read',
      scenarioContractVersion: 3,
      runs: 1,
      leftRevision: 'baseline',
      rightRevision: 'candidate',
      results: [baseline, preflight],
    });

    expect(comparison).toMatchObject({
      evidenceIntegrity: 'invalid',
      successRateComparable: false,
      performanceMetricsComparable: false,
      right: {
        invalidEvidenceRunIds: ['candidate_1'],
        mean: null,
      },
      delta: {
        successRate: null,
        mean: null,
      },
    });
  });

  it('detects impossible zero metrics even without an explicit mismatch code', () => {
    const baseline = result('baseline_1', 'baseline', '2026-08-27T10:00:00.000Z', true, 100, 100, {
      browser_inspect: 1,
    });
    const brokenBase = result('broken_1', 'broken', '2026-08-27T10:01:00.000Z', false, 100, 0, {});
    const broken: EvaluationResult = {
      ...brokenBase,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 0,
      },
      execution: {
        ...brokenBase.execution,
        modelElapsedMs: 0,
        modelRounds: 8,
        providerRequests: 8,
      },
      failure: { taskError: null, harnessError: null, failedChecks: [] },
    };

    const comparison = compareEvaluationResultBatches({
      sampleId: 'example-read',
      scenarioContractVersion: 3,
      runs: 1,
      leftRevision: 'baseline',
      rightRevision: 'broken',
      results: [baseline, broken],
    });

    expect(comparison.evidenceIntegrity).toBe('invalid');
    expect(comparison.performanceMetricsComparable).toBe(false);
    expect(comparison.delta.mean).toBeNull();
  });
});
