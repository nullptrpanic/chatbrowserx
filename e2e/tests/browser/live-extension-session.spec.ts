import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoadedExtensionSession } from '../../runner/extension-session';
import { sendExtensionMessage } from './helpers/extension-runtime';

function syntheticAccessToken(): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct_live_profile_smoke',
    },
  })}.`;
}

test('reuses extension storage from one dedicated persistent profile', async () => {
  const profilePath = await mkdtemp(join(tmpdir(), 'chatbrowserx-live-smoke-'));
  let firstSession: Awaited<ReturnType<typeof createLoadedExtensionSession>> | undefined;
  let secondSession: Awaited<ReturnType<typeof createLoadedExtensionSession>> | undefined;
  try {
    firstSession = await createLoadedExtensionSession({
      profilePath,
      removeProfileOnClose: false,
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
      headless: false,
    });
    await sendExtensionMessage(firstSession.sidePanelPage, {
      version: 1,
      requestId: 'live_smoke_settings',
      type: 'settings.save',
      payload: {
        reasoningEffort: 'low',
        systemPrompt: 'Use available browser tools.',
        language: 'en',
        historyMessageLimit: 50,
        codexAccessToken: syntheticAccessToken(),
      },
    });
    await firstSession.close();
    firstSession = undefined;

    secondSession = await createLoadedExtensionSession({
      profilePath,
      removeProfileOnClose: false,
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
      headless: false,
    });
    const tabs = await secondSession.sidePanelPage.evaluate(async () => chrome.tabs.query({}));
    const tabId = tabs.find((tab) => typeof tab.id === 'number')?.id;
    if (typeof tabId !== 'number') throw new Error('Persistent smoke tab unavailable.');
    const snapshot = await sendExtensionMessage<{
      readonly settings: { readonly hasCodexToken: boolean };
    }>(secondSession.sidePanelPage, {
      version: 1,
      requestId: 'live_smoke_snapshot',
      type: 'panel.getSnapshot',
      payload: { tabId },
    });

    expect(snapshot.settings.hasCodexToken).toBe(true);
  } finally {
    await firstSession?.close().catch(() => undefined);
    await secondSession?.close().catch(() => undefined);
    await rm(profilePath, { recursive: true, force: true });
  }
});
