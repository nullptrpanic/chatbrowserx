import type { EvaluationResult } from './evaluation-result';

const METRICS = Object.freeze({
  elapsedMs: (result: EvaluationResult) => result.elapsedMs,
  modelElapsedMs: (result: EvaluationResult) => result.execution.modelElapsedMs,
  inputTokens: (result: EvaluationResult) => result.tokenUsage.inputTokens,
  outputTokens: (result: EvaluationResult) => result.tokenUsage.outputTokens,
  totalTokens: (result: EvaluationResult) => result.tokenUsage.totalTokens,
  cachedInputTokens: (result: EvaluationResult) => result.tokenUsage.cachedInputTokens,
  reasoningOutputTokens: (result: EvaluationResult) => result.tokenUsage.reasoningOutputTokens,
  modelRounds: (result: EvaluationResult) => result.execution.modelRounds,
  providerRetries: (result: EvaluationResult) => result.execution.providerRetries,
  toolCalls: (result: EvaluationResult) => result.execution.toolCalls,
  providerRequests: (result: EvaluationResult) => result.execution.providerRequests,
  compactionRequests: (result: EvaluationResult) => result.execution.compactionRequests,
  traversalSegments: (result: EvaluationResult) => result.execution.traversalSegments,
  screenshotFallbacks: (result: EvaluationResult) => result.execution.screenshotFallbacks,
  staleRefs: (result: EvaluationResult) => result.execution.staleRefs,
  stateMismatches: (result: EvaluationResult) => result.execution.stateMismatches,
  repeatedFingerprints: (result: EvaluationResult) => result.execution.repeatedFingerprints,
  verifiedMutations: (result: EvaluationResult) => result.execution.verifiedMutations,
  ambiguousMutations: (result: EvaluationResult) => result.execution.ambiguousMutations,
  noProgressBlocks: (result: EvaluationResult) => result.execution.noProgressBlocks,
  auditOutputCharacters: (result: EvaluationResult) => result.execution.auditOutputCharacters,
  modelOutputCharacters: (result: EvaluationResult) => result.execution.modelOutputCharacters,
  modelOutputReductionCharacters: (result: EvaluationResult) =>
    result.execution.modelOutputReductionCharacters,
} satisfies Readonly<Record<string, (result: EvaluationResult) => number>>);

export interface EvaluationResultComparisonInput {
  readonly sampleId: string;
  readonly scenarioContractVersion: number;
  readonly runs: number;
  readonly leftRevision: string;
  readonly rightRevision: string;
  readonly results: readonly EvaluationResult[];
}

export interface EvaluationResultBatchSummary {
  readonly productRevision: string;
  readonly runIds: readonly string[];
  readonly requestedRuns: number;
  readonly passedRuns: number;
  readonly successRate: number;
  readonly evidenceIntegrity: 'valid' | 'invalid';
  readonly invalidEvidenceRunIds: readonly string[];
  readonly performanceMetricsComparable: boolean;
  readonly mean: Readonly<Record<string, number>> | null;
  readonly p95: Readonly<Record<string, number>> | null;
  readonly toolCountsMean: Readonly<Record<string, number>> | null;
  readonly toolCountsP95: Readonly<Record<string, number>> | null;
}

export interface EvaluationResultComparison {
  readonly schemaVersion: 2;
  readonly sampleId: string;
  readonly scenarioContractVersion: number;
  readonly requestedRuns: number;
  readonly selectionRule: 'earliest-started-at';
  readonly evidenceIntegrity: 'valid' | 'invalid';
  readonly successRateComparable: boolean;
  readonly performanceMetricsComparable: boolean;
  readonly left: EvaluationResultBatchSummary;
  readonly right: EvaluationResultBatchSummary;
  readonly delta: {
    readonly successRate: number | null;
    readonly mean: Readonly<Record<string, number>> | null;
    readonly p95: Readonly<Record<string, number>> | null;
    readonly toolCountsMean: Readonly<Record<string, number>> | null;
    readonly toolCountsP95: Readonly<Record<string, number>> | null;
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function mean(values: readonly number[]): number {
  return rounded(values.reduce((total, value) => total + value, 0) / values.length);
}

function metricSummaries(results: readonly EvaluationResult[]): {
  readonly mean: Readonly<Record<string, number>>;
  readonly p95: Readonly<Record<string, number>>;
} {
  const means: Record<string, number> = {};
  const p95: Record<string, number> = {};
  for (const [name, read] of Object.entries(METRICS)) {
    const values = results.map((result) => {
      let value: number;
      try {
        value = read(result);
      } catch {
        throw new Error(`Result ${result.runId} has no comparable ${name} metric.`);
      }
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Result ${result.runId} has no comparable ${name} metric.`);
      }
      return value;
    });
    means[name] = mean(values);
    p95[name] = percentile95(values);
  }
  return { mean: means, p95 };
}

function toolSummaries(results: readonly EvaluationResult[]): {
  readonly mean: Readonly<Record<string, number>>;
  readonly p95: Readonly<Record<string, number>>;
} {
  const counts = results.map((result) => {
    const value = (result as { readonly execution?: { readonly toolCounts?: unknown } }).execution
      ?.toolCounts;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Result ${result.runId} has no comparable toolCounts metric.`);
    }
    return value as Readonly<Record<string, number>>;
  });
  const names = [...new Set(counts.flatMap((value) => Object.keys(value)))].sort();
  const means: Record<string, number> = {};
  const p95: Record<string, number> = {};
  for (const name of names) {
    const values = counts.map((value) => value[name] ?? 0);
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error(`Comparable tool count ${name} is invalid.`);
    }
    means[name] = mean(values);
    p95[name] = percentile95(values);
  }
  return { mean: means, p95 };
}

function resultHasValidEvidence(result: EvaluationResult): boolean {
  const harnessError = result.failure?.harnessError ?? '';
  if (harnessError.includes('E2E_EVIDENCE_MISMATCH')) return false;
  if (result.execution.providerRequests > 0) {
    if (result.execution.modelElapsedMs === 0 || result.tokenUsage.totalTokens === 0) return false;
    if (result.execution.modelRounds !== result.execution.providerRequests) return false;
  }
  const countedTools = Object.values(result.execution.toolCounts).reduce(
    (total, count) => total + count,
    0,
  );
  return countedTools === result.execution.toolCalls;
}

function selectBatch(
  input: EvaluationResultComparisonInput,
  productRevision: string,
): EvaluationResultBatchSummary {
  const comparable = input.results
    .filter(
      (result) =>
        result.sampleId === input.sampleId &&
        result.scenarioContractVersion === input.scenarioContractVersion &&
        result.productRevision === productRevision,
    )
    .sort(
      (left, right) =>
        left.startedAt.localeCompare(right.startedAt) || left.runId.localeCompare(right.runId),
    );
  if (comparable.length < input.runs) {
    throw new Error(
      `${productRevision} has ${String(comparable.length)} comparable ${comparable.length === 1 ? 'result' : 'results'}; ${String(input.runs)} are required.`,
    );
  }
  const selected = comparable.slice(0, input.runs);
  const invalidEvidenceRunIds = selected
    .filter((result) => !resultHasValidEvidence(result))
    .map(({ runId }) => runId);
  const evidenceIntegrity = invalidEvidenceRunIds.length === 0 ? 'valid' : 'invalid';
  const performanceMetricsComparable =
    evidenceIntegrity === 'valid' &&
    selected.every((result) => result.execution.providerRequests > 0);
  const metrics = performanceMetricsComparable ? metricSummaries(selected) : null;
  const tools = performanceMetricsComparable ? toolSummaries(selected) : null;
  const passedRuns = selected.filter(({ success }) => success).length;
  return {
    productRevision,
    runIds: selected.map(({ runId }) => runId),
    requestedRuns: input.runs,
    passedRuns,
    successRate: rounded(passedRuns / input.runs),
    evidenceIntegrity,
    invalidEvidenceRunIds,
    performanceMetricsComparable,
    mean: metrics?.mean ?? null,
    p95: metrics?.p95 ?? null,
    toolCountsMean: tools?.mean ?? null,
    toolCountsP95: tools?.p95 ?? null,
  };
}

function numericDelta(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const delta: Record<string, number> = {};
  for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    delta[name] = rounded((right[name] ?? 0) - (left[name] ?? 0));
  }
  return delta;
}

/** Derives one deterministic A/B diff from immutable attempt facts without persisting a summary. */
export function compareEvaluationResultBatches(
  input: EvaluationResultComparisonInput,
): EvaluationResultComparison {
  if (!Number.isSafeInteger(input.runs) || input.runs < 1) {
    throw new Error('Comparison runs must be a positive safe integer.');
  }
  if (input.leftRevision === input.rightRevision) {
    throw new Error('Comparison revisions must be different.');
  }
  const left = selectBatch(input, input.leftRevision);
  const right = selectBatch(input, input.rightRevision);
  const evidenceIntegrity =
    left.evidenceIntegrity === 'valid' && right.evidenceIntegrity === 'valid' ? 'valid' : 'invalid';
  const successRateComparable = evidenceIntegrity === 'valid';
  const performanceMetricsComparable =
    left.performanceMetricsComparable && right.performanceMetricsComparable;
  return {
    schemaVersion: 2,
    sampleId: input.sampleId,
    scenarioContractVersion: input.scenarioContractVersion,
    requestedRuns: input.runs,
    selectionRule: 'earliest-started-at',
    evidenceIntegrity,
    successRateComparable,
    performanceMetricsComparable,
    left,
    right,
    delta: {
      successRate: successRateComparable ? rounded(right.successRate - left.successRate) : null,
      mean:
        performanceMetricsComparable && left.mean !== null && right.mean !== null
          ? numericDelta(left.mean, right.mean)
          : null,
      p95:
        performanceMetricsComparable && left.p95 !== null && right.p95 !== null
          ? numericDelta(left.p95, right.p95)
          : null,
      toolCountsMean:
        performanceMetricsComparable &&
        left.toolCountsMean !== null &&
        right.toolCountsMean !== null
          ? numericDelta(left.toolCountsMean, right.toolCountsMean)
          : null,
      toolCountsP95:
        performanceMetricsComparable && left.toolCountsP95 !== null && right.toolCountsP95 !== null
          ? numericDelta(left.toolCountsP95, right.toolCountsP95)
          : null,
    },
  };
}
