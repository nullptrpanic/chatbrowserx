import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEvaluationResult, type EvaluationResult } from './evaluation-result';
import { jsonRecord, readJsonFile } from './json-contract';

const RESULT_FILENAME = /^\d{8}T\d{6}\.\d{3}Z__[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/;

/** Loads strict current-schema attempts while leaving older schemas as archives. */
export async function loadEvaluationResults(
  directory: string,
  sampleId: string,
): Promise<readonly EvaluationResult[]> {
  const exists = await stat(directory)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (!exists) throw new Error(`Sample "${sampleId}" results directory is missing.`);

  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries.map((entry) => {
    if (!entry.isFile() || !RESULT_FILENAME.test(entry.name)) {
      throw new Error(
        `Sample "${sampleId}" result "${entry.name}" must use <UTC-timestamp>__<run-id>.json.`,
      );
    }
    return entry.name;
  });
  const results: EvaluationResult[] = [];
  for (const filename of filenames.toSorted()) {
    const value = await readJsonFile(join(directory, filename));
    if (jsonRecord(value)?.schemaVersion !== 3) continue;
    results.push(parseEvaluationResult(value, sampleId, filename));
  }
  return results;
}
