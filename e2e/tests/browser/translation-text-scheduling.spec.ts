import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'fills newly exposed text while the first translation is still pending',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_text_scheduling' },
      }),
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
    await context.route('http://translation-text-scheduling.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><style>body{margin:0;background:white;font:24px Arial}p{position:absolute;left:340px;width:480px;margin:0}#upper{top:300px}#lower{top:720px}</style><p id="upper">Upper paragraph.</p><p id="lower">Lower paragraph.</p>',
      }),
    );
    const requests: string[][] = [];
    let releaseFirst = () => {},
      firstReturned = false;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const request = route.request().postDataJSON() as {
        input: { content?: { type: string; text?: string }[] }[];
      };
      const text = request.input
        .flatMap((i) => i.content ?? [])
        .find((c) => c.type === 'input_text')?.text;
      const texts = JSON.parse(text ?? '{}').texts as { id: string; text: string }[];
      requests.push(texts.map((t) => t.text));
      const first = requests.length === 1;
      if (first) await held;
      const events = [
        { type: 'response.created', response: { id: first ? 'first' : 'second' } },
        {
          type: 'response.output_text.delta',
          delta: JSON.stringify({
            blocks: texts.map((t) => ({
              id: t.id,
              translation: t.text === 'Upper paragraph.' ? '上方的段落。' : '下方的段落。',
            })),
          }),
        },
        { type: 'response.completed', response: { id: first ? 'first' : 'second' } },
      ];
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
      if (first) firstReturned = true;
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.goto('http://translation-text-scheduling.test/');
    await page.bringToFront();
    const tabId = await panel.evaluate(
      async () =>
        (await chrome.tabs.query({ url: 'http://translation-text-scheduling.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Fixture tab missing');
    const readText = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll('.text') ?? [])].map((n) => n.textContent).join('');
          },
        });
        return result?.result;
      }, tabId);
    const lens = page.locator('[data-chatbrowserx-overlay=translation]');
    try {
      await sendExtensionMessage(panel, {
        version: 1,
        requestId: 'toggle',
        type: 'translation.toggle',
        payload: { tabId },
      });
      await page.mouse.move(600, 500);
      await expect.poll(() => requests.length).toBe(1);
      expect(requests).toEqual([['Upper paragraph.']]);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -300);
      await page.keyboard.up('Control');
      await expect.poll(() => requests.length).toBe(2);
      await expect.poll(readText).toContain('下方的段落。');
      expect(await readText()).not.toContain('上方的段落。');
      expect(firstReturned).toBe(false);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      await expect(lens).toHaveAttribute('data-status', 'loading');
      await page.screenshot({ path: testInfo.outputPath('new-text-before-old.png') });
      releaseFirst();
      await expect(lens).toHaveAttribute('data-status', 'ready');
      expect(await readText()).toContain('上方的段落。');
      for (const x of [620, 580, 610]) await page.mouse.move(x, 500);
      await page.waitForTimeout(1200);
      expect(requests).toEqual([['Upper paragraph.'], ['Lower paragraph.']]);
      await testInfo.attach('text-batches', {
        contentType: 'application/json',
        body: JSON.stringify({
          requests,
          newTextFinishedBeforeOld: true,
          scrollY: await page.evaluate(() => scrollY),
        }),
      });
    } finally {
      releaseFirst();
      await page.keyboard.press('Escape');
    }
  },
);
