import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest(
  'saves a free-text model, reloads it, and uses that exact ID in the provider request',
  async ({ extensionSession }) => {
    const { sidePanelPage: panel, context } = extensionSession;
    const payload = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_model_e2e' } }),
    ).toString('base64url');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'model_settings_setup',
      type: 'settings.save',
      payload: {
        reasoningEffort: 'low',
        systemPrompt: '',
        language: 'en',
        codexAccessToken: `e30.${payload}.`,
      },
    });
    await panel.reload();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await panel.getByRole('textbox', { name: 'Model', exact: true }).fill('custom/model:latest');
    await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(panel.getByText('Settings saved', { exact: true })).toBeVisible();
    await panel.reload();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: 'Model', exact: true })).toHaveValue(
      'custom/model:latest',
    );

    const requests: unknown[] = [];
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      requests.push(route.request().postDataJSON() as unknown);
      const events = [
        { type: 'response.created', response: { id: 'resp_model_e2e' } },
        { type: 'response.output_text.delta', delta: 'Model setting verified.' },
        { type: 'response.completed', response: { id: 'resp_model_e2e' } },
      ];
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
      });
    });
    const tabId = await panel.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
    if (tabId === undefined) throw new Error('Fixture tab unavailable.');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'model_request',
      type: 'chat.submit',
      payload: { tabId, text: 'Verify the model setting.', attachmentIds: [] },
    });
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toMatchObject({ model: 'custom/model:latest' });
  },
);

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
