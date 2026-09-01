import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createEvaluationBatchReport, parseEvaluationBatchReport } from './evaluation-batch-report';
import { parseEvaluationResult, type EvaluationResult } from './evaluation-result';
import { readJsonFile } from './json-contract';

const BATCH_DIRECTORY = /^\d{8}T\d{6}\.\d{3}Z$/;
const RESULT_FILENAME = /^(?:0[1-9]|1\d|20)\.json$/;

/** Loads only strict current-schema attempts from the current batch layout. */
export async function loadEvaluationResults(
  directory: string,
  sampleId: string,
): Promise<readonly EvaluationResult[]> {
  const collection = basename(directory);
  if (collection !== 'benchmark') {
    throw new Error(`Sample "${sampleId}" result collection must be benchmark.`);
  }
  const entry = await stat(directory).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });
  if (entry === null) return [];
  if (!entry.isDirectory()) {
    throw new Error(`Sample "${sampleId}" result collection must be a directory.`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const batchDirectories: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && BATCH_DIRECTORY.test(entry.name)) {
      batchDirectories.push(entry.name);
      continue;
    }
    throw new Error(
      `Sample "${sampleId}" result "${entry.name}" must be a sortable UTC batch directory.`,
    );
  }
  const results: EvaluationResult[] = [];
  for (const batchId of batchDirectories.toSorted()) {
    const batchDirectory = join(directory, batchId);
    const batchEntries = (await readdir(batchDirectory, { withFileTypes: true })).toSorted(
      (left, right) => left.name.localeCompare(right.name),
    );
    const reportEntry = batchEntries.find((entry) => entry.name === 'report.json');
    if (reportEntry === undefined || !reportEntry.isFile()) {
      throw new Error(`Sample "${sampleId}" batch "${batchId}" report.json is missing.`);
    }
    const attempts = batchEntries.filter((entry) => entry.name !== 'report.json');
    const batchResults: EvaluationResult[] = [];
    let firstResult: EvaluationResult | undefined;
    const runIds = new Set<string>();
    for (const [index, entry] of attempts.entries()) {
      if (!entry.isFile() || !RESULT_FILENAME.test(entry.name)) {
        throw new Error(
          `Sample "${sampleId}" result "${batchId}/${entry.name}" must use 01.json through 20.json.`,
        );
      }
      const expectedFilename = `${String(index + 1).padStart(2, '0')}.json`;
      if (entry.name !== expectedFilename) {
        throw new Error(
          `Sample "${sampleId}" batch "${batchId}" attempt files must be contiguous from 01.json.`,
        );
      }
      const value = await readJsonFile(join(batchDirectory, entry.name));
      const result = parseEvaluationResult(value, sampleId, batchId, entry.name);
      if (result.batch.collection !== collection) {
        throw new Error(
          `Sample "${sampleId}" result "${batchId}/${entry.name}" collection must match its directory.`,
        );
      }
      if (firstResult !== undefined) {
        if (result.batch.requestedRuns !== firstResult.batch.requestedRuns) {
          throw new Error(
            `Sample "${sampleId}" batch "${batchId}" requested runs must be consistent within its batch.`,
          );
        }
        if (result.productRevision !== firstResult.productRevision) {
          throw new Error(
            `Sample "${sampleId}" batch "${batchId}" product revision must be consistent within its batch.`,
          );
        }
        if (result.scenarioContractVersion !== firstResult.scenarioContractVersion) {
          throw new Error(
            `Sample "${sampleId}" batch "${batchId}" contract version must be consistent within its batch.`,
          );
        }
      } else {
        firstResult = result;
      }
      if (runIds.has(result.runId)) {
        throw new Error(`Sample "${sampleId}" batch "${batchId}" run IDs must be unique.`);
      }
      runIds.add(result.runId);
      batchResults.push(result);
      results.push(result);
    }
    const report = parseEvaluationBatchReport(
      await readJsonFile(join(batchDirectory, 'report.json')),
      sampleId,
      batchId,
    );
    const expectedReport = createEvaluationBatchReport(batchResults);
    if (!isDeepStrictEqual(report, expectedReport)) {
      throw new Error(
        `Sample "${sampleId}" batch "${batchId}" report.json does not match its attempts.`,
      );
    }
  }
  return results;
}
