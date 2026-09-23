import type { ExtensionSession } from '../fixtures/extension-context';
import { expect } from '../fixtures/extension-test';
import { sendExtensionMessage } from './extension-runtime';

export async function setupTranslationFixture(
  session: ExtensionSession,
  html: string,
  translations: Record<string, string>,
  url = 'https://translation-readable.test/',
) {
  const { context, sidePanelPage: panel } = session;
  const token = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_readability' },
    }),
  ).toString('base64url');
  await sendExtensionMessage(panel, {
    version: 1,
    requestId: 'settings',
    type: 'settings.save',
    payload: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      language: 'en',
      systemPrompt: '',
      codexAccessToken: `e30.${token}.`,
    },
  });
  await context.route(url, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white;font:20px/28px Arial}main{margin:120px 60px;width:900px}p{margin:0}</style>${html}`,
    }),
  );
  const requests: { texts: string[]; context?: string }[] = [];
  await context.route('https://chatgpt.com/backend-api/codex/responses', (r) => {
    const input = r.request().postDataJSON().input[0].content;
    const image = input.some((c: { type: string }) => c.type === 'input_image');
    expect(image, 'DOM translations must never send image input').toBe(false);
    const request = JSON.parse(input[0].text);
    requests.push({
      texts: request.texts.map((t: { text: string }) => t.text),
      context: request.context,
    });
    const blocks = request.texts.map((t: { id: string; text: string }) => {
      if (!(t.text in translations)) throw new Error(`Unexpected source: ${t.text}`);
      return { id: t.id, translation: translations[t.text] };
    });
    const events = [
      { type: 'response.created', response: { id: 'readability' } },
      {
        type: 'response.output_text.delta',
        delta: JSON.stringify({ blocks }),
      },
      { type: 'response.completed', response: { id: 'readability' } },
    ];
    return r.fulfill({
      contentType: 'text/event-stream',
      body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(url);
  await page.bringToFront();
  const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, url);
  if (tabId === undefined) throw new Error('Target missing');
  const toggle = async (maximize = true) => {
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: crypto.randomUUID(),
      type: 'translation.toggle',
      payload: { tabId },
    });
    if (maximize) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -2000);
      await page.keyboard.up('Control');
    }
  };
  const read = () =>
    panel.evaluate(async (id) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll<HTMLElement>('.text') ?? [])].map((flow) => {
            const range = document.createRange();
            range.selectNodeContents(flow);
            const rect = range.getBoundingClientRect();
            let left = rect.left,
              right = rect.right,
              top = rect.top,
              bottom = rect.bottom;
            // Range boxes include ellipsized glyphs. The flow itself may now own
            // the clipping box (e.g. a text label beside a preserved flex icon).
            for (let el: HTMLElement | null = flow; el; el = el.parentElement) {
              const s = getComputedStyle(el),
                box = el.getBoundingClientRect();
              if (/^(hidden|clip|auto|scroll)$/.test(s.overflowX)) {
                left = Math.max(left, box.left);
                right = Math.min(right, box.right);
              }
              if (/^(hidden|clip|auto|scroll)$/.test(s.overflowY)) {
                top = Math.max(top, box.top);
                bottom = Math.min(bottom, box.bottom);
              }
            }
            return {
              text: flow.textContent,
              font: parseFloat(getComputedStyle(flow).fontSize),
              box: range.getBoundingClientRect().toJSON(),
              rects: [...range.getClientRects()].map((r) => r.toJSON()),
              paintedBox: { left, right, top, bottom },
              ownerBox: flow.parentElement?.getBoundingClientRect().toJSON(),
              groupBox: flow.closest('.translation-group')?.getBoundingClientRect().toJSON(),
              leading: getComputedStyle(flow).lineHeight,
            };
          });
        },
      });
      return result?.result ?? [];
    }, tabId);
  return {
    page,
    panel,
    tabId,
    toggle,
    read,
    requests,
    lens: page.locator('[data-chatbrowserx-overlay=translation]'),
  };
}
