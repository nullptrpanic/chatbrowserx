import { createServer } from 'node:http';
import { extensionTest, expect } from './fixtures/extension-test';
import { closeHttpFixtureServer } from './helpers/http-server';

const selector = '[data-chatbrowserx-overlay="screenshot"]';

for (const mode of ['viewport', 'region', 'cancel', 'resize'] as const) {
  extensionTest(
    `captures ${mode} on the current page after switching tabs, without broadcasting`,
    async ({ extensionSession }, testInfo) => {
      const server = createServer((request, response) => {
        const current = request.url !== '/old';
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html style="background:${current ? '#00aa66' : '#dd0000'}"><head><title>${current ? 'Current capture page' : 'Old capture page'}</title></head>
        <body><h1>Screenshot fixture</h1>${request.url === '/child' ? '' : '<iframe src="/child" style="position:absolute;top:450px"></iframe>'}</body></html>`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('Fixture unavailable.');
        const origin = `http://127.0.0.1:${String(address.port)}`;
        const { context, sidePanelPage: panel } = extensionSession;
        const old = await context.newPage();
        await old.goto(`${origin}/old`);
        const current = await context.newPage();
        await current.goto(origin);
        await current.evaluate(() => {
          const events: unknown[] = [];
          Object.assign(window, { screenshotEvents: events });
          for (const type of ['pointerdown', 'pointermove', 'pointerup', 'resize']) {
            window.addEventListener(
              type,
              (event) => {
                const pointer = event as PointerEvent;
                events.push({
                  type,
                  x: pointer.clientX,
                  y: pointer.clientY,
                  width: innerWidth,
                  height: innerHeight,
                  dpr: devicePixelRatio,
                });
              },
              true,
            );
          }
        });
        await extensionSession.serviceWorker.evaluate((pauseSelection) => {
          const selections: unknown[] = [];
          Object.assign(globalThis, { screenshotSelections: selections });
          const original = chrome.tabs.sendMessage.bind(chrome.tabs);
          chrome.tabs.sendMessage = (async (...args: Parameters<typeof original>) => {
            const result = await original(...args);
            if ((args[1] as { type?: string }).type === 'page.screenshot.select') {
              selections.push(result);
              // Hold only the transport acknowledgement, keeping the real user selection intact.
              if (pauseSelection)
                await new Promise<void>((resolve) => {
                  Object.assign(globalThis, { releaseScreenshotSelection: resolve });
                });
            }
            return result;
          }) as typeof chrome.tabs.sendMessage;
        }, mode === 'resize');
        await old.bringToFront();
        await expect(panel.locator('.page-title')).toHaveText('Old capture page');
        await old.close();
        await current.bringToFront();

        // Invoke real panel controls without focusing the standalone extension-tab fixture.
        await panel
          .locator('.screenshot-control > button')
          .evaluate((button: HTMLButtonElement) => button.click());
        await panel
          .locator('.screenshot-menu > button')
          .nth(mode === 'viewport' ? 1 : 0)
          .evaluate((button: HTMLButtonElement) => button.click());
        if (mode !== 'viewport') {
          await expect(current.locator(selector)).toBeVisible();
          await expect(current.frameLocator('iframe').locator(selector)).toHaveCount(0);
          if (mode === 'cancel') {
            await current.keyboard.press('Escape');
          } else {
            await current.mouse.move(100, 180);
            await current.mouse.down();
            await current.mouse.move(300, 300, { steps: 5 });
            await current.mouse.up();
            await current.keyboard.press('Tab');
            await current.keyboard.press('Tab');
            await current.keyboard.press('Enter');
          }
          await expect(current.locator(selector)).toHaveCount(0);
        }

        if (mode === 'resize') {
          await expect
            .poll(() =>
              extensionSession.serviceWorker.evaluate(
                () =>
                  typeof (globalThis as unknown as { releaseScreenshotSelection?: () => void })
                    .releaseScreenshotSelection,
              ),
            )
            .toBe('function');
          await current.setViewportSize({ width: 1400, height: 800 });
          await extensionSession.serviceWorker.evaluate(() =>
            (
              globalThis as unknown as { releaseScreenshotSelection: () => void }
            ).releaseScreenshotSelection(),
          );
          await expect(panel.locator('.screenshot-control > button')).toBeEnabled();
          await expect(panel.locator('.composer-error')).toBeVisible();
          await expect(panel.locator('.attachment-thumbnail')).toHaveCount(0);
          return;
        }

        await expect(panel.locator('.screenshot-control > button')).toBeEnabled();
        await expect(panel.locator('.composer-error')).toHaveCount(0);
        await expect(panel.locator('.attachment-thumbnail')).toHaveCount(mode === 'cancel' ? 0 : 1);
        if (mode !== 'cancel') {
          // Compare with Chrome's native capture after switching, not emulated DPR or old geometry.
          const reference = await extensionSession.serviceWorker.evaluate(async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab === undefined) throw new Error('Reference tab unavailable.');
            const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
            const image = await createImageBitmap(await (await fetch(data)).blob());
            try {
              return { width: image.width, height: image.height };
            } finally {
              image.close();
            }
          });
          const size = await current.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          }));
          const img = panel.locator('.attachment-thumbnail img');
          await testInfo.attach('screenshot-geometry', {
            contentType: 'application/json',
            body: JSON.stringify({
              reference,
              size,
              events: await current.evaluate(
                () => (window as unknown as { screenshotEvents: unknown[] }).screenshotEvents,
              ),
              selections: await extensionSession.serviceWorker.evaluate(
                () =>
                  (globalThis as unknown as { screenshotSelections: unknown[] })
                    .screenshotSelections,
              ),
              actual: await img.evaluate((el: HTMLImageElement) => ({
                width: el.naturalWidth,
                height: el.naturalHeight,
              })),
            }),
          });
          await expect(img).toHaveJSProperty(
            'naturalWidth',
            mode === 'region'
              ? Math.ceil((300 * reference.width) / size.width) -
                  Math.floor((100 * reference.width) / size.width)
              : reference.width,
          );
          await expect(img).toHaveJSProperty(
            'naturalHeight',
            mode === 'region'
              ? Math.ceil((300 * reference.height) / size.height) -
                  Math.floor((180 * reference.height) / size.height)
              : reference.height,
          );
          const pixel = await img.evaluate((image: HTMLImageElement) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            if (ctx === null) throw new Error('Canvas unavailable.');
            ctx.drawImage(image, 0, 0);
            return [...ctx.getImageData(0, 0, 1, 1).data];
          });
          expect(pixel).toEqual([0, 170, 102, 255]);
        }
      } finally {
        await closeHttpFixtureServer(server);
      }
    },
  );
}
