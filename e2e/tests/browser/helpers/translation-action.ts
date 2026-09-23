import type { Page } from '@playwright/test';

export async function clickTranslationAction(page: Page, panel: Page, tabId: number) {
  // This helper runs under both Playwright and tsx. Keep the browser program plain JS:
  // transpiler closure helpers do not exist in either Chrome execution world.
  const point = await panel.evaluate<{ x: number; y: number }>(`(async () => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: ${JSON.stringify(tabId)} },
      func: () => {
        const host = document.querySelector(
          '[data-chatbrowserx-overlay="translation"]',
        );
        const button = host && chrome.dom.openOrClosedShadowRoot(host)?.querySelector('.notice > button');
        if (!button || button.hidden) throw new Error('Translation action unavailable.');
        const r = button.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
    });
    if (!result?.result) throw new Error('Translation action position unavailable.');
    return result.result;
  })()`);
  await page.mouse.click(point.x, point.y);
}
