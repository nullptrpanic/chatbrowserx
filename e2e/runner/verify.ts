import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyConfiguredLiveEnvironment } from './live-environment';
import { withExistingLiveSession } from './live-session';
import { resolveLiveProductTarget, resolveProductRevision } from './product-revision';
import { createPlaywrightLiveRuntime } from './run-live-scenario';
import { loadEvaluationSample, parseEvaluationSampleId } from './sample-loader';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  const sampleId = parseEvaluationSampleId(process.argv.slice(2));
  const { scenario } = await loadEvaluationSample(repositoryRoot, sampleId);
  const workspaceRevision = await resolveProductRevision(repositoryRoot).catch(() => 'unknown');
  const productTarget = resolveLiveProductTarget({
    environment: process.env,
    repositoryRoot,
    workspaceRevision,
  });
  await withExistingLiveSession(
    { repositoryRoot, environment: process.env, productTarget },
    async (session) => {
      const runtime = createPlaywrightLiveRuntime(session);
      const target = await runtime.openTarget(scenario);
      const report = await verifyConfiguredLiveEnvironment(
        runtime,
        scenario,
        target,
        `live_verify_${randomUUID()}`,
      );
      for (const check of report.checks) {
        process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`);
      }
      if (!report.passed) process.exitCode = 1;
    },
  );
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Live E2E verification failed: ${message}\n`);
  process.exitCode = 1;
});
