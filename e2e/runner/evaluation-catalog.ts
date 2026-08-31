import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveScenario } from './live-types';
import { loadEvaluationResults } from './evaluation-result-loader';
import { listEvaluationSamples, type EvaluationSampleDefinition } from './sample-loader';

export type { EvaluationSampleDefinition } from './sample-loader';

export interface EvaluationSampleSummary extends EvaluationSampleDefinition {
  readonly directory: string;
  readonly scenario: LiveScenario;
  readonly results: EvaluationCollectionSummary;
  readonly benchmark: EvaluationCollectionSummary;
}

export interface EvaluationRevisionBatch {
  readonly productRevision: string;
  readonly attempts: number;
  readonly passed: number;
}

export interface EvaluationCollectionSummary {
  readonly attempts: number;
  readonly passed: number;
  readonly currentContractAttempts: number;
  readonly currentContractPassed: number;
  readonly revisionBatches: readonly EvaluationRevisionBatch[];
}

export interface EvaluationCatalog {
  readonly samples: readonly EvaluationSampleSummary[];
}

async function validateResults(
  directory: string,
  sampleId: string,
  currentContractVersion: number,
): Promise<EvaluationCollectionSummary> {
  const results = await loadEvaluationResults(directory, sampleId);
  let passed = 0;
  let currentContractAttempts = 0;
  let currentContractPassedResultCount = 0;
  const currentBatches = new Map<string, { attempts: number; passed: number }>();
  for (const input of results) {
    const contractVersion = input.scenarioContractVersion;
    const productRevision = input.productRevision;
    if (input.success) passed += 1;
    if (contractVersion === currentContractVersion) {
      currentContractAttempts += 1;
      if (input.success) currentContractPassedResultCount += 1;
      const batch = currentBatches.get(productRevision) ?? {
        attempts: 0,
        passed: 0,
      };
      currentBatches.set(productRevision, {
        attempts: batch.attempts + 1,
        passed: batch.passed + (input.success ? 1 : 0),
      });
    }
  }
  return {
    attempts: results.length,
    passed,
    currentContractAttempts,
    currentContractPassed: currentContractPassedResultCount,
    revisionBatches: [...currentBatches]
      .map(([productRevision, counts]) => ({ productRevision, ...counts }))
      .sort((left, right) => left.productRevision.localeCompare(right.productRevision)),
  };
}

const EMPTY_COLLECTION: EvaluationCollectionSummary = {
  attempts: 0,
  passed: 0,
  currentContractAttempts: 0,
  currentContractPassed: 0,
  revisionBatches: [],
};

async function validateOptionalBenchmark(
  directory: string,
  sampleId: string,
  currentContractVersion: number,
): Promise<EvaluationCollectionSummary> {
  const exists = await stat(directory)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (!exists) return EMPTY_COLLECTION;
  return validateResults(directory, sampleId, currentContractVersion);
}

/** Validates the complete local sample catalog without a code-owned scenario registry. */
export async function validateEvaluationCatalog(
  repositoryRoot: string,
): Promise<EvaluationCatalog> {
  const loaded = await listEvaluationSamples(repositoryRoot);
  const samples = await Promise.all(
    loaded.map(async ({ directory, definition, scenario }) => {
      const [results, benchmark] = await Promise.all([
        validateResults(join(directory, 'results'), definition.id, definition.contractVersion),
        validateOptionalBenchmark(
          join(directory, 'benchmark'),
          definition.id,
          definition.contractVersion,
        ),
      ]);
      return {
        ...definition,
        directory,
        scenario,
        results,
        benchmark,
      };
    }),
  );
  samples.sort((left, right) => left.id.localeCompare(right.id));
  return { samples };
}
