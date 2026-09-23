import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'uses the text line height inside a clamped wrapper with smaller inherited type',
  async ({ extensionSession }) => {
    const translated = 'A translated caption that occupies two complete lines in this card';
    const f = await setup(
      extensionSession,
      `<main><div style="width:320px;font:14px/18px Arial;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden"><a href="#news" style="font:22px/32px Arial">普通新闻标题</a></div></main>`,
      { 普通新闻标题: translated },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).some((row) => row.text === translated))
      .toBe(true);
    const row = (await f.read()).find((row) => row.text === translated);
    if (!row) throw new Error('Missing translated caption');
    expect(row.paintedBox.bottom - row.paintedBox.top).toBeGreaterThan(54);
    expect(row.font).toBe(22);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

for (const constraint of ['height:40px', 'max-height:40px'])
  extensionTest(
    `does not expose a half line under a ${constraint} caption budget`,
    async ({ extensionSession }) => {
      const translated = 'A translated caption that needs multiple lines in the available space';
      const f = await setup(
        extensionSession,
        `<main><p style="width:240px;font:16px/24px Arial;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;${constraint}">普通新闻标题</p></main>`,
        { 普通新闻标题: translated },
      );
      const original = await f.page.locator('main').innerHTML();
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).some((row) => row.text === translated))
        .toBe(true);
      const row = (await f.read()).find((row) => row.text === translated);
      if (!row) throw new Error('Missing translated caption');
      expect(row.paintedBox.bottom - row.paintedBox.top).toBeLessThanOrEqual(25);
      expect(row.font).toBe(16);
      expect(await f.page.locator('main').innerHTML()).toBe(original);
    },
  );
