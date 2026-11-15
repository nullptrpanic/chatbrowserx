import { codexFixtureEvents } from './helpers/codex-fixture';
import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

for (const reasoningEffort of ['low', 'max', 'ultra']) {
  extensionTest(
    `saves a free-text model with ${reasoningEffort} effort, reloads both, and sends them unchanged`,
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
          accessToken: `e30.${payload}.`,
        },
      });
      await panel.reload();
      await panel.getByRole('button', { name: 'Settings', exact: true }).click();
      const modelPicker = panel.getByRole('combobox', { name: 'Model', exact: true });
      await modelPicker.selectOption({ label: 'Custom model…' });
      await panel
        .getByRole('textbox', { name: 'Custom model', exact: true })
        .fill('custom/model:latest');
      await panel
        .getByRole('combobox', { name: 'Reasoning effort', exact: true })
        .selectOption(reasoningEffort);
      await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
      await expect(panel.getByText('Settings saved', { exact: true })).toBeVisible();
      await panel.reload();
      await panel.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(panel.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue(
        'custom/model:latest',
      );
      await expect(
        panel.getByRole('combobox', { name: 'Reasoning effort', exact: true }),
      ).toHaveValue(reasoningEffort);

      const requests: unknown[] = [];
      await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
        requests.push(route.request().postDataJSON() as unknown);
        const events = codexFixtureEvents([
          { type: 'response.created', response: { id: 'resp_model_e2e' } },
          { type: 'response.output_text.delta', delta: 'Model setting verified.' },
          { type: 'response.completed', response: { id: 'resp_model_e2e' } },
        ]);
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
      expect(requests[0]).toMatchObject({
        model: 'custom/model:latest',
        reasoning: { effort: reasoningEffort },
      });
    },
  );
}

extensionTest(
  'syncs Sandbox credentials immediately, on retry, and in the background',
  async ({ extensionSession }) => {
    const { sidePanelPage: panel, context, serviceWorker } = extensionSession;
    const authPath = '/fixture/auth.json';
    const token = `e30.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'acct_sync_e2e' })).toString('base64url')}.`;
    const reads: unknown[] = [];
    let syncAvailable = false;
    await context.route('https://sandbox.example.test/credentials/read', async (route) => {
      reads.push(route.request().postDataJSON() as unknown);
      await route.fulfill({
        status: syncAvailable ? 200 : 503,
        json: syncAvailable ? { value: token } : {},
      });
    });
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'sandbox_sync_settings_setup',
      type: 'settings.save',
      payload: {
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'en',
        accessToken: token,
        sandboxServer: 'https://sandbox.example.test',
        sandboxToken: 'fixture-sandbox-token',
        authPath,
      },
    });
    await panel.reload();
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    const select = panel.getByRole('combobox', { name: 'Model', exact: true });
    await expect(select.locator('option[value="gpt-5.6-terra"]')).toHaveCount(1);
    await expect(select.locator('option[value="gpt-5.6-terra"]')).toHaveText('gpt-5.6-terra');
    await panel.getByRole('radio', { name: 'Sync from Sandbox' }).check();
    await expect(panel.getByText(/Token sync failed/)).toBeVisible();
    expect(reads).toEqual([{ path: authPath, fieldPath: ['tokens', 'access_token'] }]);
    syncAvailable = true;
    await panel.getByRole('button', { name: 'Sync Token' }).click();
    await expect(panel.getByText('Token synced', { exact: true })).toBeVisible();
    expect(reads).toHaveLength(2);
    await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(panel.getByText('Settings saved', { exact: true })).toBeVisible();
    await expect(panel.getByText('Token synced', { exact: true })).toBeVisible();
    expect(reads).toHaveLength(2);

    const alarm = await serviceWorker.evaluate(() => chrome.alarms.get('task-recovery-scan'));
    expect(alarm?.periodInMinutes).toBe(1);
    syncAvailable = false;
    await panel.close();
    // Deliver the registered background event without waiting for a real minute.
    await serviceWorker.evaluate(() =>
      chrome.alarms.create('task-recovery-scan', { when: Date.now() + 50, periodInMinutes: 1 }),
    );
    await expect.poll(() => reads.length, { timeout: 10_000 }).toBe(3);
    const reopened = await context.newPage();
    await reopened.goto(panel.url());
    await reopened.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(reopened.getByText(/Token sync failed/)).toBeVisible();
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
