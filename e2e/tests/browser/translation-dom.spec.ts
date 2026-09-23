import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

// Native desktop mouse events must not move the measured lens during deterministic assertions.
extensionTest.use({ extensionHeadless: true });

extensionTest(
  'translates full HTML blocks without screenshot flicker and reuses them across movement and scroll',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_dom' } }),
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
    const paragraph =
      'The practical takeaway is that safety tuning should not be assessed by refusal rate alone. ' +
      'A model that refuses more is not automatically safer. Both sides of the intended boundary must be evaluated for the numbers to mean anything.';
    await context.route('http://translation-dom.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>body{margin:0;background:rgb(240,240,240);font:20px/32px Georgia}article{position:absolute;left:320px;top:260px;width:820px;background:rgba(255,255,255,.5)}h2{background:rgba(18,18,18,.04)}p{margin:20px 0;background:oklab(0.606 0.096545 -0.230606 / .1)}footer{height:1800px}input{position:absolute;top:300px;left:1100px}</style>
    <article><h2>Minify!</h2><p>${paragraph.replace('Both sides', '<a href="#details">Both sides</a>')}</p><p hidden>PRIVATE HIDDEN TEXT</p></article><input value="PRIVATE EDITOR TEXT"><footer></footer>`,
      }),
    );
    const requests: { input: { content?: { type: string; text?: string }[] }[] }[] = [];
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const input = request.input[0]?.content[0]?.text;
      const texts: { id: string; text: string }[] = input?.startsWith('{')
        ? JSON.parse(input).texts
        : [];
      const blocks = texts.map((t) => ({
        id: t.id,
        translation: t.text.startsWith('The practical')
          ? '实际的要点是，安全调优不应只按拒绝率评估。拒绝更多请求的模型并不自动意味着更加安全。必须评估<m0>预期边界的两侧</m0>，这些数字才有意义。'
          : t.text === 'Changed paragraph.'
            ? '已更新的段落。'
            : '压缩代码!',
      }));
      const events = [
        { type: 'response.created', response: { id: 'dom' } },
        { type: 'response.output_text.delta', delta: JSON.stringify({ blocks }) },
        { type: 'response.completed', response: { id: 'dom' } },
      ];
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('http://translation-dom.test/');
    await page.bringToFront();
    // Place the browser cursor before enabling the lens, not while its first batch is starting.
    await page.mouse.move(600, 400);
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      let hides = 0;
      Object.assign(window, { translationHides: 0 });
      new MutationObserver((records) => {
        for (const record of records) {
          const el = record.target as HTMLElement;
          if (el.dataset?.chatbrowserxOverlay === 'translation' && el.style.visibility === 'hidden')
            hides++;
        }
        Object.assign(window, { translationHides: hides });
      }).observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
      });
    });
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'http://translation-dom.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Target missing');
    const lens = page.locator('[data-chatbrowserx-overlay="translation"]');
    const readText = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay="translation"]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll<HTMLElement>('.text') ?? [])].map((t) => ({
              text: t.textContent,
              // Measure the rendered position, including the source layer's scroll transform.
              top: t.getBoundingClientRect().top,
              left: t.getBoundingClientRect().left,
              fontSize: t.style.fontSize,
              background: t.parentElement && getComputedStyle(t.parentElement).backgroundColor,
              articleBackground: getComputedStyle(t.closest('article') ?? t).backgroundColor,
              backdrop: t.closest<HTMLElement>('.translation-group')?.style.background,
            }));
          },
        });
        return result?.result;
      }, tabId);
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'toggle',
      type: 'translation.toggle',
      payload: { tabId },
    });
    await page.mouse.move(601, 400);
    await expect(lens).toHaveAttribute('data-status', 'ready', { timeout: 10000 });
    expect(requests).toHaveLength(1);
    expect(
      requests[0]?.input.flatMap((i) => i.content ?? []).some((c) => c.type === 'input_image'),
    ).toBe(false);
    const sent = JSON.stringify(requests[0]);
    expect(sent.replace(/<\/?m\d+>/g, '')).toContain(paragraph);
    expect(sent).not.toContain('PRIVATE');
    const before = await readText();
    const titleFont = await page.locator('h2').evaluate((h) => getComputedStyle(h).fontSize);
    expect(before?.find((line) => line.text === '压缩代码!')?.fontSize).toBe(titleFont);
    expect(before?.every((line) => line.text?.trim())).toBe(true);
    expect(before?.map((t) => t.text).join('')).toContain('必须评估预期边界的两侧');
    const expectedBackgrounds = await page.evaluate(() =>
      ['h2', 'article p', 'article', 'body'].map(
        (selector) =>
          getComputedStyle(document.querySelector(selector) ?? document.body).backgroundColor,
      ),
    );
    expect(before?.map((line) => line.background)).toEqual([
      expectedBackgrounds[0],
      ...Array((before?.length ?? 1) - 1).fill(expectedBackgrounds[1]),
    ]);
    expect(before?.every((line) => line.articleBackground === expectedBackgrounds[2])).toBe(true);
    expect(
      before?.every((line) =>
        line.backdrop?.includes(expectedBackgrounds[3] ?? 'missing-background'),
      ),
    ).toBe(true);
    expect(await page.locator('article p').first().textContent()).toBe(paragraph);
    for (const x of [620, 580, 650]) {
      await page.mouse.move(x, 400);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(2200);
    expect(requests).toHaveLength(1);
    expect(
      await page.evaluate(
        () => (window as unknown as { translationHides: number }).translationHides,
      ),
    ).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('translated.png') });
    await page.mouse.move(650, 400);
    await page.evaluate(() => window.scrollBy(0, 40));
    await expect(lens).toHaveAttribute('data-status', 'ready');
    await expect
      .poll(async () => {
        const after = await readText();
        if (!after || !before || after.length !== before.length) return Infinity;
        return Math.max(...after.map((t, i) => Math.abs(t.top - (before[i]?.top ?? NaN) + 40)));
      })
      .toBeLessThan(0.05);
    expect(requests).toHaveLength(1);
    await page
      .locator('article p')
      .first()
      .evaluate((p) => {
        p.textContent = 'Changed paragraph.';
      });
    await page.waitForTimeout(350);
    expect(requests).toHaveLength(1);
    await page.keyboard.press('Alt+KeyR');
    await expect
      .poll(async () => (await readText())?.map((t) => t.text).join(''))
      .toContain('已更新的段落。');
    expect(requests).toHaveLength(2);
    await page.setViewportSize({ width: 2000, height: 1200 });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -1500);
    await page.keyboard.up('Control');
    const frameRect = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay="translation"]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return root?.querySelector('.frame')?.getBoundingClientRect().toJSON();
          },
        });
        return result?.result as
          { x: number; y: number; width: number; height: number } | undefined;
      }, tabId);
    await expect.poll(frameRect).toMatchObject({ x: 0, y: 0, width: 2000, height: 1200 });
    await expect(lens).toHaveAttribute('data-status', 'ready');
    expect(requests, 'expanding an already translated page must reuse its text').toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath('viewport-lens.png') });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 80);
    await page.keyboard.up('Control');
    await expect.poll(async () => (await frameRect())?.height).toBeLessThan(1200);
    await page.keyboard.press('Escape');
    await expect(lens).toHaveCount(0);
  },
);
