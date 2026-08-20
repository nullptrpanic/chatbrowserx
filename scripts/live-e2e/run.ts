import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLiveProfileLock, resolveLiveProfilePath } from './live-profile';
import { createLoadedExtensionSession, type ExtensionSession } from './extension-session';
import { createPlaywrightLiveRuntime, runLiveScenario } from './run-live-scenario';
import {
  getLiveScenario,
  parseLiveScenarioName,
  validateLiveScenarioAuthorization,
} from './scenarios';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function main(): Promise<void> {
  const scenarioName = parseLiveScenarioName(process.argv.slice(2));
  const scenario = getLiveScenario(scenarioName);
  validateLiveScenarioAuthorization(scenario, process.env);
  const profilePath = resolveLiveProfilePath(process.env, repositoryRoot);
  const profileExists = await stat(profilePath)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (!profileExists) {
    throw new Error('Dedicated Live E2E Profile is missing. Run pnpm e2e:live:setup first.');
  }

  const lock = await acquireLiveProfileLock(profilePath);
  let session: ExtensionSession | null = null;
  try {
    session = await createLoadedExtensionSession({
      profilePath,
      removeProfileOnClose: false,
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
      headless: false,
    });
    const report = await runLiveScenario(createPlaywrightLiveRuntime(session), scenario);
    const reportDirectory = join(repositoryRoot, 'test-results', 'live-e2e', report.runId);
    const reportPath = join(reportDirectory, 'report.json');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    process.stdout.write(`Live E2E report: ${reportPath}\n`);
    process.stdout.write(`terminalStatus: ${report.terminalStatus}\n`);
    for (const check of report.acceptance.checks) {
      process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`);
    }
    if (report.harnessError !== null) {
      process.stdout.write(`harnessError: ${report.harnessError}\n`);
    }
    if (!report.acceptance.passed) process.exitCode = 1;
  } finally {
    await session?.close().catch(() => undefined);
    await lock.release();
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Live E2E run failed: ${message}\n`);
  process.exitCode = 1;
});
