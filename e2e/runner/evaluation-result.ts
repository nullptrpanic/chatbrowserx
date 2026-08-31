import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonContract } from './json-contract';
import type { LiveRunReport, LiveScenario } from './live-types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const BATCH_ID = /^\d{8}T\d{6}\.\d{3}Z$/;
const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must be a non-empty string.',
});
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
const positiveInteger = z.number().refine((value) => Number.isSafeInteger(value) && value >= 1, {
  message: 'must be a positive safe integer.',
});
const evaluationCollectionSchema = z.enum(['results', 'benchmark']);
const batchSchema = z
  .object({
    collection: evaluationCollectionSchema,
    id: z.string().regex(BATCH_ID, { message: 'must be a sortable UTC timestamp.' }),
    startedAt: nonEmptyString,
    requestedRuns: positiveInteger,
    attempt: positiveInteger,
  })
  .strict();
const toolResultSchema = z
  .object({
    toolName: nonEmptyString,
    argumentsJson: z.string(),
    output: z.string(),
    attachmentIds: z.array(z.string()),
    auditOutputCharacters: nonNegativeInteger.optional(),
    modelOutputCharacters: nonNegativeInteger.optional(),
  })
  .strict();
const providerTraceSchema = z
  .object({
    requestCount: nonNegativeInteger,
    requests: z.array(z.unknown()),
    compactionRequestCount: nonNegativeInteger.optional(),
    compactionRequests: z.array(z.unknown()).optional(),
  })
  .strict();

const evaluationResultSchema = z
  .object({
    schemaVersion: z.literal(4, { error: 'must equal 4.' }),
    sampleId: nonEmptyString,
    batch: batchSchema,
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
        fullInteractiveObservations: nonNegativeInteger,
        providerRequests: nonNegativeInteger,
        compactionRequests: nonNegativeInteger,
        traversalSegments: nonNegativeInteger,
        screenshotFallbacks: nonNegativeInteger,
        screenshotFallbackReasons: countsSchema,
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
        enabledToolsets: z.array(nonEmptyString),
        skillCatalogDisclosureCount: nonNegativeInteger,
        exactReads: nonNegativeInteger,
        auditOutputCharactersByTool: countsSchema,
        modelOutputCharactersByTool: countsSchema,
      })
      .strict(),
    acceptance: z.object({ passed: z.boolean(), checks: z.array(acceptanceCheckSchema) }).strict(),
    failure: z
      .object({
        taskError: z.string().nullable(),
        harnessError: z.string().nullable(),
        failedChecks: z.array(failureCheckSchema),
      })
      .strict()
      .nullable(),
    evidence: z
      .object({
        taskId: nonEmptyString.nullable(),
        conversationId: nonEmptyString.nullable(),
        toolResults: z.array(toolResultSchema),
        providerTrace: providerTraceSchema,
      })
      .strict(),
  })
  .strict();

export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
export type EvaluationCollection = z.infer<typeof evaluationCollectionSchema>;

export interface EvaluationBatch {
  readonly collection: EvaluationCollection;
  readonly id: string;
  readonly startedAt: string;
  readonly requestedRuns: number;
}

/** Parses the strict current portable result contract. */
export function parseEvaluationResult(
  value: unknown,
  sampleId: string,
  batchId: string,
  filename: string,
): EvaluationResult {
  const owner = `Sample "${sampleId}" result "${batchId}/${filename}"`;
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
  if (result.batch.id !== batchId) {
    throw new Error(`${owner} batch.id must match its batch directory.`);
  }
  if (
    !Number.isFinite(Date.parse(result.batch.startedAt)) ||
    evaluationTimestamp(result.batch.startedAt) !== result.batch.id
  ) {
    throw new Error(`${owner} batch timestamp must match its batch ID.`);
  }
  if (result.batch.attempt > result.batch.requestedRuns) {
    throw new Error(`${owner} batch.attempt cannot exceed batch.requestedRuns.`);
  }
  if (filename !== evaluationResultFilename(result.batch.attempt)) {
    throw new Error(`${owner} filename must match its attempt number.`);
  }
  if (result.success && !result.acceptance.passed) {
    throw new Error(`${owner} acceptance.passed must be true on success.`);
  }
  if (result.success !== (result.failure === null)) {
    throw new Error(`${owner} failure must be null exactly when success is true.`);
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

export function createEvaluationBatch(
  collection: EvaluationCollection,
  startedAt: string,
  requestedRuns: number,
): EvaluationBatch {
  if (!Number.isSafeInteger(requestedRuns) || requestedRuns < 1 || requestedRuns > 20) {
    throw new RangeError('Evaluation batch runs must be an integer between 1 and 20.');
  }
  return {
    collection,
    id: evaluationTimestamp(startedAt),
    startedAt: new Date(startedAt).toISOString(),
    requestedRuns,
  };
}

/** Returns the immutable one-attempt result filename within a batch. */
export function evaluationResultFilename(attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 20) {
    throw new RangeError('Evaluation attempt must be an integer between 1 and 20.');
  }
  return `${String(attempt).padStart(2, '0')}.json`;
}

/** Maps a raw live report to the bounded, credential-safe comparison contract. */
export function createEvaluationResult(
  scenario: LiveScenario,
  batch: EvaluationBatch,
  attempt: number,
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
  if (attempt > batch.requestedRuns) {
    throw new RangeError('Evaluation attempt cannot exceed the requested batch runs.');
  }
  const filename = evaluationResultFilename(attempt);
  const failedChecks = report.acceptance.checks
    .filter((check) => !check.passed)
    .map(({ name, detail }) => ({ name, detail }));
  const success =
    report.acceptance.passed && report.taskError === null && report.harnessError === null;
  const result: EvaluationResult = {
    schemaVersion: 4,
    sampleId: scenario.name,
    batch: { ...batch, attempt },
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
      fullInteractiveObservations: report.executionMetrics.fullInteractiveObservations,
      providerRequests: report.providerTrace.requestCount,
      compactionRequests: report.providerTrace.compactionRequestCount ?? 0,
      traversalSegments: report.executionMetrics.traversalSegments,
      screenshotFallbacks: report.executionMetrics.screenshotFallbacks,
      screenshotFallbackReasons: {
        ...report.executionMetrics.screenshotFallbackReasons,
      },
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
      enabledToolsets: [...report.executionMetrics.enabledToolsets],
      skillCatalogDisclosureCount: report.executionMetrics.skillCatalogDisclosureCount,
      exactReads: report.executionMetrics.exactReads,
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
      : {
          taskError: report.taskError,
          harnessError: report.harnessError,
          failedChecks,
        },
    evidence: {
      taskId: report.taskId.length === 0 ? null : report.taskId,
      conversationId: report.conversationId.length === 0 ? null : report.conversationId,
      toolResults: report.toolResults.map((result) => ({
        ...result,
        attachmentIds: [...result.attachmentIds],
      })),
      providerTrace: {
        requestCount: report.providerTrace.requestCount,
        requests: [...report.providerTrace.requests],
        ...(report.providerTrace.compactionRequestCount === undefined
          ? {}
          : {
              compactionRequestCount: report.providerTrace.compactionRequestCount,
            }),
        ...(report.providerTrace.compactionRequests === undefined
          ? {}
          : {
              compactionRequests: [...report.providerTrace.compactionRequests],
            }),
      },
    },
  };
  return parseEvaluationResult(result, scenario.name, batch.id, filename);
}

/** Persists one success or failure attempt below its owning sample directory. */
export async function writeEvaluationResult(
  repositoryRoot: string,
  scenario: LiveScenario,
  batch: EvaluationBatch,
  attempt: number,
  report: LiveRunReport,
): Promise<string> {
  const directory = join(
    repositoryRoot,
    'e2e',
    'samples',
    scenario.name,
    batch.collection,
    batch.id,
  );
  const path = join(directory, evaluationResultFilename(attempt));
  await mkdir(directory, { recursive: true });
  if (attempt > 1) {
    const previousFilename = evaluationResultFilename(attempt - 1);
    const previousExists = await stat(join(directory, previousFilename))
      .then((entry) => entry.isFile())
      .catch(() => false);
    if (!previousExists) {
      throw new Error(`Evaluation previous batch attempt ${previousFilename} is missing.`);
    }
  }
  await writeFile(
    path,
    `${JSON.stringify(createEvaluationResult(scenario, batch, attempt, report), null, 2)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
    },
  );
  return path;
}
