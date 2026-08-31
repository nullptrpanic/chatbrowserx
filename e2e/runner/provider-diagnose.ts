import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistLiveEvaluationAttempt } from './live-result-writer';
import { withExistingLiveSession } from './live-session';
import { ResponsesRequestReplayProbe, type ProviderReplayResult } from './provider-replay';
import { resolveLiveProductTarget, resolveProductRevision } from './product-revision';
import {
  createLiveHarnessFailureReport,
  createLiveRunDependencies,
  createPlaywrightLiveRuntime,
  runLiveScenario,
} from './run-live-scenario';
import type { LiveRunReport } from './live-types';
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
  let replay: ProviderReplayResult | null = null;
  let replayError: string | null = null;
  try {
    validateEvaluationSampleAuthorization(scenario, process.env);
    report = await withExistingLiveSession(
      { repositoryRoot, environment: process.env, productTarget },
      async (session) => {
        const probe = new ResponsesRequestReplayProbe(session.context, session.extensionId);
        probe.start(scenario.taskText);
        const liveReport = await runLiveScenario(
          createPlaywrightLiveRuntime(session),
          scenario,
          dependencies,
        );
        try {
          replay = await probe.replayLatest();
        } catch (error) {
          replayError = (error instanceof Error ? error.message : String(error))
            .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
            .slice(0, 1_000);
        }
        return liveReport;
      },
    );
  } catch (error) {
    report = createLiveHarnessFailureReport(scenario, error, dependencies);
  }

  const persisted = await persistLiveEvaluationAttempt(repositoryRoot, scenario, report);
  const original = report.providerTrace.requests.at(-1) ?? null;
  process.stdout.write(`Live E2E report: ${persisted.rawReportPath}\n`);
  process.stdout.write(`Evaluation result: ${persisted.evaluationResultPath}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        terminalStatus: report.terminalStatus,
        taskError: report.taskError,
        harnessError: report.harnessError,
        replayError,
        original:
          original === null
            ? null
            : {
                request: {
                  bodyValid: original.bodyValid,
                  model: original.model,
                  inputItems: original.inputItems.length,
                  functionCallCount: original.functionCallCount,
                  functionOutputCount: original.functionOutputCount,
                  encryptedReasoningInputCount: original.encryptedReasoningInputCount,
                  toolNames: original.toolNames,
                },
                response: original.response,
              },
        replay,
      },
      null,
      2,
    )}\n`,
  );
  if (replay === null || replayError !== null) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Provider diagnostic failed: ${message}\n`);
  process.exitCode = 1;
});
