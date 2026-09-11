import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

// Keep the real capture/compositor path, but isolate it from the user's physical mouse.
extensionTest.use({ extensionHeadless: true });

for (const mode of ['canvas', 'video', 'css', 'iframe'] as const)
  extensionTest(
    `isolates continuously painted ${mode} pixels while keeping static translations`,
    async ({ extensionSession }, testInfo) => {
      const { context, sidePanelPage: panel } = extensionSession;
      const token = Buffer.from(
        JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_dynamic' } }),
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
      const animation = `const animation=document.querySelector('#surface').animate([{backgroundColor:'#ff3300'},{backgroundColor:'#00ccff'}],{duration:9731,iterations:Infinity,fill:'both'});animation.pause();window.startDynamics=()=>animation.play();window.stopDynamics=()=>animation.pause();`;
      await context.route('http://translation-frame.test/', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><style>body{margin:0}#surface{width:330px;height:420px}</style><div id="surface">Changing iframe</div><script>${animation}addEventListener('message',e=>{if(e.data==='start')startDynamics();if(e.data==='stop')stopDynamics()});</script>`,
        }),
      );
      const surface =
        mode === 'canvas' || mode === 'video'
          ? `<canvas ${mode === 'canvas' ? 'id="surface"' : 'style="display:none"'} width="330" height="420"></canvas>${mode === 'video' ? '<video id="surface" autoplay muted playsinline></video>' : ''}<script>
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');let frame=0,n=0;
      function paint(){ctx.fillStyle='hsl('+((n++*17)%360)+' 90% 55%)';ctx.fillRect(0,0,330,420);ctx.fillStyle='black';ctx.fillText('Moving frame '+n,30,150);}
      paint();window.startDynamics=()=>{function tick(){paint();frame=requestAnimationFrame(tick)}tick()};window.stopDynamics=()=>cancelAnimationFrame(frame);
      ${mode === 'video' ? "const video=document.querySelector('video');video.srcObject=canvas.captureStream(30);window.videoReady=video.play();" : ''}
      </script>`
          : mode === 'css'
            ? `<div id="surface">Changing CSS</div><script>${animation}</script>`
            : `<iframe id="surface" src="http://translation-frame.test/"></iframe><script>window.startDynamics=()=>document.querySelector('iframe').contentWindow.postMessage('start','http://translation-frame.test');window.stopDynamics=()=>document.querySelector('iframe').contentWindow.postMessage('stop','http://translation-frame.test');</script>`;
      await context.route('http://translation-dynamic.test/', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html>
    <style>body{margin:0;background:white;font:22px Arial}main{position:absolute;left:330px;top:316px}#surface{position:absolute;left:600px;top:190px;width:330px;height:420px;border:0}</style>
    <main>Static title</main>${surface}`,
        }),
      );
      let requests = 0,
        textRequests = 0;
      const images: string[] = [];
      await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
        const request = route.request().postDataJSON() as {
          input: { content?: { type: string; image_url?: string; text?: string }[] }[];
        };
        const image = request.input
          .flatMap((item) => item.content ?? [])
          .find((item) => item.type === 'input_image')?.image_url;
        if (!image) {
          textRequests++;
          const payload = JSON.parse(request.input[0]?.content?.[0]?.text ?? '{}') as {
            texts: { id: string }[];
          };
          const events = [
            { type: 'response.created', response: { id: 'dynamic-dom' } },
            {
              type: 'response.output_text.delta',
              delta: JSON.stringify({
                blocks: payload.texts.map((t) => ({ id: t.id, translation: '静态标题' })),
              }),
            },
            { type: 'response.completed', response: { id: 'dynamic-dom' } },
          ];
          await route.fulfill({
            contentType: 'text/event-stream',
            body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
          });
          return;
        }
        requests++;
        images.push(image);
        const events = [
          { type: 'response.created', response: { id: `dynamic-${requests}` } },
          {
            type: 'response.output_text.delta',
            delta: JSON.stringify({
              blocks: [
                { text: 'Moving frame', translation: `画面${requests}`, box: [650, 300, 200, 50] },
              ],
            }),
          },
          { type: 'response.completed', response: { id: `dynamic-${requests}` } },
        ];
        await route.fulfill({
          contentType: 'text/event-stream',
          body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
        });
      });
      const page = await context.newPage();
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto('http://translation-dynamic.test/');
      await page.bringToFront();
      if (mode === 'video')
        await page.evaluate(() => (window as unknown as { videoReady: Promise<void> }).videoReady);
      const tabId = await panel.evaluate(
        async () => (await chrome.tabs.query({ url: 'http://translation-dynamic.test/' }))[0]?.id,
      );
      if (tabId === undefined) throw new Error('Fixture tab missing.');
      await sendExtensionMessage(panel, {
        version: 1,
        requestId: 'toggle',
        type: 'translation.toggle',
        payload: { tabId },
      });
      // Stay in the top frame: pointer events inside a cross-origin iframe do not bubble out.
      await page.mouse.move(580, 400);
      const lens = page.locator('[data-chatbrowserx-overlay=translation]');
      await expect(lens).toHaveAttribute('data-status', 'ready', { timeout: 15000 });
      expect(requests).toBe(1);
      expect(textRequests).toBe(1);
      const initialImage = images[0],
        initialImageBase64 = initialImage?.split(',')[1];
      if (!initialImage || !initialImageBase64) throw new Error('Missing initial provider image.');
      // The source image must not include the blue top edge of our own lens (CSS x=500,y=270).
      // Checking the actual provider input catches compositor races that DOM visibility misses.
      const cleanSource = await page.evaluate(async (url) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable.');
        ctx.drawImage(bitmap, 0, 0);
        const scale = bitmap.width / 660;
        const pixels = ctx.getImageData(230 * scale, 80 * scale, 10 * scale, 3 * scale).data;
        bitmap.close();
        return pixels.every((value) => value > 250);
      }, initialImage);
      await testInfo.attach('initial-provider-image', {
        body: Buffer.from(initialImageBase64, 'base64'),
        contentType: 'image/png',
      });
      expect(cleanSource).toBe(true);
      await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('[data-chatbrowserx-overlay=translation]');
        if (!host) throw new Error('Lens missing.');
        let start = 0;
        const durations: number[] = [];
        const observer = new MutationObserver(() => {
          if (host.style.visibility === 'hidden') start = performance.now();
          else if (start) {
            durations.push(performance.now() - start);
            start = 0;
          }
        });
        observer.observe(host, { attributes: true, attributeFilter: ['style'] });
        Object.assign(window, { probeDurations: durations });
        (window as unknown as { startDynamics(): void }).startDynamics();
      });
      // Observe many fresh frames, not just a single screenshot immediately after an update.
      await expect
        .poll(
          () =>
            page.evaluate(
              () => (window as unknown as { probeDurations: number[] }).probeDurations.length,
            ),
          { timeout: 15000 },
        )
        .toBeGreaterThanOrEqual(5);
      expect(requests).toBe(1);
      await expect(lens).toHaveAttribute('data-status', 'ready');
      await page.screenshot({ path: testInfo.outputPath(`continuous-${mode}.png`) });
      await page.mouse.move(580, 400);
      expect(requests).toBe(1);
      const durations = await page.evaluate(
        () => (window as unknown as { probeDurations: number[] }).probeDurations,
      );
      await testInfo.attach('passive-capture-cost', {
        body: JSON.stringify({
          mode,
          captures: durations.length,
          hiddenMilliseconds: durations,
          modelRequestsWhileChanging: requests,
        }),
        contentType: 'application/json',
      });
      await page.evaluate(() => (window as unknown as { stopDynamics(): void }).stopDynamics());
      await expect.poll(() => requests, { timeout: 15000 }).toBe(2);
      await expect(lens).toHaveAttribute('data-status', 'ready');
      await page.screenshot({ path: testInfo.outputPath(`settled-${mode}.png`) });
      await page.keyboard.press('Escape');
      await expect(lens).toHaveCount(0);
    },
  );
