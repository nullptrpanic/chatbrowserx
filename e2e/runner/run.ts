import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistLiveEvaluationAttempt } from './live-result-writer';
import { withExistingLiveSession } from './live-session';
import {
  createLiveRunDependencies,
  createLiveHarnessFailureReport,
  createPlaywrightLiveRuntime,
  runLiveScenario,
} from './run-live-scenario';
import type { LiveRunReport } from './live-types';
import { resolveLiveProductTarget, resolveProductRevision } from './product-revision';
import {
  loadEvaluationSample,
  parseEvaluationSampleId,
  validateEvaluationSampleAuthorization,
} from './sample-loader';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  const scenarioName = parseEvaluationSampleId(process.argv.slice(2));
  const { scenario } = await loadEvaluationSample(repositoryRoot, scenarioName);
  const workspaceRevision = await resolveProductRevision(repositoryRoot).catch(() => 'unknown');
  const productTarget = resolveLiveProductTarget({
    environment: process.env,
    repositoryRoot,
    workspaceRevision,
  });
  const dependencies = createLiveRunDependencies(productTarget.productRevision);
  let report: LiveRunReport;
  try {
    validateEvaluationSampleAuthorization(scenario, process.env);
    report = await withExistingLiveSession(
      { repositoryRoot, environment: process.env, productTarget },
      (session) => runLiveScenario(createPlaywrightLiveRuntime(session), scenario, dependencies),
    );
  } catch (error) {
    report = createLiveHarnessFailureReport(scenario, error, dependencies);
  }

  const persisted = await persistLiveEvaluationAttempt(repositoryRoot, scenario, report);
  process.stdout.write(`Live E2E report: ${persisted.rawReportPath}\n`);
  process.stdout.write(`Evaluation result: ${persisted.evaluationResultPath}\n`);
  process.stdout.write(`terminalStatus: ${report.terminalStatus}\n`);
  for (const check of report.acceptance.checks) {
    process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`);
  }
  if (report.taskError !== null) {
    process.stdout.write(`taskError: ${report.taskError}\n`);
  }
  if (report.harnessError !== null) {
    process.stdout.write(`harnessError: ${report.harnessError}\n`);
  }
  if (!report.acceptance.passed || report.taskError !== null || report.harnessError !== null) {
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Live E2E run failed: ${message}\n`);
  process.exitCode = 1;
});
