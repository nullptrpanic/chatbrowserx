import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'retains page translations across Escape and preserves native navigation links',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_reopen' } }),
    ).toString('base64url');
    const settings = {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      language: 'zh-CN',
      systemPrompt: '',
      codexAccessToken: `e30.${token}.`,
    } as const;
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'settings',
      type: 'settings.save',
      payload: settings,
    });
    await context.route('https://translation-reopen.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>
    body{margin:0;min-height:1600px;background:white;font:24px/32px Arial}
    nav,p{position:absolute;left:420px;top:300px;margin:0}p{top:400px}a{color:#0066cc;text-decoration:underline}
    </style><nav><a href="#home">Home</a> | <a href="#blog">Blog</a></nav><p>Read the page.</p>
    <script>window.clicks=[];document.querySelector('nav').addEventListener('click',e=>window.clicks.push({trusted:e.isTrusted,href:e.target.closest('a')?.getAttribute('href')}));</script>`,
      }),
    );
    const requests: { language: string; texts: { id: string; text: string }[] }[] = [];
    await context.route('https://chatgpt.com/backend-api/codex/responses', (route) => {
      const input = JSON.parse(route.request().postDataJSON().input[0].content[0].text);
      requests.push(input);
      const translations: Record<string, string> = {
        Home: input.language === 'ja' ? 'ホーム' : '首页',
        Blog: '博客',
        'Read the page.': '阅读页面。',
        'Changed text.': '变更后的文字。',
      };
      const blocks = input.texts.map((t: { id: string; text: string }) => ({
        id: t.id,
        translation: translations[t.text] ?? t.text,
      }));
      const events = [
        { type: 'response.created', response: { id: 'reopen' } },
        { type: 'response.output_text.delta', delta: JSON.stringify({ blocks }) },
        { type: 'response.completed', response: { id: 'reopen' } },
      ];
      return route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('https://translation-reopen.test/');
    await page.bringToFront();
    await page.mouse.move(600, 400);
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'https://translation-reopen.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Missing tab');
    const toggle = () =>
      sendExtensionMessage(panel, {
        version: 1,
        requestId: 'toggle',
        type: 'translation.toggle',
        payload: { tabId },
      });
    const lens = page.locator('[data-chatbrowserx-overlay="translation"]');
    const read = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay="translation"]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll<HTMLElement>('.text') ?? [])].map((t) => {
              const r = t.getBoundingClientRect();
              const style = getComputedStyle(t);
              const x = r.x + r.width / 2,
                y = r.y + r.height / 2;
              return {
                text: t.textContent,
                color: style.color,
                decoration: style.textDecorationLine,
                x,
                y,
                href: document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href'),
              };
            });
          },
        });
        return result?.result;
      }, tabId);
    await toggle();
    await expect(lens).toHaveAttribute('data-status', 'ready');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.texts.map((t) => t.text)).toEqual(['Home', 'Blog', 'Read the page.']);
    const initial = await read();
    for (const [text, href] of [
      ['首页', '#home'],
      ['博客', '#blog'],
    ]) {
      const link = initial?.find((t) => t.text === text);
      expect(link).toMatchObject({ color: 'rgb(0, 102, 204)', decoration: 'underline', href });
      if (!link) throw new Error('Missing translated link');
      await page.mouse.click(link.x, link.y);
    }
    expect(await page.evaluate('window.clicks')).toEqual([
      { trusted: true, href: '#home' },
      { trusted: true, href: '#blog' },
    ]);
    await page.screenshot({ path: testInfo.outputPath('translated-links.png') });
    for (const scroll of [20, 40, 0]) {
      await page.keyboard.press('Escape');
      await expect(lens).toHaveCount(0);
      await page.evaluate((y) => window.scrollTo(0, y), scroll);
      await toggle();
      await expect(lens).toHaveAttribute('data-status', 'ready');
      const current = await read();
      expect(current?.find((t) => t.text === '首页')?.href).toBe('#home');
      expect(current?.find((t) => t.text === '阅读页面。')?.y).toBeCloseTo(
        (initial?.find((t) => t.text === '阅读页面。')?.y ?? 0) - scroll,
        1,
      );
      expect(requests).toHaveLength(1);
    }
    await page.keyboard.press('Escape');
    await page.locator('p').evaluate((p) => {
      p.textContent = 'Changed text.';
    });
    await toggle();
    await expect(lens).toHaveAttribute('data-status', 'ready');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.texts.map((t) => t.text)).toEqual(['Changed text.']);
    expect((await read())?.map((t) => t.text)).toContain('变更后的文字。');
    await page.keyboard.press('Escape');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'language',
      type: 'settings.save',
      payload: { ...settings, language: 'ja' },
    });
    await toggle();
    await expect(lens).toHaveAttribute('data-status', 'ready');
    expect(requests).toHaveLength(3);
    expect(requests[2]?.language).toBe('ja');
    expect((await read())?.map((t) => t.text)).toContain('ホーム');
    await page.keyboard.press('Escape');
  },
);
