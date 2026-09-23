import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'budgets clamped headlines collectively before the next independent flow',
  async ({ extensionSession }) => {
    const translations = Object.fromEntries(
      ['主要新闻标题', '第一新闻', '第二新闻', '第三新闻', '第四新闻', '更多新闻'].map(
        (text, i) => [
          text,
          `Translated news ${i} with a much longer headline that must remain in its available row`,
        ],
      ),
    );
    const label = (text: string) => `<div class="clamp"><a href="#news">${text}</a></div>`;
    const f = await setup(
      extensionSession,
      `<style>
      .row{display:flex;gap:24px}.left{width:600px}.right{width:276px}
      .clamp{font:14px/18px Arial;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;margin-bottom:8px}
      .clamp a{font:18px/28px Arial}.heading a{font:26px/38px Arial}
      .columns{display:flex;gap:20px}.column{width:290px}
      .next{margin-top:24px;display:flex;gap:20px}
    </style><main><section class="row"><div class="left"><div class="heading">${label('主要新闻标题')}</div><div class="columns"><div class="column">${label('第一新闻')}${label('第二新闻')}</div><div class="column">${label('第三新闻')}${label('第四新闻')}</div></div></div><div class="right"><canvas width="276" height="100"></canvas></div></section><section class="next"><span>更多新闻</span><canvas width="100" height="60"></canvas></section></main>`,
      translations,
    );
    const original = await f.page.locator('main').innerHTML();
    const next = await f.page.locator('.next').boundingBox();
    if (!next) throw new Error('Missing independent flow');
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((row) => row.text).sort())
      .toEqual(Object.values(translations).sort());
    const rows = (await f.read()).filter((row) => row.text !== translations['更多新闻']);
    expect(rows.every((row) => row.paintedBox.bottom <= next.y)).toBe(true);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);
