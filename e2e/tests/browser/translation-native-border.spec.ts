import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'preserves a bordered foreground inside a transformed portal without rejecting document flow',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
    .document{margin:120px 60px;width:700px;font:18px/26px Arial}
    .document>canvas{display:block;width:700px;height:60px}
    h2{margin:20px 0}table{width:100%;table-layout:fixed}td{border:1px solid #aaa;padding:8px}
    .portal{position:fixed;left:60px;top:205px;width:300px;height:30px;z-index:10;transform:scale(.95)}
    .foreground{width:100%;height:100%;box-sizing:border-box;border:1px solid black;overflow:hidden;background:#ee44aa}
  </style><div class="document"><canvas></canvas><h2>模块划分</h2><p>稳定正文</p><table><tr><td>模块</td><td>职责</td></tr></table><canvas></canvas></div><div class="portal"><div class="foreground">Native toolbar</div></div>`,
      {
        模块划分: 'Module breakdown',
        稳定正文: 'Stable paragraph below the toolbar',
        模块: 'Module',
        职责: 'Responsibility',
      },
    );
    const original = await f.page.locator('.document').innerHTML();
    const clip = { x: 68, y: 206, width: 284, height: 28 };
    const native = await f.page.screenshot({ clip });
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((row) => row.text))
      .toContain('Stable paragraph below the toolbar');
    expect((await f.read()).map((row) => row.text)).toContain('Responsibility');
    expect(await f.page.screenshot({ clip })).toEqual(native);
    expect(await f.page.locator('.document').innerHTML()).toBe(original);
  },
);
