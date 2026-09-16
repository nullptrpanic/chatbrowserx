import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest.use({ extensionHeadless: true });

for (const mode of [
  'canvas',
  'video',
  'iframe',
  'animation',
  'fixed-gradient',
  'scale-down',
  'broken-image',
])
  extensionTest(
    `leaves ${mode} native without image translation or sharing while translating independent DOM text`,
    async ({ extensionSession }, testInfo) => {
      const { context, sidePanelPage: panel } = extensionSession;
      const token = Buffer.from(
        JSON.stringify({
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_unsupported' },
        }),
      ).toString('base64url');
      await sendExtensionMessage(panel, {
        version: 1,
        requestId: 'settings',
        type: 'settings.save',
        payload: {
          model: 'gpt-5.6-terra',
          reasoningEffort: 'medium',
          language: 'zh-CN',
          systemPrompt: '',
          codexAccessToken: `e30.${token}.`,
        },
      });
      const png = await panel.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 100;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, 200, 100);
        ctx.fillStyle = 'black';
        ctx.font = '20px Arial';
        ctx.fillText('Image text', 20, 40);
        return canvas.toDataURL();
      });
      const surface =
        mode === 'canvas' || mode === 'video'
          ? `<canvas ${mode === 'canvas' ? 'id="surface"' : 'hidden'} width="200" height="100"></canvas>${mode === 'video' ? '<video id="surface" autoplay muted playsinline></video>' : ''}
         <script>const c=document.querySelector('canvas'),ctx=c.getContext('2d');let n=0;function paint(){ctx.fillStyle='hsl('+(n++%360)+' 90% 55%)';ctx.fillRect(0,0,200,100);requestAnimationFrame(paint)}paint();${mode === 'video' ? "document.querySelector('video').srcObject=c.captureStream(30)" : ''}</script>`
          : mode === 'iframe'
            ? '<iframe id="surface" src="https://translation-frame.test/"></iframe>'
            : mode === 'scale-down'
              ? `<img id="surface" src="${png}" style="object-fit:scale-down">`
              : mode === 'broken-image'
                ? '<img id="surface" src="/unavailable.png">'
                : `<div id="surface" style="${mode === 'fixed-gradient' ? 'background:linear-gradient(white,pink);background-attachment:fixed' : 'animation:pulse 1s infinite'}">Unsupported content</div>`;
      await context.route('https://translation-frame.test/', (r) =>
        r.fulfill({ contentType: 'text/html', body: '<p>Embedded text</p>' }),
      );
      await context.route('https://translation-unsupported.test/unavailable.png', (r) =>
        r.fulfill({ status: 404, body: '' }),
      );
      await context.route('https://translation-unsupported.test/', (r) =>
        r.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><style>body{margin:0;background:white;font:20px Arial}p{position:absolute;left:370px;top:270px;margin:0}#good{position:absolute;left:370px;top:320px;width:200px;height:100px}#surface{position:absolute;left:620px;top:320px;width:200px;height:100px;border:0}@keyframes pulse{from{background:red}to{background:blue}}</style><p>Native text</p><img id="good" src="${png}">${surface}`,
        }),
      );
      let imageRequests = 0,
        textRequests = 0;
      await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
        const input = route.request().postDataJSON().input[0].content;
        const pixels = input.some((c: { type: string }) => c.type === 'input_image');
        if (pixels) imageRequests++;
        else textRequests++;
        const blocks = JSON.parse(input[0].text).texts.map((t: { id: string }) => ({
          id: t.id,
          translation: '网页文字',
        }));
        const events = [
          { type: 'response.created', response: { id: 'unsupported' } },
          { type: 'response.output_text.delta', delta: JSON.stringify({ blocks }) },
          { type: 'response.completed', response: { id: 'unsupported' } },
        ];
        await route.fulfill({
          contentType: 'text/event-stream',
          body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
        });
      });
      const page = await context.newPage();
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto('https://translation-unsupported.test/');
      await page.waitForFunction(
        () => (document.querySelector('#good') as HTMLImageElement).naturalWidth === 200,
      );
      await page.bringToFront();
      const tabId = await panel.evaluate(
        async () =>
          (await chrome.tabs.query({ url: 'https://translation-unsupported.test/' }))[0]?.id,
      );
      if (tabId === undefined) throw new Error('Fixture tab missing');
      // Observe the same isolated-world API boundary used by content scripts, without granting capture.
      await panel.evaluate(async (id) => {
        await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const state = { calls: 0 };
            Object.assign(globalThis, { translationCaptureProbe: state });
            navigator.mediaDevices.getDisplayMedia = async () => {
              state.calls++;
              throw new Error('Capture must not be requested');
            };
          },
        });
      }, tabId);
      const toggle = () =>
        sendExtensionMessage(panel, {
          version: 1,
          requestId: crypto.randomUUID(),
          type: 'translation.toggle',
          payload: { tabId },
        });
      const expectedStatus = ['animation', 'fixed-gradient'].includes(mode)
        ? 'unsupported'
        : 'ready';
      await toggle();
      const lens = page.locator('[data-chatbrowserx-overlay=translation]');
      await expect(lens).toHaveAttribute('data-status', expectedStatus);
      const read = () =>
        panel.evaluate(async (id) => {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: id },
            func: () => {
              const host = document.querySelector<HTMLElement>(
                '[data-chatbrowserx-overlay=translation]',
              );
              const root = host && chrome.dom.openOrClosedShadowRoot(host);
              return {
                texts: [...(root?.querySelectorAll('.text') ?? [])].map((e) => e.textContent),
                actionHidden: root?.querySelector<HTMLButtonElement>('button')?.hidden,
                notice: root?.querySelector('[role=status]')?.textContent,
                captureCalls: (
                  globalThis as unknown as { translationCaptureProbe: { calls: number } }
                ).translationCaptureProbe.calls,
              };
            },
          });
          return result?.result;
        }, tabId);
      const result = await read();
      expect(result?.texts).toEqual(['网页文字']);
      expect(result?.actionHidden).toBe(true);
      if (expectedStatus === 'unsupported') expect(result?.notice).toContain('暂不支持');
      expect(result?.captureCalls).toBe(0);
      await page.waitForTimeout(2500);
      expect(imageRequests).toBe(0);
      expect(textRequests).toBe(1);
      await page.locator('p').evaluate((p) => (p.textContent = 'Changed native text'));
      await expect.poll(() => textRequests).toBe(2);
      await expect(lens).toHaveAttribute('data-status', expectedStatus);
      expect(imageRequests).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`${mode}-unsupported.png`) });
      await page.keyboard.press('Escape');
      await expect(lens).toHaveCount(0);
      await toggle();
      await expect(lens).toHaveAttribute('data-status', expectedStatus);
      expect((await read())?.texts).toEqual(['网页文字']);
      await page.waitForTimeout(1200);
      expect(imageRequests).toBe(0);
      expect(textRequests).toBe(2);
      expect((await read())?.captureCalls).toBe(0);
      await page.keyboard.press('Escape');
    },
  );
