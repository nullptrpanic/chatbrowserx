import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLiveProfileLock, resolveLiveProfilePath } from './live-profile';
import { createLoadedExtensionSession, type ExtensionSession } from './extension-session';
import { verifyConfiguredLiveEnvironment } from './live-environment';
import { createPlaywrightLiveRuntime } from './run-live-scenario';
import { loadEvaluationSample, parseEvaluationSampleId } from './sample-loader';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function waitForEnterOrSigint(): Promise<'enter' | 'sigint'> {
  return new Promise((resolveWait) => {
    const cleanup = () => {
      stdin.off('data', onData);
      process.off('SIGINT', onSigint);
      stdin.pause();
    };
    const onData = () => {
      cleanup();
      resolveWait('enter');
    };
    const onSigint = () => {
      cleanup();
      resolveWait('sigint');
    };
    stdin.resume();
    stdin.once('data', onData);
    process.once('SIGINT', onSigint);
  });
}

async function main(): Promise<void> {
  const sampleId = parseEvaluationSampleId(process.argv.slice(2));
  const { scenario } = await loadEvaluationSample(repositoryRoot, sampleId);
  const profilePath = resolveLiveProfilePath(process.env, repositoryRoot);
  const lock = await acquireLiveProfileLock(profilePath);
  let session: ExtensionSession | null = null;
  try {
    session = await createLoadedExtensionSession({
      profilePath,
      removeProfileOnClose: false,
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
      headless: false,
    });
    const runtime = createPlaywrightLiveRuntime(session);
    const target = await runtime.openTarget(scenario);

    stdout.write(`Live E2E Profile: ${profilePath}\n`);
    stdout.write('1. Configure the Codex access token through the ChatBrowserX settings UI.\n');
    for (const [index, instruction] of scenario.environment?.targetSetupInstructions.entries() ??
      []) {
      stdout.write(`${String(index + 2)}. ${instruction}\n`);
    }
    if (scenario.environment?.targetSetupMode === 'none') {
      stdout.write('2. Confirm that the opened target page is ready for evaluation.\n');
    }
    stdout.write(
      'Return to this terminal and press Enter when ready, or press Ctrl+C to cancel.\n',
    );
    const stoppedBy = await waitForEnterOrSigint();
    if (stoppedBy === 'sigint') {
      process.exitCode = 130;
      return;
    }

    const currentUrl = await session.sidePanelPage.evaluate(async (tabId) => {
      try {
        return (await chrome.tabs.get(tabId)).url ?? '';
      } catch {
        return '';
      }
    }, target.tabId);
    const report = await verifyConfiguredLiveEnvironment(
      runtime,
      scenario,
      { ...target, url: currentUrl },
      `live_setup_${randomUUID()}`,
    );
    for (const check of report.checks) {
      stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`);
    }
    if (!report.passed) {
      stdout.write(
        `Setup is incomplete; correct the failed checks, then run npm run e2e:live:verify -- ${sampleId}.\n`,
      );
      process.exitCode = 1;
    } else {
      stdout.write(
        `Environment is ready. Recheck it at any time with npm run e2e:live:verify -- ${sampleId}.\n`,
      );
    }
  } finally {
    await session?.close().catch(() => undefined);
    await lock.release();
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Live E2E setup failed: ${message}\n`);
  process.exitCode = 1;
});
