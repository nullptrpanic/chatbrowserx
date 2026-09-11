import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({
    root: resolve('e2e/fixtures/translation-lens'),
    configFile: false,
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});
test.use({ viewport: { width: 1440, height: 834 } });

async function expectAligned(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          const translated = [...document.querySelectorAll<HTMLElement>('#translations span')].find(
            (node) => node.textContent === '开始一个新项目',
          );
          if (!canvas || !translated) return false;
          const rect = canvas.getBoundingClientRect();
          const scale = rect.width / 1100;
          const span = translated.getBoundingClientRect();
          const style = getComputedStyle(translated);
          const ctx = canvas.getContext('2d');
          if (!ctx) return false;
          // Independent source glyph geometry: the fixture draws this line at (64, 80), 28px.
          const sourceTop =
            rect.top +
            (80 - ctx.measureText('Start a new project').actualBoundingBoxAscent) * scale;
          const sourceLeft = rect.left + 64 * scale;
          const font = Number.parseFloat(style.fontSize);
          return (
            Math.abs(span.left + Number.parseFloat(style.paddingLeft) - sourceLeft) <
              3 * scale + 0.2 &&
            Math.abs(span.top + Number.parseFloat(style.paddingTop) - sourceTop) <
              3 * scale + 0.2 &&
            font <= 28 * scale &&
            font >= 19 * scale
          );
        }),
      { timeout: 2000 },
    )
    .toBe(true);
}

for (const width of [818, 430]) {
  test(`image translations track small text after resizing to ${width}px and back`, async ({
    page,
  }) => {
    let translationReads = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/translation.json')) translationReads++;
    });
    await page.goto(`${origin}/?preview`);
    await expectAligned(page);
    await page.setViewportSize({ width, height: 660 });
    await expectAligned(page);
    await page.setViewportSize({ width: 1440, height: 834 });
    await expectAligned(page);
    expect(translationReads).toBe(1);
  });
}

test('image translations follow page reflow without a window resize', async ({ page }) => {
  await page.goto(`${origin}/?preview`);
  await expectAligned(page);
  await page.locator('h1').evaluate((node) => {
    node.style.marginBottom = '130px';
  });
  await expectAligned(page);
});

test('scroll keeps the source aligned and Escape removes layout subscriptions', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/?preview`);
  await expectAligned(page);
  await page.evaluate(() => {
    document.body.style.minHeight = '2000px';
    window.scrollTo(0, 100);
  });
  await expectAligned(page);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 430, height: 660 });
  await expect(page.locator('#translations, #lens')).toHaveCount(0);
  await expect(page.locator('h1')).toHaveText('A lens for translated reading');
  expect(errors).toEqual([]);
});
