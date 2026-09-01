import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvaluationBatch, writeEvaluationResult } from './evaluation-result';
import { parseLiveBenchmarkArguments, runLiveBenchmark } from './live-benchmark';
import { withExistingLiveSession } from './live-session';
import { resolveLiveProductTarget, resolveProductRevision } from './product-revision';
import {
  createLiveRunDependencies,
  createPlaywrightLiveRuntime,
  runLiveScenario,
} from './run-live-scenario';
import { loadEvaluationSample, validateEvaluationSampleAuthorization } from './sample-loader';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  const parsed = parseLiveBenchmarkArguments(process.argv.slice(2));
  const { scenario } = await loadEvaluationSample(repositoryRoot, parsed.scenario);
  validateEvaluationSampleAuthorization(scenario, process.env);
  const productTarget = resolveLiveProductTarget({
    environment: process.env,
    repositoryRoot,
    workspaceRevision: await resolveProductRevision(repositoryRoot),
  });
  const productRevision = productTarget.productRevision;
  const batch = createEvaluationBatch(new Date().toISOString(), parsed.runs);
  const benchmark = await withExistingLiveSession(
    {
      repositoryRoot,
      environment: process.env,
      productTarget,
      execution: {
        sampleId: scenario.name,
        exclusiveResources: scenario.exclusiveResources,
      },
    },
    async (session) => {
      const runtime = createPlaywrightLiveRuntime(session);
      return runLiveBenchmark({
        scenario: scenario.name,
        runs: parsed.runs,
        productRevision,
        scenarioContractVersion: scenario.contractVersion,
        async runAttempt(attempt) {
          const report = await runLiveScenario(
            runtime,
            scenario,
            createLiveRunDependencies(productRevision),
          );
          const reportPath = await writeEvaluationResult(
            repositoryRoot,
            scenario,
            batch,
            attempt,
            report,
          );
          process.stdout.write(`Evaluation report: ${reportPath}\n`);
          return report;
        },
      });
    },
  );
  process.stdout.write(
    `completed=${String(benchmark.completedRuns)} passed=${String(benchmark.passedRuns)} requested=${String(benchmark.requestedRuns)}\n`,
  );
  if (benchmark.completedRuns !== benchmark.requestedRuns || benchmark.stoppedOnFailure) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Live E2E benchmark failed: ${message}\n`);
  process.exitCode = 1;
});
