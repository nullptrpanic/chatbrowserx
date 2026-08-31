import { join } from 'node:path';
import type { LiveScenario } from './live-types';
import { loadEvaluationResults } from './evaluation-result-loader';
import { listEvaluationSamples, type EvaluationSampleDefinition } from './sample-loader';

export type { EvaluationSampleDefinition } from './sample-loader';

export interface EvaluationSampleSummary extends EvaluationSampleDefinition {
  readonly directory: string;
  readonly scenario: LiveScenario;
  readonly resultCount: number;
  readonly passedResultCount: number;
  readonly currentContractResultCount: number;
  readonly currentContractPassedResultCount: number;
  readonly currentContractRevisionBatches: readonly EvaluationRevisionBatch[];
}

export interface EvaluationRevisionBatch {
  readonly productRevision: string;
  readonly resultCount: number;
  readonly passedResultCount: number;
}

export interface EvaluationCatalog {
  readonly samples: readonly EvaluationSampleSummary[];
}

async function validateResults(
  directory: string,
  sampleId: string,
  currentContractVersion: number,
): Promise<{
  readonly resultCount: number;
  readonly passedResultCount: number;
  readonly currentContractResultCount: number;
  readonly currentContractPassedResultCount: number;
  readonly currentContractRevisionBatches: readonly EvaluationRevisionBatch[];
}> {
  const results = await loadEvaluationResults(directory, sampleId);
  let resultCount = 0;
  let passedResultCount = 0;
  let currentContractResultCount = 0;
  let currentContractPassedResultCount = 0;
  const currentBatches = new Map<string, { resultCount: number; passedResultCount: number }>();
  for (const input of results) {
    const contractVersion = input.scenarioContractVersion;
    const productRevision = input.productRevision;
    resultCount += 1;
    if (input.success) passedResultCount += 1;
    if (contractVersion === currentContractVersion) {
      currentContractResultCount += 1;
      if (input.success) currentContractPassedResultCount += 1;
      const batch = currentBatches.get(productRevision) ?? {
        resultCount: 0,
        passedResultCount: 0,
      };
      currentBatches.set(productRevision, {
        resultCount: batch.resultCount + 1,
        passedResultCount: batch.passedResultCount + (input.success ? 1 : 0),
      });
    }
  }
  return {
    resultCount,
    passedResultCount,
    currentContractResultCount,
    currentContractPassedResultCount,
    currentContractRevisionBatches: [...currentBatches]
      .map(([productRevision, counts]) => ({ productRevision, ...counts }))
      .sort((left, right) => left.productRevision.localeCompare(right.productRevision)),
  };
}

/** Validates the complete local sample catalog without a code-owned scenario registry. */
export async function validateEvaluationCatalog(
  repositoryRoot: string,
): Promise<EvaluationCatalog> {
  const loaded = await listEvaluationSamples(repositoryRoot);
  const samples = await Promise.all(
    loaded.map(async ({ directory, definition, scenario }) => ({
      ...definition,
      directory,
      scenario,
      ...(await validateResults(
        join(directory, 'results'),
        definition.id,
        definition.contractVersion,
      )),
    })),
  );
  samples.sort((left, right) => left.id.localeCompare(right.id));
  return { samples };
}
