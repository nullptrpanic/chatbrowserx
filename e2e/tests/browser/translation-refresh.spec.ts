import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'recovers from a nested transient provider error through one explicit refresh',
  { tag: '@smoke' },
  async ({ extensionSession }) => {
    const f = await setup(extensionSession, '<main><p>正文</p></main>', { 正文: 'Article' });
    let calls = 0;
    await extensionSession.context.route(
      'https://chatgpt.com/backend-api/codex/responses',
      (route) => {
        if (++calls > 1) return route.fallback();
        return route.fulfill({
          contentType: 'text/event-stream',
          body: 'event: error\ndata: {"type":"error","error":{"code":"server_is_overloaded","message":"private upstream detail"}}\n\n',
        });
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'error');
    const notice = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          return (
            host && chrome.dom.openOrClosedShadowRoot(host)?.querySelector('.notice')?.textContent
          );
        },
      });
      return result?.result;
    }, f.tabId);
    expect(notice).toContain('MODEL_TRANSIENT');
    expect(notice).not.toContain('private upstream detail');
    expect(calls).toBe(1);
    await f.page.keyboard.press('Alt+KeyR');
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(['Article']);
    expect(calls).toBe(2);
    expect(await f.page.locator('main').textContent()).toBe('正文');
  },
);

extensionTest(
  'refreshes while a page search input has autofocus without editing its value',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<input autofocus value="draft"><main><p>正文</p></main>',
      { 正文: 'Article' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await expect(f.page.locator('input')).toBeFocused();
    await f.page.keyboard.press('Alt+KeyR');
    await expect.poll(() => f.requests.length).toBe(2);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await expect(f.page.locator('input')).toHaveValue('draft');
  },
);

extensionTest(
  'keeps the refresh hint above the lens, including after completion and pointer movement',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="margin:220px 300px;width:700px"><p>正文</p></main>',
      { 正文: 'Article' },
    );
    await f.page.mouse.move(350, 250);
    await f.toggle(false);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const ui = () =>
      f.panel.evaluate(async (tabId) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const notice = root?.querySelector<HTMLElement>('.notice');
            const frame = root?.querySelector('.frame');
            if (!notice || !frame) throw new Error('Missing lens UI');
            return {
              text: notice.textContent,
              visible: !notice.hidden,
              notice: notice.getBoundingClientRect().toJSON(),
              frame: frame.getBoundingClientRect().toJSON(),
            };
          },
        });
        if (!result?.result) throw new Error('Missing lens geometry');
        return result.result;
      }, f.tabId);
    for (const [x, y] of [
      [550, 450],
      [360, 280],
    ] as const) {
      await f.page.mouse.move(x, y);
      await expect.poll(async () => (await ui()).frame.x).toBe(x - 250);
      const state = await ui();
      expect(state.visible).toBe(true);
      expect(state.text).toContain('Alt+R');
      expect(state.text).toContain('Option+R');
      expect(state.notice.left).toBe(state.frame.left);
      expect(state.frame.top - state.notice.bottom).toBe(6);
    }
    await f.page.keyboard.press('Alt+KeyR');
    await expect.poll(() => f.requests.length).toBe(2);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toContain('Article');
    await f.page.mouse.move(10, 10);
    await expect.poll(async () => (await ui()).frame.top).toBe(0);
    expect((await ui()).notice.top).toBe(0);
    await f.page.mouse.move(1090, 890);
    await expect.poll(async () => (await ui()).frame.right).toBe(1100);
    expect((await ui()).notice.right).toBeLessThanOrEqual(1100);
  },
);

extensionTest(
  'keeps changing text native until explicit refresh and leaves its static neighbor translated',
  { tag: '@smoke' },
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><nav style="display:flex;gap:40px"><a href="#static">静态导航</a><span id="changing">旧标题</span></nav><p>固定正文</p></main>',
      {
        静态导航: 'Navigation',
        旧标题: 'Old headline',
        最新标题: 'Current headline',
        固定正文: 'Static article',
        变化标题0: 'Changing 0',
        变化标题1: 'Changing 1',
        变化标题2: 'Changing 2',
        变化标题3: 'Changing 3',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const initialRequests = f.requests.length;
    for (let i = 0; i < 4; i++) {
      await f.page.locator('#changing').evaluate((el, i) => {
        el.replaceChildren(document.createTextNode(`变化标题${i}`));
      }, i);
      await f.page.waitForTimeout(220);
    }
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .not.toContain('Old headline');
    expect((await f.read()).map((r) => r.text)).toContain('Navigation');
    expect((await f.read()).map((r) => r.text)).toContain('Static article');
    expect(f.requests.length).toBe(initialRequests);
    await f.page.locator('#changing').evaluate((el) => {
      el.textContent = '最新标题';
    });
    await f.page.keyboard.press('Alt+KeyR');
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Current headline');
    await f.page.keyboard.press('Escape');
    expect(await f.page.locator('main').innerHTML()).toBe(original.replace('旧标题', '最新标题'));
  },
);

extensionTest(
  'does not rejoin an animated text track during pauses until manually refreshed',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>@keyframes slide{from{top:0}to{top:-28px}}.track{position:relative;width:160px;height:28px;overflow:hidden}.slide{position:absolute;top:0}</style><main><p>稳定正文</p><div class="track"><span class="slide">轮播文字</span></div></main>',
      { 稳定正文: 'Stable article', 轮播文字: 'Ticker' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    for (let i = 0; i < 2; i++) {
      await f.page.locator('.slide').evaluate(async (el) => {
        (el as HTMLElement).style.animation = 'slide .3s';
        await Promise.all(el.getAnimations().map((a) => a.finished));
        (el as HTMLElement).style.animation = '';
      });
      await f.page.waitForTimeout(220);
      expect((await f.read()).map((r) => r.text)).not.toContain('Ticker');
      expect((await f.read()).map((r) => r.text)).toContain('Stable article');
    }
    expect(f.requests).toHaveLength(1);
    await f.page.keyboard.press('Alt+KeyR');
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Ticker');
  },
);
