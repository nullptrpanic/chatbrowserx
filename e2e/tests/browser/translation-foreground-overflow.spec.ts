import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

for (const position of ['relative', 'fixed'])
  extensionTest(
    `preserves an overflowing search surface inside a ${position} stacking owner`,
    async ({ extensionSession }, info) => {
      const f = await setup(
        extensionSession,
        `<style>
          header{position:${position};z-index:10;top:40px;left:60px;width:800px;height:80px;background:white}
          .popup{position:absolute;left:180px;top:50px;width:400px;height:280px;background:#e3f4ea;border:2px solid #246}
          .popup input{margin:12px;width:320px;height:30px}
          main{position:absolute;top:220px;left:60px;margin:0!important;width:800px!important}
          p{background:#fff;line-height:40px;white-space:nowrap}
          .footer{position:absolute;top:650px;left:60px}
        </style><header><div class="popup"><input value="untouched draft"></div></header>
        <main><p>下面的新闻一</p><p>下面的新闻二</p><p>下面的新闻三</p><canvas width="800" height="40"></canvas></main>
        <p class="footer">弹层外的静态内容</p>`,
        {
          下面的新闻一: 'First underlying news title that crosses the popup rectangle',
          下面的新闻二: 'Second underlying news title that crosses the popup rectangle',
          下面的新闻三: 'Third underlying news title that crosses the popup rectangle',
          弹层外的静态内容: 'Static content outside the popup',
        },
      );
      const box = await f.page.locator('.popup').boundingBox();
      if (!box) throw new Error('Popup missing');
      const clip = { x: box.x + 4, y: 220, width: box.width - 8, height: 110 };
      const native = await f.page.screenshot({ clip });
      // Playwright temporarily hides input carets for a screenshot and leaves an
      // empty style attribute. Capture source identity after that native baseline.
      const before = await f.page.locator('header').innerHTML();
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Static content outside the popup');
      await f.page.screenshot({ path: info.outputPath(`${position}-popup.png`) });
      expect(await f.page.screenshot({ clip })).toEqual(native);
      expect(await f.page.locator('input').inputValue()).toBe('untouched draft');
      expect(await f.page.locator('header').innerHTML()).toBe(before);
      await f.page.keyboard.press('Escape');
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Static content outside the popup');
      expect(await f.page.screenshot({ clip })).toEqual(native);
      await f.page.locator('header').evaluate((el) => {
        el.setAttribute('hidden', '');
      });
      await expect.poll(async () => (await f.page.screenshot({ clip })).equals(native)).toBe(false);
      expect((await f.read()).some((r) => r.text?.startsWith('First underlying'))).toBe(true);
    },
  );
