import { rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonContract } from './json-contract';
import type { EvaluationResult } from './evaluation-result';

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const nonNegativeNumber = z.number().finite().nonnegative();

const evaluationBatchReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    sampleId: nonEmptyString,
    collection: z.literal('benchmark'),
    batchId: nonEmptyString,
    requestedRuns: z.number().int().positive(),
    completedRuns: z.number().int().positive(),
    successfulRuns: nonNegativeInteger,
    failedRuns: nonNegativeInteger,
    totalProviderRequests: nonNegativeInteger,
    totalProviderRequestElapsedMs: nonNegativeNumber,
    averageTotalTokens: nonNegativeNumber,
    averageElapsedMs: nonNegativeNumber,
    averageToolCalls: nonNegativeNumber,
    averageProviderRequestElapsedMs: nonNegativeNumber,
  })
  .strict();

export type EvaluationBatchReport = z.infer<typeof evaluationBatchReportSchema>;

function roundedMean(total: number, count: number): number {
  return count === 0 ? 0 : Number((total / count).toFixed(6));
}

/** Derives one aggregate-only summary from the immutable attempts in a batch. */
export function createEvaluationBatchReport(
  results: readonly EvaluationResult[],
): EvaluationBatchReport {
  const first = results[0];
  if (first === undefined) throw new Error('Evaluation batch report requires one attempt.');
  if (
    results.some(
      (result) =>
        result.sampleId !== first.sampleId ||
        result.batch.collection !== first.batch.collection ||
        result.batch.id !== first.batch.id ||
        result.batch.requestedRuns !== first.batch.requestedRuns,
    )
  ) {
    throw new Error('Evaluation batch report attempts are inconsistent.');
  }

  const successfulRuns = results.filter(({ success }) => success).length;
  const providerRequests = results.reduce(
    (total, result) => total + result.execution.providerRequests,
    0,
  );
  const providerRequestElapsedMs = results.reduce(
    (total, result) => total + result.execution.modelElapsedMs,
    0,
  );
  return evaluationBatchReportSchema.parse({
    schemaVersion: 1,
    sampleId: first.sampleId,
    collection: first.batch.collection,
    batchId: first.batch.id,
    requestedRuns: first.batch.requestedRuns,
    completedRuns: results.length,
    successfulRuns,
    failedRuns: results.length - successfulRuns,
    totalProviderRequests: providerRequests,
    totalProviderRequestElapsedMs: providerRequestElapsedMs,
    averageTotalTokens: roundedMean(
      results.reduce((total, result) => total + result.tokenUsage.totalTokens, 0),
      results.length,
    ),
    averageElapsedMs: roundedMean(
      results.reduce((total, result) => total + result.elapsedMs, 0),
      results.length,
    ),
    averageToolCalls: roundedMean(
      results.reduce((total, result) => total + result.execution.toolCalls, 0),
      results.length,
    ),
    averageProviderRequestElapsedMs: roundedMean(providerRequestElapsedMs, providerRequests),
  });
}

export function parseEvaluationBatchReport(
  value: unknown,
  sampleId: string,
  batchId: string,
): EvaluationBatchReport {
  return parseJsonContract(
    evaluationBatchReportSchema,
    value,
    `Sample "${sampleId}" batch report "${batchId}/report.json"`,
  );
}

/** Atomically replaces the derived summary without changing immutable attempt files. */
export async function writeEvaluationBatchReport(
  directory: string,
  report: EvaluationBatchReport,
): Promise<string> {
  const path = join(directory, 'report.json');
  const temporaryPath = join(directory, '.report.json.tmp');
  try {
    await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return path;
}
