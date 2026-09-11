import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest(
  'keeps the formal toolbar state in sync across translation, Escape, tab changes and reload',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_translation' } }),
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
    await panel.reload();
    await expect(panel.getByRole('button', { name: '区域翻译' })).toBeVisible();
    await context.route('http://translation-lifecycle.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><style>body{margin:0;background:#f4f6fa;font:20px Arial}main{position:absolute;left:calc(50% - 180px);top:calc(50% - 60px);width:360px;background:white;padding:20px;border-radius:16px}</style><main>Start a new project</main>',
      }),
    );
    let count = 0;
    let release: (() => void) | undefined;
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      count++;
      const request = route.request().postDataJSON() as {
        input: { content: { text: string }[] }[];
      };
      const texts = JSON.parse(request.input[0]?.content[0]?.text ?? '{}') as {
        texts: { id: string; text: string }[];
      };
      if (count === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const events = [
        { type: 'response.created', response: { id: `translation_${count}` } },
        {
          type: 'response.output_text.delta',
          delta: JSON.stringify({
            blocks: texts.texts.map((t) => ({
              id: t.id,
              translation: t.text === 'Start a new project' ? '开始一个新项目' : '查看您的更改',
            })),
          }),
        },
        { type: 'response.completed', response: { id: `translation_${count}` } },
      ];
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('http://translation-lifecycle.test/');
    await page.bringToFront();
    const id = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'http://translation-lifecycle.test/' }))[0]?.id,
    );
    if (id === undefined) throw new Error('Target page missing.');
    await expect(panel.getByTitle('translation-lifecycle.test', { exact: true })).toBeVisible();
    const getState = () =>
      sendExtensionMessage<{ active: boolean }>(panel, {
        version: 1,
        requestId: crypto.randomUUID(),
        type: 'translation.getState',
        payload: { tabId: id },
      });
    // The fixture hosts the side panel in an extension tab. Dispatch its actual button handler
    // without activating that test-only tab in place of the user's target page.
    const clickTranslation = async () => {
      const button = panel.locator('button[aria-pressed]');
      await expect(button).toBeEnabled();
      await button.evaluate((button) => (button as HTMLButtonElement).click());
    };
    const lens = page.locator('[data-chatbrowserx-overlay="translation"]');
    const readOverlay = () =>
      panel.evaluate(async (tabId) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay="translation"]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            if (!root) throw new Error('Translation overlay missing.');
            const frame = root.querySelector<HTMLElement>('.frame');
            const notice = root.querySelector<HTMLElement>('[role=status]');
            if (!frame || !notice) throw new Error('Translation controls missing.');
            return {
              frameLeft: frame.style.left,
              text: [...root.querySelectorAll<HTMLElement>('.text')].map((span) => ({
                text: span.textContent,
                left: span.style.left,
                top: span.style.top,
                font: span.style.fontSize,
              })),
              noticeHidden: notice.hidden,
            };
          },
        });
        return result?.result;
      }, id);
    try {
      await clickTranslation();
      await expect(panel.getByRole('button', { name: '关闭区域翻译' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(lens).toHaveAttribute('data-status', 'loading');
      await expect.poll(() => count).toBe(1);
      await page.screenshot({ path: testInfo.outputPath('translating.png') });
      // The capture is still useful after this movement. Do not cancel it or project its
      // response relative to the new cursor position instead of the original screenshot.
      await page.mouse.move(640, 400, { steps: 15 });
      release?.();
      await expect(lens).toHaveAttribute('data-status', 'ready');
      const before = await readOverlay();
      expect(before?.text).toHaveLength(1);
      const firstText = before?.text[0];
      if (!firstText) throw new Error('Translated text missing.');
      const source = await page.locator('main').evaluate((main) => {
        const r = document.createRange();
        r.selectNodeContents(main);
        const box = r.getBoundingClientRect();
        return { x: box.x, y: box.y };
      });
      expect(Number.parseFloat(firstText.left)).toBeCloseTo(source.x - 1, 1);
      expect(Number.parseFloat(firstText.top)).toBeCloseTo(source.y - 1, 1);
      for (const x of [650, 610, 570, 620]) {
        await page.mouse.move(x, 400, { steps: 12 });
        await expect(lens).toHaveAttribute('data-status', 'ready');
        const after = await readOverlay();
        expect(after?.text).toEqual(before?.text);
        expect(after?.noticeHidden).toBe(true);
      }
      expect((await readOverlay())?.frameLeft).not.toBe(before?.frameLeft);
      // Observe longer than the capture debounce to catch a hidden redundant request.
      const states = await page.evaluate(
        () =>
          new Promise<string[]>((resolve) => {
            const seen = new Set<string>();
            const started = performance.now();
            const observe = () => {
              seen.add(
                document.querySelector<HTMLElement>('[data-chatbrowserx-overlay="translation"]')
                  ?.dataset.status ?? 'missing',
              );
              if (performance.now() - started > 1000) resolve([...seen]);
              else requestAnimationFrame(observe);
            };
            observe();
          }),
      );
      expect(states).toEqual(['ready']);
      expect(count).toBe(1);
      await page.screenshot({ path: testInfo.outputPath('translated.png') });

      await page.locator('main').evaluate((main) => {
        main.textContent = 'Review your changes';
      });
      await expect.poll(() => count).toBe(2);
      await expect(lens).toHaveAttribute('data-status', 'ready');
      await page.keyboard.press('Escape');
      await expect(lens).toHaveCount(0);
      await expect(panel.getByRole('button', { name: '区域翻译' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(await getState()).toEqual({ active: false });

      await clickTranslation();
      await expect(lens).toHaveCount(1);
      const other = await context.newPage();
      await other.goto('http://translation-lifecycle.test/other');
      await other.bringToFront();
      // Like the production browser tools, Playwright enables focus emulation. Native tab state
      // must still close the lens even when document.hidden remains false.
      expect(await panel.evaluate(async (tabId) => (await chrome.tabs.get(tabId)).active, id)).toBe(
        false,
      );
      await expect(lens).toHaveCount(0);
      expect(await getState()).toEqual({ active: false });
      await page.bringToFront();
      await other.close();
      await clickTranslation();
      await expect(lens).toHaveCount(1);
      await page.reload();
      await expect(lens).toHaveCount(0);
      expect(await getState()).toEqual({ active: false });
      await clickTranslation();
      await expect(lens).toHaveCount(1);
      await clickTranslation();
      await expect(lens).toHaveCount(0);
      await expect(page.locator('main')).toHaveText('Start a new project');
    } finally {
      release?.();
    }
  },
);

extensionTest(
  'opens the lens when a page still has a pre-translation command listener',
  async ({ extensionSession }) => {
    const { context, sidePanelPage: panel } = extensionSession;
    await context.route('http://translation-legacy.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><main>Original page remains intact</main>',
      }),
    );
    const page = await context.newPage();
    await page.goto('http://translation-legacy.test/');
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'http://translation-legacy.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Fixture tab missing.');
    await panel.evaluate(async (id) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          // Previous builds responded to ping but did not implement page.translation.toggle.
          const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
            message,
            _sender,
            respond,
          ) => {
            respond(
              message.type === 'page.ping'
                ? { version: 1, requestId: message.requestId, ok: true, data: { installed: true } }
                : {
                    version: 1,
                    requestId: 'invalid',
                    ok: false,
                    error: {
                      code: 'INVALID_PAGE_COMMAND',
                      message: 'Page command format is invalid.',
                    },
                  },
            );
            return true;
          };
          chrome.runtime.onMessage.addListener(listener);
          Object.assign(globalThis, { __chatBrowserXPageCommandsV1__: { listener } });
        },
      });
    }, tabId);
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'translation_legacy_toggle',
      type: 'translation.toggle',
      payload: { tabId },
    });
    await expect(page.locator('[data-chatbrowserx-overlay="translation"]')).toHaveCount(1);
    await expect(page.locator('main')).toHaveText('Original page remains intact');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-chatbrowserx-overlay="translation"]')).toHaveCount(0);
  },
);

extensionTest(
  'translates one real viewport crop without tasks and closes on Escape / toggle',
  async ({ extensionSession }) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const tokenPayload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_translation_demo' },
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
        codexAccessToken: `e30.${tokenPayload}.`,
      },
    });
    await panel.setViewportSize({ width: 360, height: 800 });
    await panel.reload();
    await expect(panel.getByRole('button', { name: '区域翻译' })).toBeVisible();
    expect(await panel.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );

    const requests: Record<string, unknown>[] = [];
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      const events = [
        { type: 'response.created', response: { id: 'translation_demo' } },
        {
          type: 'response.output_text.delta',
          delta: JSON.stringify({
            blocks: [
              {
                text: 'Start a new project',
                translation: '开始一个新项目',
                box: [100, 100, 600, 100],
              },
            ],
          }),
        },
        { type: 'response.completed', response: { id: 'translation_demo' } },
      ];
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    await context.route('http://translation.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><main>Start a new project</main></body></html>',
      }),
    );
    const page = await context.newPage();
    await page.goto('http://translation.test/');
    await page.bringToFront();
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'http://translation.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Target tab missing.');
    const toggle = () =>
      sendExtensionMessage(panel, {
        version: 1,
        requestId: crypto.randomUUID(),
        type: 'translation.toggle',
        payload: { tabId },
      });
    await toggle();
    const lens = page.locator('[data-chatbrowserx-overlay="translation"]');
    await expect(lens).toHaveAttribute('data-status', 'ready', { timeout: 15000 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'gpt-5.6-terra',
      reasoning: { effort: 'medium' },
      store: false,
    });
    expect(requests[0]?.tools).toBeUndefined();
    const input = requests[0]?.input as {
      content: { type: string; image_url?: string; text?: string }[];
    }[];
    expect(input).toHaveLength(1);
    expect(input[0]?.content[0]?.text).toContain('zh-CN');
    expect(input[0]?.content[1]?.image_url).toMatch(/^data:image\/png;base64,/);
    await expect(page.locator('main')).toHaveText('Start a new project');
    const snapshot = await sendExtensionMessage<{ tasks: unknown[]; messages: unknown[] }>(panel, {
      version: 1,
      requestId: 'snapshot',
      type: 'panel.getSnapshot',
      payload: { tabId },
    });
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.messages).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(lens).toHaveCount(0);
    await toggle();
    await expect(lens).toHaveCount(1);
    await toggle();
    await expect(lens).toHaveCount(0);
  },
);
