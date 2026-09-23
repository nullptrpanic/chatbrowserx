import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

for (const animated of [false, true])
  for (const replacement of ['none', 'atomic', 'separate'] as const)
    extensionTest(
      `keeps static siblings translated when a ${animated ? 'deferred animated' : 'translated static'} portal has ${replacement} replacement`,
      async ({ extensionSession }) => {
        const f = await setup(
          extensionSession,
          `<style>@keyframes leave{to{opacity:0;transform:translateY(-10px)}}
            .popup{position:absolute;top:330px;left:60px;width:280px;height:93px;background:#eee}
            table{width:600px;border-collapse:collapse}td{border:1px solid #ccc;padding:8px}
          </style><div id="app"><main><h2>模块划分</h2><p>稳定正文</p>
            <table><tr><td>模块名称</td><td>职责</td></tr></table></main>
            <aside id="portal"><div class="popup"><p>提示内容</p></div></aside></div>`,
          {
            模块划分: 'Module breakdown',
            稳定正文: 'Stable article',
            模块名称: 'Module name',
            职责: 'Responsibilities',
            提示内容: 'Temporary notice',
            新提示: 'Replacement notice',
          },
        );
        const source = await f.page.locator('main').innerHTML();
        await f.toggle();
        await expect(f.lens).toHaveAttribute('data-status', 'ready');
        const texts = async () => (await f.read()).map((r) => r.text);
        await expect.poll(texts).toContain('Temporary notice');
        const calls = f.requests.length;
        if (animated) {
          await f.page.locator('.popup').evaluate((el) => {
            (el as HTMLElement).style.animation = 'leave 1s forwards';
          });
          await expect.poll(texts).not.toContain('Temporary notice');
          await f.page.locator('.popup').evaluate(async (el) => {
            await Promise.all(el.getAnimations().map((animation) => animation.finished));
          });
        }
        await f.page.locator('#portal').evaluate((el, replacement) => {
          if (replacement !== 'none') {
            const next = el.cloneNode(true) as HTMLElement;
            const popup = next.querySelector<HTMLElement>('.popup');
            if (!popup) throw new Error('Expected the synthetic popup');
            popup.style.animation = '';
            popup.textContent = '新提示';
            if (replacement === 'atomic') el.replaceWith(next);
            else {
              const parent = el.parentElement;
              if (!parent) throw new Error('Expected the shared application parent');
              el.remove();
              parent.append(next);
            }
          } else el.remove();
        }, replacement);
        // Observe past reconciliation, not merely the last frame before the mutation.
        await f.page.waitForTimeout(350);
        expect(await texts()).toEqual([
          'Module breakdown',
          'Stable article',
          'Module name',
          'Responsibilities',
        ]);
        expect(f.requests.length).toBe(calls);
        expect(await f.page.locator('main').innerHTML()).toBe(source);
        if (replacement !== 'none') {
          await f.page.keyboard.press('Alt+KeyR');
          await expect.poll(texts).toContain('Replacement notice');
          expect(await texts()).toContain('Module breakdown');
        } else await expect(f.lens).toHaveAttribute('data-status', 'ready');
        await f.page.keyboard.press('Escape');
        expect(await f.page.locator('main').innerHTML()).toBe(source);
      },
    );
