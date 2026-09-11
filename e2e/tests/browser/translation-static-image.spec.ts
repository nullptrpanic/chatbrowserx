import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'translates a static image without hiding the lens or sampling unchanged pixels',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_image' } }),
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
    await context.route('https://translation-static.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>body{margin:0;min-height:2000px;background:#f1f5fa}p{position:absolute;left:400px;top:220px}img{position:absolute;left:400px;top:300px;width:400px;height:200px}img+img{left:1000px}</style><p>Hello text</p><img alt="Test image"><script>
      const canvas=document.createElement('canvas');canvas.width=800;canvas.height=400;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,800,400);ctx.clearRect(0,0,40,40);ctx.fillStyle='black';ctx.font='40px Arial';ctx.fillText('IMAGE TEXT',80,100);const img=document.querySelector('img');img.src=canvas.toDataURL();img.after(img.cloneNode());
      window.hides=0;new MutationObserver(records=>{for(const r of records)if(r.target.dataset?.chatbrowserxOverlay==='translation'&&r.target.style.visibility==='hidden')window.hides++;}).observe(document.documentElement,{subtree:true,attributes:true,attributeFilter:['style']});
    </script>`,
      }),
    );
    let requests = 0,
      firstImage = '',
      textRequests = 0,
      textFinished = false;
    let startImage!: () => void;
    const imageStarted = new Promise<void>((resolve) => {
      startImage = resolve;
    });
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const input = route.request().postDataJSON().input[0].content;
      const image = input.find((c: { type: string }) => c.type === 'input_image');
      let blocks;
      if (image) {
        requests++;
        if (requests === 1) {
          expect(textRequests).toBe(1);
          expect(textFinished, 'image work must start without waiting for text completion').toBe(
            false,
          );
          firstImage = image.image_url;
          startImage();
        }
        blocks = [{ text: 'IMAGE TEXT', translation: '图片内容', box: [100, 150, 300, 100] }];
      } else {
        textRequests++;
        await imageStarted;
        blocks = JSON.parse(input[0].text).texts.map((t: { id: string }) => ({
          id: t.id,
          translation: '你好文字',
        }));
        textFinished = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const events = [
        { type: 'response.created', response: { id: 'image' } },
        {
          type: 'response.output_text.delta',
          delta: JSON.stringify({ blocks }),
        },
        { type: 'response.completed', response: { id: 'image' } },
      ];
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('https://translation-static.test/');
    await page.waitForFunction(
      () => document.images[0]?.complete && document.images[0].naturalWidth === 800,
    );
    await page.bringToFront();
    await page.mouse.move(600, 400);
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'https://translation-static.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Target missing');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'toggle',
      type: 'translation.toggle',
      payload: { tabId },
    });
    const lens = page.locator('[data-chatbrowserx-overlay="translation"]');
    await expect.poll(() => requests).toBe(1);
    // The first image response has not arrived yet: scrolling must retain and reposition it.
    await page.evaluate(() => window.scrollTo(0, 40));
    await expect(lens).toHaveAttribute('data-status', 'ready', { timeout: 15000 });
    const imageTextRect = () =>
      panel.evaluate(async (id) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay="translation"]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const text = [...(root?.querySelectorAll<HTMLElement>('.text') ?? [])].find(
              (e) => e.textContent === '图片内容' && e.getClientRects().length,
            );
            return text?.getBoundingClientRect().toJSON();
          },
        });
        return r?.result as { x: number; y: number; width: number; height: number } | undefined;
      }, tabId);
    const beforeScroll = await imageTextRect();
    if (!beforeScroll) throw new Error('Translated image text missing');
    expect(beforeScroll.y).toBeCloseTo(286.67, 0);
    const texts = await panel.evaluate(async (id) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay="translation"]',
          );
          return host && chrome.dom.openOrClosedShadowRoot(host)?.textContent;
        },
      });
      return r?.result;
    }, tabId);
    expect(texts).toContain('图片内容');
    expect(texts).toContain('你好文字');
    // Source transparency must preserve the page background, not invent a white rectangle.
    expect(
      await page.evaluate(async (url) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return [...ctx.getImageData(4, 4, 1, 1).data];
      }, firstImage),
    ).toEqual([241, 245, 250, 255]);
    for (const x of [610, 590, 620]) {
      await page.mouse.move(x, 400);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(3500);
    expect(requests).toBe(1);
    expect(await page.evaluate('window.hides')).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 80));
    await expect(lens).toHaveAttribute('data-status', 'ready');
    await page.waitForTimeout(2500);
    expect(requests, 'scrolling unchanged source pixels must not translate them again').toBe(1);
    const afterScroll = await imageTextRect();
    expect(afterScroll?.y).toBeCloseTo(246.67, 0);
    expect(afterScroll?.height).toBeCloseTo(beforeScroll.height, 1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('static-image.png') });
    // Enter a new source region, then return. A new neighbor must not invalidate the first image.
    await page.mouse.move(1000, 400);
    await expect.poll(() => requests).toBe(2);
    await expect(lens).toHaveAttribute('data-status', 'ready');
    await page.mouse.move(600, 400);
    await expect(lens).toHaveAttribute('data-status', 'ready');
    await page.waitForTimeout(3500);
    expect(requests).toBe(2);
    expect(await page.evaluate('window.hides')).toBe(0);
    // Reloading an unrelated image must not invalidate this image's translation.
    await page.evaluate(() => {
      const image = document.images[1];
      if (!image) throw new Error('Neighbor image missing');
      image.dispatchEvent(new Event('load'));
    });
    await page.waitForTimeout(2000);
    expect(requests).toBe(2);
    // A real source change is different from geometry changes and must retranslate.
    for (const scroll of [20, 40, 0]) {
      await page.keyboard.press('Escape');
      await expect(lens).toHaveCount(0);
      await page.evaluate((y) => window.scrollTo(0, y), scroll);
      await sendExtensionMessage(panel, {
        version: 1,
        requestId: 'reopen',
        type: 'translation.toggle',
        payload: { tabId },
      });
      await expect(lens).toHaveAttribute('data-status', 'ready');
      expect((await imageTextRect())?.y).toBeCloseTo(326.67 - scroll, 0);
      expect(requests, 'reopening unchanged static pixels must reuse translation').toBe(2);
      expect(textRequests).toBe(1);
      expect(await page.evaluate('window.hides')).toBe(0);
    }
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 800;
      canvas.height = 400;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas missing');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 800, 400);
      ctx.fillStyle = 'black';
      ctx.font = '40px Arial';
      ctx.fillText('CHANGED IMAGE', 80, 100);
      const image = document.images[0];
      if (!image) throw new Error('Source image missing');
      image.src = canvas.toDataURL();
    });
    await expect.poll(() => requests).toBe(3);
    await expect(lens).toHaveAttribute('data-status', 'ready');
    await page.keyboard.press('Escape');
    await expect(lens).toHaveCount(0);
  },
);
