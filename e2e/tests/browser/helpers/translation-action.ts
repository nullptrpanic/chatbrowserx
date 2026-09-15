import type { Page } from '@playwright/test';

export async function clickTranslationAction(page: Page, panel: Page, tabId: number) {
  const point = await panel.evaluate(async (id) => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => {
        const host = document.querySelector<HTMLElement>(
          '[data-chatbrowserx-overlay="translation"]',
        );
        const button = host && chrome.dom.openOrClosedShadowRoot(host)?.querySelector('button');
        if (!button || button.hidden) throw new Error('Translation action unavailable.');
        const r = button.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
    });
    if (!result?.result) throw new Error('Translation action position unavailable.');
    return result.result;
  }, tabId);
  await page.mouse.click(point.x, point.y);
}
