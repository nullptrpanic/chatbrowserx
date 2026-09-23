import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

for (const effect of [
  'transform:rotate(180deg)',
  'filter:brightness(.6)',
  'mix-blend-mode:multiply',
])
  extensionTest(
    `keeps a safe copied ${effect} decoration from rejecting its own text flow`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<style>
      .list{margin:120px 60px;width:600px;font:18px/30px Arial}
      .row{display:flex;align-items:center;height:30px;gap:12px}
      i{position:relative;display:inline-block;width:18px;height:24px;line-height:24px;color:red;font-style:normal;${effect}}
      a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    </style><section class="list"><div class="row"><i>↑</i><a href="#one">普通标题</a></div><div class="row"><i>•</i><a href="#two">另一条新闻</a></div></section>`,
        {
          普通标题: 'An ordinary headline in a readable news list',
          另一条新闻: 'Another news headline',
        },
      );
      const original = await f.page.locator('.list').innerHTML();
      const native = await f.page.screenshot({ clip: { x: 60, y: 120, width: 18, height: 30 } });
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((row) => row.text))
        .toContain('An ordinary headline in a readable news list');
      expect((await f.read()).map((row) => row.text)).toContain('Another news headline');
      expect((await f.read()).find((row) => row.text.startsWith('An ordinary'))?.font).toBe(18);
      expect(await f.page.screenshot({ clip: { x: 60, y: 120, width: 18, height: 30 } })).toEqual(
        native,
      );
      expect(await f.page.locator('.list').innerHTML()).toBe(original);
    },
  );
