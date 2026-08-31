import type { EvaluationResult } from './evaluation-result';

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

const METRICS = Object.freeze({
  elapsedMs: (result: EvaluationResult) => result.elapsedMs,
  modelElapsedMs: (result: EvaluationResult) => result.execution.modelElapsedMs,
  inputTokens: (result: EvaluationResult) => result.tokenUsage.inputTokens,
  outputTokens: (result: EvaluationResult) => result.tokenUsage.outputTokens,
  totalTokens: (result: EvaluationResult) => result.tokenUsage.totalTokens,
  cachedInputTokens: (result: EvaluationResult) => result.tokenUsage.cachedInputTokens,
  cacheWriteInputTokens: (result: EvaluationResult) => result.tokenUsage.cacheWriteInputTokens,
  cacheReadRatio: (result: EvaluationResult) =>
    ratio(result.tokenUsage.cachedInputTokens, result.tokenUsage.inputTokens),
  cacheWriteRatio: (result: EvaluationResult) =>
    ratio(result.tokenUsage.cacheWriteInputTokens, result.tokenUsage.inputTokens),
  reasoningOutputTokens: (result: EvaluationResult) => result.tokenUsage.reasoningOutputTokens,
  firstEventMs: (result: EvaluationResult) => result.execution.firstEventMs,
  firstTextMs: (result: EvaluationResult) => result.execution.firstTextMs,
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
  toolDefinitionCharactersTotal: (result: EvaluationResult) =>
    result.execution.toolDefinitionCharactersTotal,
  toolDefinitionCharactersMax: (result: EvaluationResult) =>
    result.execution.toolDefinitionCharactersMax,
  toolDefinitionSchemaChanges: (result: EvaluationResult) =>
    result.execution.toolDefinitionSchemaChanges,
  toolDefinitionSchemaVariants: (result: EvaluationResult) =>
    result.execution.toolDefinitionSchemaVariants,
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
  readonly auditOutputCharactersByToolMean: Readonly<Record<string, number>> | null;
  readonly auditOutputCharactersByToolP95: Readonly<Record<string, number>> | null;
  readonly modelOutputCharactersByToolMean: Readonly<Record<string, number>> | null;
  readonly modelOutputCharactersByToolP95: Readonly<Record<string, number>> | null;
}

export interface EvaluationResultComparison {
  readonly schemaVersion: 3;
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
    readonly auditOutputCharactersByToolMean: Readonly<Record<string, number>> | null;
    readonly auditOutputCharactersByToolP95: Readonly<Record<string, number>> | null;
    readonly modelOutputCharactersByToolMean: Readonly<Record<string, number>> | null;
    readonly modelOutputCharactersByToolP95: Readonly<Record<string, number>> | null;
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

function mappedSummaries(
  results: readonly EvaluationResult[],
  read: (result: EvaluationResult) => unknown,
  label: string,
): {
  readonly mean: Readonly<Record<string, number>>;
  readonly p95: Readonly<Record<string, number>>;
} {
  const counts = results.map((result) => {
    const value = read(result);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Result ${result.runId} has no comparable ${label} metric.`);
    }
    return value as Readonly<Record<string, number>>;
  });
  const names = [...new Set(counts.flatMap((value) => Object.keys(value)))].sort();
  const means: Record<string, number> = {};
  const p95: Record<string, number> = {};
  for (const name of names) {
    const values = counts.map((value) => value[name] ?? 0);
    if (values.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error(`Comparable ${label} value ${name} is invalid.`);
    }
    means[name] = mean(values);
    p95[name] = percentile95(values);
  }
  return { mean: means, p95 };
}

function toolSummaries(results: readonly EvaluationResult[]) {
  return mappedSummaries(results, (result) => result.execution.toolCounts, 'toolCounts');
}

function resultHasValidEvidence(result: EvaluationResult): boolean {
  const harnessError = result.failure?.harnessError ?? '';
  // Product task errors are valid failed outcomes. Harness errors mean the attempt cannot
  // establish product behavior and therefore cannot participate in either comparison.
  if (harnessError.length > 0) return false;
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
  const auditOutputByTool = performanceMetricsComparable
    ? mappedSummaries(
        selected,
        (result) => result.execution.auditOutputCharactersByTool,
        'auditOutputCharactersByTool',
      )
    : null;
  const modelOutputByTool = performanceMetricsComparable
    ? mappedSummaries(
        selected,
        (result) => result.execution.modelOutputCharactersByTool,
        'modelOutputCharactersByTool',
      )
    : null;
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
    auditOutputCharactersByToolMean: auditOutputByTool?.mean ?? null,
    auditOutputCharactersByToolP95: auditOutputByTool?.p95 ?? null,
    modelOutputCharactersByToolMean: modelOutputByTool?.mean ?? null,
    modelOutputCharactersByToolP95: modelOutputByTool?.p95 ?? null,
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
    schemaVersion: 3,
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
      auditOutputCharactersByToolMean:
        performanceMetricsComparable &&
        left.auditOutputCharactersByToolMean !== null &&
        right.auditOutputCharactersByToolMean !== null
          ? numericDelta(
              left.auditOutputCharactersByToolMean,
              right.auditOutputCharactersByToolMean,
            )
          : null,
      auditOutputCharactersByToolP95:
        performanceMetricsComparable &&
        left.auditOutputCharactersByToolP95 !== null &&
        right.auditOutputCharactersByToolP95 !== null
          ? numericDelta(left.auditOutputCharactersByToolP95, right.auditOutputCharactersByToolP95)
          : null,
      modelOutputCharactersByToolMean:
        performanceMetricsComparable &&
        left.modelOutputCharactersByToolMean !== null &&
        right.modelOutputCharactersByToolMean !== null
          ? numericDelta(
              left.modelOutputCharactersByToolMean,
              right.modelOutputCharactersByToolMean,
            )
          : null,
      modelOutputCharactersByToolP95:
        performanceMetricsComparable &&
        left.modelOutputCharactersByToolP95 !== null &&
        right.modelOutputCharactersByToolP95 !== null
          ? numericDelta(left.modelOutputCharactersByToolP95, right.modelOutputCharactersByToolP95)
          : null,
    },
  };
}
