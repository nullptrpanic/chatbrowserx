import { extensionTest, expect } from './fixtures/extension-test';
import { clickTranslationAction } from './helpers/translation-action';
import { setupTranslationFixture } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'clicks the retry notice rather than an inert button in the translated page',
  async ({ extensionSession }) => {
    const marked = '阅读<m0>指南</m0>。';
    const translations = { 确认: 'Confirm', [marked]: 'Read the guide.' };
    const f = await setupTranslationFixture(
      extensionSession,
      '<main><button type="button" style="width:240px">确认</button><p>阅读<a href="/guide">指南</a>。</p></main>',
      translations,
    );
    const source = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'error');
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toEqual(['Confirm']);

    translations[marked] = 'Read <m0>the guide</m0>.';
    await clickTranslationAction(f.page, f.panel, f.tabId);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.texts).toEqual([marked]);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
  },
);

extensionTest(
  'isolates a malformed model block, retries only that block and retains validated cache',
  { tag: '@smoke' },
  async ({ extensionSession }, testInfo) => {
    const marked = '阅读<m0>指南</m0>。';
    const translations = {
      '第一段。': 'First paragraph.',
      [marked]: 'Read the guide.', // Missing the source-owned link marker.
      '最后一段。': 'Last paragraph.',
    };
    const f = await setupTranslationFixture(
      extensionSession,
      '<main><p>第一段。</p><p>阅读<a href="/guide">指南</a>。</p><p>最后一段。</p></main>',
      translations,
    );
    const source = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'error');
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toEqual(['First paragraph.', 'Last paragraph.']);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.texts).toEqual(['第一段。', marked, '最后一段。']);
    await f.page.mouse.move(700, 300);
    await f.page.waitForTimeout(1500);
    expect(f.requests).toHaveLength(1);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
    await f.page.screenshot({ path: testInfo.outputPath('partial-result.png') });

    translations[marked] = 'Read <m0>the guide</m0>.';
    await clickTranslationAction(f.page, f.panel, f.tabId);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.texts).toEqual([marked]);
    const rows = await f.read();
    expect(rows.map((r) => r.text)).toEqual([
      'First paragraph.',
      'Read the guide.',
      'Last paragraph.',
    ]);
    expect(rows.every((r) => r.font === 20 && r.paintedBox.right > r.paintedBox.left)).toBe(true);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
    await f.page.screenshot({ path: testInfo.outputPath('retried-result.png') });

    await f.page.keyboard.press('Escape');
    await expect(f.lens).toHaveCount(0);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect(f.requests).toHaveLength(2);
    expect((await f.read()).map((r) => r.text)).toEqual(rows.map((r) => r.text));
    expect(await f.page.locator('main').innerHTML()).toBe(source);
  },
);
