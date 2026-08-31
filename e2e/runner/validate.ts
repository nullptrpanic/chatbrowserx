import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvaluationCatalog } from './evaluation-catalog';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const catalog = await validateEvaluationCatalog(repositoryRoot);
for (const sample of catalog.samples) {
  const bestCurrentBatch = [...sample.benchmark.revisionBatches].sort(
    (left, right) => right.passed - left.passed || right.attempts - left.attempts,
  )[0];
  process.stdout.write(
    `${sample.id}: results=${String(sample.results.passed)}/${String(sample.results.attempts)} benchmark=${String(sample.benchmark.passed)}/${String(sample.benchmark.attempts)} currentBenchmark=${String(sample.benchmark.currentContractPassed)}/${String(sample.benchmark.currentContractAttempts)} bestRevision=${String(bestCurrentBatch?.passed ?? 0)}/${String(bestCurrentBatch?.attempts ?? 0)} required=${String(sample.requiredRuns)}\n`,
  );
}
process.stdout.write(`Validated ${String(catalog.samples.length)} E2E samples.\n`);
