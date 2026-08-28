import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvaluationCatalog } from './evaluation-catalog';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const catalog = await validateEvaluationCatalog(repositoryRoot);
for (const sample of catalog.samples) {
  const bestCurrentBatch = [...sample.currentContractRevisionBatches].sort(
    (left, right) =>
      right.passedResultCount - left.passedResultCount || right.resultCount - left.resultCount,
  )[0];
  process.stdout.write(
    `${sample.id}: history=${String(sample.resultCount)} currentContract=${String(sample.currentContractResultCount)} currentPassed=${String(sample.currentContractPassedResultCount)} bestRevisionBatch=${String(bestCurrentBatch?.passedResultCount ?? 0)}/${String(bestCurrentBatch?.resultCount ?? 0)} required=${String(sample.requiredRuns)}\n`,
  );
}
process.stdout.write(`Validated ${String(catalog.samples.length)} E2E samples.\n`);
