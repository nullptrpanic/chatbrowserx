import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonContract } from './json-contract';
import type { LiveRunReport, LiveScenario } from './live-types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must be a non-empty string.' });
const nonNegativeInteger = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0, {
  message: 'must be a non-negative safe integer.',
});
const nonNegativeNumber = z.number().refine((value) => Number.isFinite(value) && value >= 0, {
  message: 'must be a finite non-negative number.',
});
const countsSchema = z.record(nonEmptyString, nonNegativeInteger);
const acceptanceCheckSchema = z
  .object({ name: nonEmptyString, passed: z.boolean(), detail: nonEmptyString })
  .strict();
const failureCheckSchema = z.object({ name: nonEmptyString, detail: nonEmptyString }).strict();

const evaluationResultSchema = z
  .object({
    schemaVersion: z.literal(3, { error: 'must equal 3.' }),
    sampleId: nonEmptyString,
    runId: nonEmptyString,
    productRevision: nonEmptyString,
    scenarioContractVersion: z
      .number()
      .refine((value) => Number.isSafeInteger(value) && value >= 1, {
        message: 'must be a positive safe integer.',
      }),
    startedAt: nonEmptyString,
    endedAt: nonEmptyString,
    elapsedMs: nonNegativeNumber,
    terminalStatus: nonEmptyString,
    success: z.boolean(),
    input: z.object({ text: nonEmptyString }).strict(),
    output: z.object({ text: z.string() }).strict(),
    tokenUsage: z
      .object({
        inputTokens: nonNegativeInteger,
        outputTokens: nonNegativeInteger,
        totalTokens: nonNegativeInteger,
        cachedInputTokens: nonNegativeInteger,
        cacheWriteInputTokens: nonNegativeInteger,
        reasoningOutputTokens: nonNegativeInteger,
      })
      .strict(),
    execution: z
      .object({
        modelElapsedMs: nonNegativeNumber,
        firstEventMs: nonNegativeNumber,
        firstTextMs: nonNegativeNumber,
        modelRounds: nonNegativeInteger,
        providerRetries: nonNegativeInteger,
        providerRetryCounts: countsSchema,
        toolCalls: nonNegativeInteger,
        toolCounts: countsSchema,
        providerRequests: nonNegativeInteger,
        compactionRequests: nonNegativeInteger,
        traversalSegments: nonNegativeInteger,
        screenshotFallbacks: nonNegativeInteger,
        staleRefs: nonNegativeInteger,
        stateMismatches: nonNegativeInteger,
        repeatedFingerprints: nonNegativeInteger,
        verifiedMutations: nonNegativeInteger,
        ambiguousMutations: nonNegativeInteger,
        noProgressBlocks: nonNegativeInteger,
        auditOutputCharacters: nonNegativeInteger,
        modelOutputCharacters: nonNegativeInteger,
        modelOutputReductionCharacters: nonNegativeInteger,
        toolDefinitionCharactersTotal: nonNegativeInteger,
        toolDefinitionCharactersMax: nonNegativeInteger,
        toolDefinitionSchemaChanges: nonNegativeInteger,
        toolDefinitionSchemaVariants: nonNegativeInteger,
        auditOutputCharactersByTool: countsSchema,
        modelOutputCharactersByTool: countsSchema,
      })
      .strict(),
    acceptance: z.object({ passed: z.boolean(), checks: z.array(acceptanceCheckSchema) }).strict(),
    failure: z
      .object({
        taskError: z.string().nullable().default(null),
        harnessError: z.string().nullable(),
        failedChecks: z.array(failureCheckSchema),
      })
      .strict()
      .nullable(),
    sourceReport: nonEmptyString,
  })
  .strict();

export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

/** Parses the strict current portable result contract. */
export function parseEvaluationResult(
  value: unknown,
  sampleId: string,
  filename: string,
): EvaluationResult {
  const owner = `Sample "${sampleId}" result "${filename}"`;
  const result = parseJsonContract(evaluationResultSchema, value, owner);
  if (
    !Number.isFinite(Date.parse(result.startedAt)) ||
    !Number.isFinite(Date.parse(result.endedAt))
  ) {
    throw new Error(`${owner} timestamps must be valid ISO dates.`);
  }
  if (result.sampleId !== sampleId) {
    throw new Error(`${owner} sampleId must match its sample directory.`);
  }
  if (filename !== evaluationResultFilename(result)) {
    throw new Error(`${owner} filename must match its timestamp and run ID.`);
  }
  if (result.success && !result.acceptance.passed) {
    throw new Error(`${owner} acceptance.passed must be true on success.`);
  }
  if (result.success !== (result.failure === null)) {
    throw new Error(`${owner} failure must be null exactly when success is true.`);
  }
  if (result.sourceReport !== `e2e/.runtime/live-results/${result.runId}/report.json`) {
    throw new Error(`${owner} sourceReport must identify its raw report.`);
  }
  return result;
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must be a path-safe identifier.`);
}

function materializeInput(scenario: LiveScenario, runId: string): string {
  return scenario.taskText.split('{{RUN_ID}}').join(runId);
}

/** Converts an ISO timestamp into a lexically sortable UTC filename prefix. */
export function evaluationTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('Evaluation start time is invalid.');
  return timestamp.toISOString().replaceAll('-', '').replaceAll(':', '');
}

/** Returns the immutable one-attempt result filename. */
export function evaluationResultFilename(
  report: Pick<LiveRunReport, 'runId' | 'startedAt'>,
): string {
  assertSafeId(report.runId, 'Run ID');
  return `${evaluationTimestamp(report.startedAt)}__${report.runId}.json`;
}

/** Maps a raw live report to the bounded, credential-safe comparison contract. */
export function createEvaluationResult(
  scenario: LiveScenario,
  report: LiveRunReport,
): EvaluationResult {
  assertSafeId(scenario.name, 'Sample ID');
  assertSafeId(report.runId, 'Run ID');
  if (report.scenario !== scenario.name) {
    throw new Error('Live report scenario does not match the evaluation sample.');
  }
  if (report.scenarioContractVersion !== scenario.contractVersion) {
    throw new Error('Live report contract version does not match the evaluation sample.');
  }
  const failedChecks = report.acceptance.checks
    .filter((check) => !check.passed)
    .map(({ name, detail }) => ({ name, detail }));
  const success =
    report.acceptance.passed && report.taskError === null && report.harnessError === null;
  return {
    schemaVersion: 3,
    sampleId: scenario.name,
    runId: report.runId,
    productRevision: report.productRevision,
    scenarioContractVersion: report.scenarioContractVersion,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    elapsedMs: report.elapsedMs,
    terminalStatus: report.terminalStatus,
    success,
    input: { text: materializeInput(scenario, report.runId) },
    output: { text: report.finalText },
    tokenUsage: {
      inputTokens: report.modelMetrics.inputTokens,
      outputTokens: report.modelMetrics.outputTokens,
      totalTokens: report.modelMetrics.totalTokens,
      cachedInputTokens: report.modelMetrics.cachedInputTokens,
      cacheWriteInputTokens: report.modelMetrics.cacheWriteInputTokens,
      reasoningOutputTokens: report.modelMetrics.reasoningOutputTokens,
    },
    execution: {
      modelElapsedMs: report.modelMetrics.elapsedMs,
      firstEventMs: report.modelMetrics.firstEventMs,
      firstTextMs: report.modelMetrics.firstTextMs,
      modelRounds: report.executionMetrics.modelRounds,
      providerRetries: report.executionMetrics.providerRetries,
      providerRetryCounts: { ...report.executionMetrics.providerRetryCounts },
      toolCalls: report.executionMetrics.toolCalls,
      toolCounts: { ...report.executionMetrics.toolCounts },
      providerRequests: report.providerTrace.requestCount,
      compactionRequests: report.providerTrace.compactionRequestCount ?? 0,
      traversalSegments: report.executionMetrics.traversalSegments,
      screenshotFallbacks: report.executionMetrics.screenshotFallbacks,
      staleRefs: report.executionMetrics.staleRefs,
      stateMismatches: report.executionMetrics.stateMismatches,
      repeatedFingerprints: report.executionMetrics.repeatedFingerprints,
      verifiedMutations: report.executionMetrics.verifiedMutations,
      ambiguousMutations: report.executionMetrics.ambiguousMutations,
      noProgressBlocks: report.executionMetrics.noProgressBlocks,
      auditOutputCharacters: report.executionMetrics.auditOutputCharacters,
      modelOutputCharacters: report.executionMetrics.modelOutputCharacters,
      modelOutputReductionCharacters: report.executionMetrics.modelOutputReductionCharacters,
      toolDefinitionCharactersTotal: report.executionMetrics.toolDefinitionCharactersTotal,
      toolDefinitionCharactersMax: report.executionMetrics.toolDefinitionCharactersMax,
      toolDefinitionSchemaChanges: report.executionMetrics.toolDefinitionSchemaChanges,
      toolDefinitionSchemaVariants: report.executionMetrics.toolDefinitionSchemaVariants,
      auditOutputCharactersByTool: {
        ...report.executionMetrics.auditOutputCharactersByTool,
      },
      modelOutputCharactersByTool: {
        ...report.executionMetrics.modelOutputCharactersByTool,
      },
    },
    acceptance: {
      passed: report.acceptance.passed,
      checks: report.acceptance.checks.map((check) => ({ ...check })),
    },
    failure: success
      ? null
      : { taskError: report.taskError, harnessError: report.harnessError, failedChecks },
    sourceReport: `e2e/.runtime/live-results/${report.runId}/report.json`,
  };
}

/** Persists one success or failure attempt below its owning sample directory. */
export async function writeEvaluationResult(
  repositoryRoot: string,
  scenario: LiveScenario,
  report: LiveRunReport,
): Promise<string> {
  const directory = join(repositoryRoot, 'e2e', 'samples', scenario.name, 'results');
  const path = join(directory, evaluationResultFilename(report));
  await mkdir(directory, { recursive: true });
  await writeFile(path, `${JSON.stringify(createEvaluationResult(scenario, report), null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return path;
}
