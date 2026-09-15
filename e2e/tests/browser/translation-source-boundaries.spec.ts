import type { Protocol } from 'devtools-protocol';
import { extensionTest, expect } from './fixtures/extension-test';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'loaded image resources exclude overlays while debugger screenshots do not',
  async ({ extensionSession }) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const page = await context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 100;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('Canvas missing');
      ctx.fillStyle = '#0000ff';
      ctx.fillRect(0, 0, 200, 100);
      const url = c.toDataURL();
      return url.slice(url.indexOf(',') + 1);
    });
    const imageUrl = 'https://translation-cdn.test/image.png';
    await context.route(imageUrl, (r) =>
      r.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }),
    );
    await context.route('https://translation-resources.test/', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<body style="margin:0"><img src="${imageUrl}"><div style="position:fixed;inset:0;background:red" data-chatbrowserx-overlay="translation"></div></body>`,
      }),
    );
    await page.goto('https://translation-resources.test/');
    await page.waitForFunction(() => document.images[0]?.naturalWidth === 200);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await panel.evaluate(
        async ({ imageUrl }) => {
          const tabId = (
            await chrome.tabs.query({
              url: 'https://translation-resources.test/',
            })
          )[0]?.id;
          if (tabId === undefined) throw new Error('Target tab missing');
          const target = { tabId };
          await chrome.debugger.attach(target, '1.3');
          try {
            await chrome.debugger.sendCommand(target, 'Page.enable');
            const { frameTree } = (await chrome.debugger.sendCommand(
              target,
              'Page.getResourceTree',
            )) as Protocol.Page.GetResourceTreeResponse;
            const source = frameTree.resources.find((r) => r.url === imageUrl);
            const resource = (await chrome.debugger.sendCommand(target, 'Page.getResourceContent', {
              frameId: frameTree.frame.id,
              url: imageUrl,
            })) as Protocol.Page.GetResourceContentResponse;
            const screenshot = (await chrome.debugger.sendCommand(
              target,
              'Page.captureScreenshot',
              { format: 'png', fromSurface: true },
            )) as Protocol.Page.CaptureScreenshotResponse;
            const bitmap = await createImageBitmap(
              await (await fetch(`data:image/png;base64,${screenshot.data}`)).blob(),
            );
            const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
            if (!ctx) throw new Error('Canvas missing');
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            return {
              source,
              resource,
              capturedPixel: [...ctx.getImageData(20, 20, 1, 1).data],
            };
          } finally {
            await chrome.debugger.detach(target);
          }
        },
        { imageUrl },
      );
      expect(result.source?.type).toBe('Image');
      expect(result.resource.base64Encoded).toBe(true);
      expect(result.resource.content).toBe(png);
      expect(result.capturedPixel).toEqual([255, 0, 0, 255]);
    }
  },
);
