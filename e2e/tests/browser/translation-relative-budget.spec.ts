import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

for (const maxWidth of ['100%', '24em', 'calc(100% - 20px)', 'max-content', 'none'])
  extensionTest(
    `preserves the unit of a ${maxWidth} compact text budget`,
    async ({ extensionSession }) => {
      const translated =
        'A longer translated headline should use the available row before showing an ellipsis';
      const f = await setup(
        extensionSession,
        `<style>
      .list{margin:120px 60px;width:400px;font:16px/24px Arial}
      a{display:block;height:24px;max-width:${maxWidth};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    </style><section class="list"><a href="#news">这是一段包含较多文字的普通新闻标题应该按照所在行的可用宽度展示</a></section>`,
        {
          这是一段包含较多文字的普通新闻标题应该按照所在行的可用宽度展示: translated,
        },
      );
      const source = await f.page.locator('a').boundingBox();
      if (!source) throw new Error('Missing source label');
      const original = await f.page.locator('.list').innerHTML();
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).find((row) => row.text === translated)?.font)
        .toBe(16);
      const row = (await f.read()).find((row) => row.text === translated);
      if (!row) throw new Error('Missing translated label');
      const paintedWidth = row.paintedBox.right - row.paintedBox.left;
      expect(paintedWidth).toBeGreaterThan(source.width - 2);
      expect(paintedWidth).toBeLessThanOrEqual(source.width + 1);
      expect(await f.page.locator('.list').innerHTML()).toBe(original);
    },
  );
