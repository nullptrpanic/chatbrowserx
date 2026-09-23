import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'preserves inline badge alignment while constraining a translated headline',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
      .row{margin:120px 60px;width:400px;font:18px/36px Arial}
      a{display:block;height:36px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .label{display:inline-block;max-width:320px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
      .badge{display:inline-block;font:12px/16px Arial;vertical-align:middle;background:#f60;color:white}
    </style><section class="row"><a href="#news"><span class="label">普通新闻标题</span> <i class="badge">热</i></a></section>`,
      {
        普通新闻标题: 'A longer translated headline in a compact row',
        热: 'Hot',
      },
    );
    const source = await f.page.locator('.badge').boundingBox();
    if (!source) throw new Error('Missing source badge');
    const original = await f.page.locator('.row').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).some((row) => row.text === 'Hot')).toBe(true);
    const badge = (await f.read()).find((row) => row.text === 'Hot');
    expect(badge?.ownerBox?.y).toBeCloseTo(source.y, 0);
    expect(badge?.font).toBe(12);
    expect(await f.page.locator('.row').innerHTML()).toBe(original);
  },
);
