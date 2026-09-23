import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'keeps stationary header text through decorative shadow transitions',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>nav{position:fixed;top:0;left:0;width:100%;height:64px;display:flex;gap:28px;align-items:center;background:white;transition:box-shadow .3s;box-shadow:none}nav.raised{box-shadow:0 16px 32px -16px #0002}</style><nav><a>学习</a><a>参考</a><a>社区</a></nav><main><p>稳定正文</p></main>',
      { 学习: 'Learn', 参考: 'Reference', 社区: 'Community', 稳定正文: 'Stable article' },
    );
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(4);
    const calls = f.requests.length;
    for (const raised of [true, false]) {
      await f.page.locator('nav').evaluate((el, enabled) => {
        el.classList.toggle('raised', enabled);
      }, raised);
      await expect
        .poll(() => f.page.locator('nav').evaluate((el) => el.getAnimations().length))
        .toBeGreaterThan(0);
      await f.page.waitForTimeout(400);
      await expect
        .poll(async () => (await f.read()).map((row) => row.text).sort())
        .toEqual(['Learn', 'Reference', 'Community', 'Stable article'].sort());
      expect((await f.read()).every((row) => row.font === 20)).toBe(true);
      expect(f.requests).toHaveLength(calls);
      await expect(f.page.locator('nav')).toHaveText('学习参考社区');
    }
  },
);

extensionTest(
  'keeps static bordered text translated when browser zoom triggers transition-all rounding',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>main{width:520px;transition:all .6s;border:1px solid #ddd;font:18px/26px Arial}td{padding:8px}</style><main><h2>模块划分</h2><p>稳定正文</p><table><tr><td>模块</td><td>职责</td></tr></table></main>',
      {
        模块划分: 'Module breakdown',
        稳定正文: 'Stable article',
        模块: 'Module',
        职责: 'Responsibility',
      },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle(false);
    await f.page.mouse.move(340, 260);
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Module breakdown');
    const calls = f.requests.length;
    for (const factor of [1.25, 1]) {
      await f.panel.evaluate(({ tabId, factor }) => chrome.tabs.setZoom(tabId, factor), {
        tabId: f.tabId,
        factor,
      });
      await f.page.waitForTimeout(800);
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Module breakdown');
      expect((await f.read()).find((r) => r.text === 'Stable article')?.font).toBe(18);
    }
    expect(f.requests.length).toBe(calls);
    expect(await f.page.locator('main').evaluate((el) => el.outerHTML)).toBe(source);
  },
);

extensionTest(
  'still defers a real painted border-width transition until refresh',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>main{width:520px;transition:border-width .3s;border:1px solid black}</style><main><p>稳定正文</p></main>',
      { 稳定正文: 'Stable article' },
    );
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const calls = f.requests.length;
    await f.page.locator('main').evaluate((el) => {
      el.style.borderWidth = '8px';
    });
    await f.page.waitForTimeout(500);
    await expect.poll(async () => (await f.read()).length).toBe(0);
    expect(f.requests.length).toBe(calls);
    await f.page.keyboard.press('Alt+KeyR');
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Stable article');
    await expect.poll(() => f.requests.length).toBe(calls + 1);
  },
);
