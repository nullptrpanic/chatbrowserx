import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

for (const surface of ['iframe', 'tooltip'])
  extensionTest(
    `keeps a sliced document flow readable around an overlaid native ${surface}`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<style>
    .document{margin:120px 60px;width:700px;font:18px/26px Arial}
    .document>canvas{display:block;width:700px;height:60px}
    h2{margin:20px 0}table{width:100%;table-layout:fixed}td{border:1px solid #aaa;padding:8px}
    .toolbar{position:absolute;left:60px;top:205px;width:300px;height:30px;border:0;z-index:10;background:#ee44aa}
  </style><div class="document"><canvas></canvas><h2>模块划分</h2><p>稳定正文</p><table><tr><td>模块</td><td>职责</td></tr></table><canvas></canvas></div>${surface === 'iframe' ? '<iframe class="toolbar" title="Native toolbar" srcdoc="Native toolbar"></iframe>' : '<div class="toolbar" role="tooltip" style="transform:scale(.95);pointer-events:none">Native tooltip</div>'}`,
        {
          模块划分: 'Module breakdown',
          稳定正文: 'Stable paragraph below the toolbar',
          模块: 'Module',
          职责: 'Responsibility',
        },
      );
      const original = await f.page.locator('.document').innerHTML();
      const box = await f.page.locator('.toolbar').boundingBox();
      if (!box) throw new Error('Native foreground missing');
      const clip = { x: box.x + 8, y: box.y + 4, width: box.width - 16, height: box.height - 8 };
      const native = await f.page.screenshot({ clip });
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((row) => row.text))
        .toContain('Stable paragraph below the toolbar');
      expect((await f.read()).map((row) => row.text)).toContain('Responsibility');
      expect(await f.page.screenshot({ clip })).toEqual(native);
      const calls = f.requests.length;
      for (const factor of [1.25, 1]) {
        await f.panel.evaluate(({ tabId, factor }) => chrome.tabs.setZoom(tabId, factor), {
          tabId: f.tabId,
          factor,
        });
        await expect
          .poll(async () => (await f.read()).map((row) => row.text))
          .toContain('Stable paragraph below the toolbar');
        expect((await f.read()).map((row) => row.text)).toContain('Responsibility');
      }
      expect(f.requests.length).toBe(calls);
      expect(await f.page.locator('.document').innerHTML()).toBe(original);
    },
  );

extensionTest(
  'does not let clipped native geometry reject nearby static text',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
    .port{position:absolute;left:60.25px;top:60px;width:590.75px;height:24.5px;overflow:hidden}
    iframe{display:block;width:100%;height:170px;border:0}
    main{position:absolute;left:60.25px;top:120px;margin:0!important;width:590.75px!important;font:14px/20px Arial}
  </style><div class="port"><iframe title="Native media" srcdoc="Native controls"></iframe></div>
  <main><a href="#news">普通新闻</a></main>`,
      { 普通新闻: 'Ordinary news' },
    );
    const before = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Ordinary news');
    expect((await f.read()).find((r) => r.text === 'Ordinary news')?.font).toBe(14);
    expect(await f.page.locator('main').innerHTML()).toBe(before);
  },
);

for (const clipping of ['transform', 'unknown-shape'])
  extensionTest(
    `protects visible native pixels under ${clipping} clipping`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<style>
      .port{position:absolute;left:60px;top:60px;width:300px;height:40px;overflow:hidden;
        ${clipping === 'transform' ? 'transform:translateX(.25px)' : 'clip-path:circle(40%)'}}
      iframe{position:fixed;left:0;top:0;width:300px;height:200px;border:0;background:#ee44aa}
      main{position:absolute;left:60px;top:280px;margin:0!important;width:590px!important;font:14px/20px Arial}
    </style><div class="port"><iframe title="Native media" srcdoc="Native controls"></iframe></div>
    <main><a href="#news">普通新闻</a></main>`,
        { 普通新闻: 'Ordinary news' },
      );
      const clip = { x: 150, y: 70, width: 30, height: 20 };
      const original = await f.page.screenshot({ clip });
      await f.toggle();
      await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Ordinary news');
      expect(await f.page.screenshot({ clip })).toEqual(original);
    },
  );

for (const position of ['absolute', 'fixed'])
  extensionTest(
    `keeps ${position} native media protected when it escapes an ancestor's overflow clip`,
    async ({ extensionSession }, info) => {
      const f = await setup(
        extensionSession,
        `<style>
          .clipper{margin:60px;width:590px;height:24px;overflow:hidden}
          .clipper iframe{position:${position};left:60px;top:120px;width:590px;height:30px;border:0}
          main{position:absolute;top:120px;left:60px;margin:0!important;width:590px!important;font:14px/20px Arial;z-index:-1}
        </style><div class="clipper"><iframe title="Live media" srcdoc="Native controls"></iframe></div>
        <main><a href="#one">普通新闻</a></main>`,
        { 普通新闻: 'News' },
      );
      const visible = await f.page.evaluate(() => document.elementFromPoint(100, 130)?.tagName);
      expect(visible).toBe('IFRAME');
      const clip = { x: 60, y: 120, width: 590, height: 30 };
      const original = await f.page.screenshot({ clip });
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', /^(ready|unsupported)$/);
      // A fixed surface may have a foreground cutout rather than rejecting the
      // whole mirror. Check the protected pixels, not that internal strategy.
      expect(await f.page.screenshot({ clip })).toEqual(original);
      await f.page.screenshot({ path: info.outputPath(`${position}-native.png`) });
    },
  );
