import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest(
  'loads the real production MV3 worker and Side Panel document',
  async ({ extensionSession }) => {
    const { extensionId, serviceWorker, sidePanelPage } = extensionSession;

    expect(serviceWorker.url()).toContain(`chrome-extension://${extensionId}/`);
    expect(sidePanelPage.url()).toContain(`chrome-extension://${extensionId}/`);
    await expect(sidePanelPage.getByLabel('ChatBrowserX').first()).toBeVisible();

    await expect(
      sendExtensionMessage<{ readonly connected: boolean }>(sidePanelPage, {
        version: 1,
        requestId: 'e2e_shell_ping',
        type: 'system.ping',
        payload: {},
      }),
    ).resolves.toEqual({ connected: true });
  },
);
