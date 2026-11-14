import { extensionTest, expect } from './fixtures/extension-test';
import { codexFixtureEvents } from './helpers/codex-fixture';
import { sendExtensionMessage } from './helpers/extension-runtime';

const url = 'https://translation-selection.test/';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

extensionTest(
  'translates just the selection and dismisses the bubble on an outside click',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    await extensionSession.serviceWorker.evaluate(() =>
      chrome.contextMenus.update('translate-selection', {}),
    );
    const token = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'selection-test' } }),
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
        accessToken: `e30.${token}.`,
      },
    });
    await context.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8">
        <style>body{margin:80px;font:20px/1.6 Arial}p{margin:0 0 32px}</style>
        <p>Unselected words. <span id="source">Keep this sentence.</span> Other words.</p>
        <button id="outside" style="margin-top:140px" onclick="this.textContent='Clicked'">Outside</button>`,
      }),
    );
    const inputs: unknown[] = [];
    const firstReply = gate();
    const secondReply = gate();
    const secondResponded = gate();
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const body = route.request().postDataJSON() as {
        input: { content: { text: string }[] }[];
      };
      const input = body.input[0]?.content[0]?.text;
      if (typeof input !== 'string') throw new Error('Missing translation input');
      inputs.push(JSON.parse(input));
      const index = inputs.length;
      await (index === 1 ? firstReply.promise : secondReply.promise);
      const events = codexFixtureEvents([
        { type: 'response.created', response: { id: `selection-${index}` } },
        { type: 'response.output_text.delta', delta: '记住这句话。' },
        { type: 'response.completed', response: { id: `selection-${index}` } },
      ]);
      await route
        .fulfill({
          contentType: 'text/event-stream',
          body: events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
        })
        .catch(() => undefined);
      if (index === 2) secondResponded.resolve();
    });

    const page = await context.newPage();
    await page.goto(url);
    await page.bringToFront();
    const tabId = await panel.evaluate(
      async (target) => (await chrome.tabs.query({ url: target }))[0]?.id,
      url,
    );
    if (tabId === undefined) throw new Error('Missing target tab');
    const host = page.locator('[data-chatbrowserx-overlay="selection"]');
    const source = page.locator('#source');
    const outside = page.locator('#outside');
    // Playwright cannot select the native menu item. Open the production page command
    // through the extension after selecting text in Chrome.
    const translate = async () => {
      await source.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      });
      await sendExtensionMessage(panel, {
        version: 1,
        requestId: 'install-page',
        type: 'page.features.ensure',
        payload: { tabId },
      });
      await panel.evaluate(
        async ({ targetTab, targetUrl }) => {
          const response = await chrome.tabs.sendMessage(
            targetTab,
            {
              version: 1,
              requestId: 'selection-test',
              type: 'page.translation.selection.open',
              payload: {
                text: 'Keep this sentence.',
                url: targetUrl,
                title: '翻译选中文本',
                loadingText: '翻译中…',
                errorText: '翻译失败，请重试。',
                closeText: '关闭',
                tooLongText: '选中文本过长，请缩小选区后重试。',
              },
            },
            { frameId: 0 },
          );
          if (!response?.ok || !response.data?.opened)
            throw new Error('Selection bubble did not open');
        },
        { targetTab: tabId, targetUrl: url },
      );
    };
    const readBubble = () =>
      panel.evaluate(async (targetTab) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: targetTab },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay="selection"]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const bubble = root?.querySelector('[role="dialog"]');
            if (!bubble) return null;
            const { top, left } = bubble.getBoundingClientRect();
            return {
              text: bubble.textContent,
              busy: bubble.querySelector('[role="status"]')?.getAttribute('aria-busy'),
              top,
              left,
            };
          },
        });
        return result?.result as {
          text: string;
          busy: string | null;
          top: number;
          left: number;
        } | null;
      }, tabId);

    try {
      await translate();
      await expect.poll(readBubble).toMatchObject({ busy: 'true' });
      await expect.poll(() => inputs).toEqual([{ language: 'zh-CN', text: 'Keep this sentence.' }]);
      firstReply.resolve();
      await expect
        .poll(readBubble)
        .toMatchObject({ text: expect.stringContaining('记住这句话。') });
      const bubble = await readBubble();
      if (!bubble) throw new Error('Missing translation bubble');
      expect(bubble.top).toBeGreaterThan(
        await source.evaluate((element) => element.getBoundingClientRect().bottom),
      );
      await expect(source).toHaveText('Keep this sentence.');
      await page.screenshot({ path: testInfo.outputPath('selection-translation.png') });
      await page.mouse.click(bubble.left + 16, bubble.top + 16);
      await expect(host).toHaveCount(1);
      await outside.click();
      await expect(host).toHaveCount(0);
      await expect(outside).toHaveText('Clicked');

      await translate();
      await expect.poll(() => inputs.length).toBe(2);
      await outside.click();
      await expect(host).toHaveCount(0);
      secondReply.resolve();
      await secondResponded.promise;
      await expect(host).toHaveCount(0);
    } finally {
      firstReply.resolve();
      secondReply.resolve();
    }
  },
);
