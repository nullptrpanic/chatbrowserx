import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'keeps a failed lens visible without passive captures and retries only on movement',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_translation_error' },
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
    await context.route('http://translation-error.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
    <style>body{margin:0;background:white;font:22px Arial}main{position:absolute;left:340px;top:300px}canvas{position:absolute;left:620px;top:250px}</style>
    <main>Static title</main><canvas width="200" height="200"></canvas>
    <script>const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='#ddd';ctx.fillRect(0,0,200,200);ctx.fillStyle='black';ctx.font='20px Arial';ctx.fillText('Image text',20,60);</script>`,
      }),
    );
    let textRequests = 0,
      imageRequests = 0;
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const request = route.request().postDataJSON() as {
        input: { content?: { type: string; text?: string }[] }[];
      };
      const contents = request.input.flatMap((i) => i.content ?? []);
      const pixels = contents.some((c) => c.type === 'input_image');
      let output: string;
      if (pixels) {
        imageRequests++;
        output =
          imageRequests === 1
            ? 'not JSON: private provider output'
            : JSON.stringify({
                blocks: [{ text: 'Image text', translation: '图片文字', box: [570, 230, 200, 50] }],
              });
      } else {
        textRequests++;
        const payload = JSON.parse(contents[0]?.text ?? '{}') as { texts: { id: string }[] };
        output = JSON.stringify({
          blocks: payload.texts.map((t) => ({ id: t.id, translation: '静态标题' })),
        });
      }
      const events = [
        { type: 'response.created', response: { id: 'translation' } },
        { type: 'response.output_text.delta', delta: output },
        { type: 'response.completed', response: { id: 'translation' } },
      ];
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('http://translation-error.test/');
    await page.bringToFront();
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'http://translation-error.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Fixture tab missing');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'toggle',
      type: 'translation.toggle',
      payload: { tabId },
    });
    await page.mouse.move(600, 400);
    const lens = page.locator('[data-chatbrowserx-overlay=translation]');
    await expect(lens).toHaveAttribute('data-status', 'error');
    const readOverlay = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return {
              notice: root?.querySelector('[role=status]')?.textContent,
              texts: [...(root?.querySelectorAll('.text') ?? [])].map((n) => n.textContent),
            };
          },
        });
        return result?.result;
      }, tabId);
    await expect.poll(async () => (await readOverlay())?.texts).toContain('静态标题');
    const failure = await readOverlay();
    expect(failure?.notice).toContain('pixels/TRANSLATION_RESPONSE_INVALID');
    expect(failure?.notice).not.toContain('private');
    // Allow the one capture already in flight to restore its overlays; no new loop may start.
    await page.waitForTimeout(1200);
    const visibility = await page.evaluate(
      () =>
        new Promise<{ hiddenFrames: number; states: string[] }>((resolve) => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          if (!host) throw new Error('Translation overlay missing');
          let hiddenFrames = 0;
          const states = new Set<string>();
          const started = performance.now();
          const sample = () => {
            if (getComputedStyle(host).visibility !== 'visible') hiddenFrames++;
            states.add(host.dataset.status ?? 'missing');
            if (performance.now() - started >= 3000) resolve({ hiddenFrames, states: [...states] });
            else requestAnimationFrame(sample);
          };
          sample();
        }),
    );
    expect(visibility).toEqual({ hiddenFrames: 0, states: ['error'] });
    expect(imageRequests).toBe(1);
    expect(textRequests).toBe(1);
    await testInfo.attach('failed-lens-observation', {
      body: JSON.stringify({ ...visibility, imageRequests, textRequests, error: failure?.notice }),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('failed-lens.png') });
    await page.mouse.move(610, 400);
    await expect(lens).toHaveAttribute('data-status', 'ready');
    expect(imageRequests).toBe(2);
    expect(textRequests).toBe(1);
    expect((await readOverlay())?.texts).toContain('图片文字');
    await page.keyboard.press('Escape');
    await expect(lens).toHaveCount(0);
  },
);
