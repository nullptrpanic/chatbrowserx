import { stdin, stdout } from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLiveProfileLock, resolveLiveProfilePath } from './live-profile';
import { createLoadedExtensionSession, type ExtensionSession } from './extension-session';
import { createPlaywrightLiveRuntime } from './run-live-scenario';
import { getLiveScenario } from './scenarios';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

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

async function findSetupTab(
  session: ExtensionSession,
  expectedOrigin: string,
  fallbackTabId: number,
): Promise<{ readonly tabId: number; readonly authenticatedOrigin: boolean }> {
  const tabs = await session.sidePanelPage.evaluate(async () =>
    (await chrome.tabs.query({})).flatMap((tab) =>
      typeof tab.id === 'number' && typeof tab.url === 'string'
        ? [{ id: tab.id, url: tab.url }]
        : [],
    ),
  );
  const authenticated = tabs.find((tab) => {
    try {
      return new URL(tab.url).origin === expectedOrigin;
    } catch {
      return false;
    }
  });
  if (authenticated !== undefined) {
    return { tabId: authenticated.id, authenticatedOrigin: true };
  }
  return {
    tabId: tabs.some(({ id }) => id === fallbackTabId) ? fallbackTabId : (tabs[0]?.id ?? 0),
    authenticatedOrigin: false,
  };
}

async function main(): Promise<void> {
  const scenario = getLiveScenario('lark-messenger-read');
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
    stdout.write('1. 在 ChatBrowserX 页面中通过正常设置界面配置 Codex Access Token。\n');
    stdout.write('2. 在飞书页面中完成登录，确认已进入 Messenger。\n');
    stdout.write('完成后回到终端按 Enter；按 Ctrl+C 取消。\n');
    const stoppedBy = await waitForEnterOrSigint();
    if (stoppedBy === 'sigint') {
      process.exitCode = 130;
      return;
    }

    const setupTab = await findSetupTab(session, scenario.expectedOrigin, target.tabId);
    let hasCodexToken = false;
    if (setupTab.tabId !== 0) {
      const snapshot = record(
        await runtime.send({
          version: 1,
          requestId: `live_setup_${String(Date.now())}`,
          type: 'panel.getSnapshot',
          payload: { tabId: setupTab.tabId },
        }),
      );
      hasCodexToken = record(snapshot?.settings)?.hasCodexToken === true;
    }
    stdout.write(`hasCodexToken: ${String(hasCodexToken)}\n`);
    stdout.write(`authenticatedOrigin: ${String(setupTab.authenticatedOrigin)}\n`);
    if (!hasCodexToken || !setupTab.authenticatedOrigin) {
      stdout.write('配置尚未就绪；请重新运行 pnpm e2e:live:setup 完成缺失项。\n');
      process.exitCode = 1;
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
