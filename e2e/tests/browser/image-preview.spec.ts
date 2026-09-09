import { createServer } from 'node:http';
import { extensionTest, expect } from './fixtures/extension-test';
import { closeHttpFixtureServer } from './helpers/http-server';

const previewHost = '[data-chatbrowserx-overlay="image-preview"]';
const image = {
  name: 'preview.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=',
    'base64',
  ),
};

for (const switchTab of [false, true]) {
  extensionTest(
    switchTab
      ? 'previews on the current web page after the previously bound tab closes'
      : 'previews once across the top-level web page, not inside embedded frames',
    async ({ extensionSession }) => {
      const server = createServer((request, response) => {
        const title = request.url === '/next' ? 'Next preview page' : 'Original preview page';
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><title>${title}</title></head>
          <body><h1>${title}</h1>${request.url === '/child' ? '' : '<iframe src="/child"></iframe>'}</body>
          </html>`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('Fixture unavailable.');
        const origin = `http://127.0.0.1:${String(address.port)}`;
        const panel = extensionSession.sidePanelPage;
        await panel.locator('input[type="file"]').setInputFiles(image);
        await expect(panel.locator('.attachment-thumbnail')).toHaveCount(1);
        await expect(panel.locator('.attachment-thumbnail img')).toHaveJSProperty(
          'naturalWidth',
          1,
        );
        const original = await extensionSession.context.newPage();
        await original.goto(origin);
        const next = switchTab ? await extensionSession.context.newPage() : original;
        if (switchTab) await next.goto(`${origin}/next`);
        await original.bringToFront();
        await expect(panel.locator('.page-title')).toHaveText('Original preview page');

        if (switchTab) {
          await original.close();
          await next.bringToFront();
        }
        // Invoke the real panel handler without activating the fixture's standalone panel tab.
        await panel.locator('.attachment-preview-button').evaluate((button: HTMLButtonElement) => {
          button.click();
        });

        await expect(next.locator(previewHost)).toBeVisible();
        await expect(panel.locator('.image-preview-dialog')).toHaveCount(0);
        await expect(next.frameLocator('iframe').locator(previewHost)).toHaveCount(0);
        const bounds = await next.locator(previewHost).boundingBox();
        const viewport = await next.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(bounds).toEqual({ x: 0, y: 0, ...viewport });
        await next.keyboard.press('Escape');
        await expect(next.locator(previewHost)).toHaveCount(0);
      } finally {
        await closeHttpFixtureServer(server);
      }
    },
  );
}
