import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'translates DOM text without reading or translating adjacent images, including after reopen',
  async ({ extensionSession }, info) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_text_only' } }),
    ).toString('base64url');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'settings',
      type: 'settings.save',
      payload: {
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'zh-CN',
        codexAccessToken: `e30.${token}.`,
      },
    });
    const png = await panel.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 240;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.fillStyle = '#e1f5ed';
      ctx.fillRect(0, 0, 600, 240);
      ctx.fillStyle = 'black';
      ctx.font = '32px Arial';
      ctx.fillText('IMAGE TEXT MUST STAY UNCHANGED', 12, 100);
      return canvas.toDataURL();
    });
    let imageLoads = 0;
    await context.route('https://text-only-cdn.test/image.png', async (route) => {
      imageLoads++;
      const bytes = png.split(',')[1];
      if (!bytes) throw new Error('Image fixture missing');
      await route.fulfill({ contentType: 'image/png', body: Buffer.from(bytes, 'base64') });
    });
    await context.route('https://translation-text-only.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>body{margin:0;height:1600px;font:20px/28px Arial}p{position:absolute;left:440px;top:275px;margin:0}img{position:absolute;left:440px;top:340px;width:300px;height:120px}</style><p>Hello page text</p><img src="https://text-only-cdn.test/image.png" alt="Image text"><canvas style="position:absolute;left:750px;top:350px;width:60px;height:60px"></canvas>`,
      }),
    );
    const inputs: { type: string }[][] = [];
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const input = route.request().postDataJSON().input[0].content as {
        type: string;
        text?: string;
      }[];
      inputs.push(input);
      const payload = input.find((c) => c.type === 'input_text')?.text;
      const texts = payload?.startsWith('{') ? (JSON.parse(payload).texts ?? []) : [];
      const blocks = texts.map((t: { id: string }) => ({ id: t.id, translation: '网页文字' }));
      const events = [
        { type: 'response.created', response: { id: 'text_only' } },
        { type: 'response.output_text.delta', delta: JSON.stringify({ blocks }) },
        { type: 'response.completed', response: { id: 'text_only' } },
      ];
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('https://translation-text-only.test/');
    await page.waitForFunction(() => document.images[0]?.naturalWidth === 600);
    const original = await page.locator('img').screenshot();
    await page.bringToFront();
    await page.mouse.move(600, 400);
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'https://translation-text-only.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Target tab missing');
    // Playwright itself marks targets as attached. Observe the extension's own calls instead.
    await extensionSession.serviceWorker.evaluate(() => {
      const commands: string[] = [];
      Object.assign(globalThis, { textOnlyDebuggerCommands: commands });
      const original = chrome.debugger.sendCommand.bind(chrome.debugger);
      chrome.debugger.sendCommand = ((...args: Parameters<typeof original>) => {
        commands.push(args[1]);
        return original(...args);
      }) as typeof chrome.debugger.sendCommand;
    });
    const toggle = () =>
      sendExtensionMessage(panel, {
        version: 1,
        requestId: crypto.randomUUID(),
        type: 'translation.toggle',
        payload: { tabId },
      });
    const lens = page.locator('[data-chatbrowserx-overlay=translation]');
    await toggle();
    const read = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const shadow = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(shadow?.querySelectorAll('.text') ?? [])].map((n) => n.textContent);
          },
        });
        return result?.result;
      }, tabId);
    await expect.poll(read).toEqual(['网页文字']);
    await expect(lens).toHaveAttribute('data-status', 'ready');
    await page.waitForTimeout(1500); // Exceeds the retired image scheduler's 800 ms delay.
    expect(inputs).toHaveLength(1);
    expect(inputs.flat().every((c) => c.type === 'input_text')).toBe(true);
    expect(imageLoads).toBe(1);
    expect(await page.locator('img').screenshot()).toEqual(original);
    expect(
      await extensionSession.serviceWorker.evaluate(
        () =>
          (globalThis as unknown as { textOnlyDebuggerCommands: string[] })
            .textOnlyDebuggerCommands,
      ),
    ).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 20));
    await expect.poll(read).toEqual(['网页文字']);
    await page.keyboard.press('Escape');
    await expect(lens).toHaveCount(0);
    await toggle();
    await expect(lens).toHaveAttribute('data-status', 'ready');
    await expect.poll(read).toEqual(['网页文字']);
    await page.waitForTimeout(1500);
    expect(inputs).toHaveLength(1);
    expect(imageLoads).toBe(1);
    expect(
      await extensionSession.serviceWorker.evaluate(
        () =>
          (globalThis as unknown as { textOnlyDebuggerCommands: string[] })
            .textOnlyDebuggerCommands,
      ),
    ).toEqual([]);
    await page.screenshot({ path: info.outputPath('text-only.png') });
  },
);
