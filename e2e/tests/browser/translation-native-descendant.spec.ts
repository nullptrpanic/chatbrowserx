import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

for (const background of ['transparent', '#eee'])
  extensionTest(
    `protects painted native descendants without treating ${background} empty space as text`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<style>
          @keyframes slide{to{transform:translateX(-12px)}}
          aside{position:fixed;top:120px;left:20px;z-index:10;background:${background}}
          .moving{width:200px;height:400px}
          .moving p{height:28px;color:purple}
          main{position:absolute;top:320px;left:60px;margin:0!important;width:700px!important}
        </style><aside><div class="moving"><p>侧栏标题</p></div></aside>
        <main><p>普通正文</p></main>`,
        { 侧栏标题: 'Sidebar heading', 普通正文: 'Ordinary article below the header' },
      );
      const source = await f.page.locator('main').innerHTML();
      const clip = { x: 24, y: 122, width: 150, height: 24 };
      const native = await f.page.screenshot({ clip });
      const overlap = { x: 70, y: 321, width: 120, height: 22 };
      const opaque = await f.page.screenshot({ clip: overlap });
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', /^(ready|unsupported)$/);
      const calls = f.requests.length;
      await f.page.locator('.moving').evaluate(async (el) => {
        (el as HTMLElement).style.animation = 'slide .5s';
        await Promise.all(el.getAnimations().map((animation) => animation.finished));
        (el as HTMLElement).style.animation = '';
      });
      await f.page.waitForTimeout(350);
      expect((await f.read()).map((r) => r.text)).toContain('Ordinary article below the header');
      expect((await f.read()).map((r) => r.text)).not.toContain('Sidebar heading');
      expect(await f.page.screenshot({ clip })).toEqual(native);
      if (background !== 'transparent')
        expect(await f.page.screenshot({ clip: overlap })).toEqual(opaque);
      expect(f.requests.length).toBe(calls);
      expect(await f.page.locator('main').innerHTML()).toBe(source);
      await f.page.keyboard.press('Alt+KeyR');
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Sidebar heading');
    },
  );

extensionTest(
  'reconciles static text after a native animation leaves its paint area',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
      @keyframes leave{to{transform:translateX(-300px)}}
      aside{position:fixed;top:320px;left:20px}
      .moving{width:200px;height:180px;background:#eee}
      .leaving{animation:leave .5s forwards}
      main{position:absolute;top:320px;left:60px;margin:0!important;width:700px!important}
    </style><aside><div class="moving"><p>侧栏标题</p></div></aside>
    <main><p>普通正文</p></main>`,
      { 侧栏标题: 'Sidebar heading', 普通正文: 'Ordinary article below the header' },
    );
    const source = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Ordinary article below the header');
    const calls = f.requests.length;
    await f.page.locator('.moving').evaluate((el) => el.classList.add('leaving'));
    await expect
      .poll(() => f.page.locator('.moving').evaluate((el) => el.getBoundingClientRect().right))
      .toBeLessThan(0);
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Ordinary article below the header');
    expect(f.requests.length).toBe(calls);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
  },
);

extensionTest(
  'preserves source table overflow behind a deferred pinned descendant',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
      @keyframes slide{to{transform:translateX(-12px)}}
      aside{position:fixed;top:120px;left:20px;z-index:10}
      .moving{width:200px;height:400px}.paint{height:400px;background:#eee}
      main{position:relative;top:300px;left:300px;margin:0!important;width:700px!important}
      table{margin-left:-280px;width:980px;table-layout:fixed;border-collapse:collapse}
      td{border:1px solid #aaa;height:120px}
    </style><aside><div class="moving"><div class="paint"><p>侧栏标题</p></div></div></aside>
    <main><p>普通正文</p><table><tr><td>模块</td><td>职责</td><td>部署</td></tr></table><canvas width="700" height="30"></canvas></main>`,
      {
        侧栏标题: 'Sidebar heading',
        普通正文: 'Ordinary article',
        模块: 'Module',
        职责: 'Responsibility',
        部署: 'Deployment',
      },
    );
    const source = await f.page.locator('main').innerHTML();
    const clip = { x: 24, y: 340, width: 190, height: 110 };
    const native = await f.page.screenshot({ clip });
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Ordinary article');
    const calls = f.requests.length;
    await f.page.locator('.moving').evaluate(async (el) => {
      (el as HTMLElement).style.animation = 'slide .5s';
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
      (el as HTMLElement).style.animation = '';
    });
    await f.page.waitForTimeout(350);
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Ordinary article');
    expect((await f.read()).map((r) => r.text)).toContain('Deployment');
    expect(await f.page.screenshot({ clip })).toEqual(native);
    expect(f.requests.length).toBe(calls);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
  },
);
