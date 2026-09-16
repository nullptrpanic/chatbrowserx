import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';
import { clickTranslationAction } from './helpers/translation-action';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'keeps a failed lens visible and retries only on explicit action, never on movement',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_translation_error' },
      }),
    ).toString('base64url');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'settings',
      type: 'settings.save',
      payload: {
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'zh-CN',
        codexAccessToken: `e30.${token}.`,
      },
    });
    await context.route('https://translation-error.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
    <style>body{margin:0;background:white;font:22px Arial}main{position:absolute;left:400px;top:320px}p{position:absolute;left:400px;top:400px}</style>
    <main>Static title</main>`,
      }),
    );
    let textRequests = 0,
      failedRequests = 0;
    await context.route('https://chatgpt.com/backend-api/codex/responses', async (route) => {
      const request = route.request().postDataJSON() as {
        input: { content?: { type: string; text?: string }[] }[];
      };
      const contents = request.input.flatMap((i) => i.content ?? []);
      expect(contents.every((c) => c.type === 'input_text')).toBe(true);
      const payload = JSON.parse(contents[0]?.text ?? '{}') as {
        texts: { id: string; text: string }[];
      };
      const failing = payload.texts.some((t) => t.text === 'Retry this');
      if (failing) failedRequests++;
      else textRequests++;
      const output =
        failing && failedRequests === 1
          ? 'not JSON: private provider output'
          : JSON.stringify({
              blocks: payload.texts.map((t) => ({
                id: t.id,
                translation: t.text === 'Static title' ? '静态标题' : '重试成功',
              })),
            });
      const events = [
        { type: 'response.created', response: { id: 'translation' } },
        { type: 'response.output_text.delta', delta: output },
        { type: 'response.completed', response: { id: 'translation' } },
      ];
      await route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('https://translation-error.test/');
    await page.bringToFront();
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'https://translation-error.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw new Error('Fixture tab missing');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'toggle',
      type: 'translation.toggle',
      payload: { tabId },
    });
    await page.mouse.move(600, 400);
    const lens = page.locator('[data-chatbrowserx-overlay=translation]');
    await expect(lens).toHaveAttribute('data-status', 'ready');
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.textContent = 'Retry this';
      document.body.append(p);
    });
    await expect(lens).toHaveAttribute('data-status', 'error');
    const readOverlay = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return {
              notice: root?.querySelector('[role=status]')?.textContent,
              texts: [...(root?.querySelectorAll('.text') ?? [])].map((n) => n.textContent),
            };
          },
        });
        return result?.result;
      }, tabId);
    await expect.poll(async () => (await readOverlay())?.texts).toContain('静态标题');
    const failure = await readOverlay();
    expect(failure?.notice).toContain('text/TRANSLATION_RESPONSE_INVALID');
    expect(failure?.notice).not.toContain('private');
    // A failed text batch must not invalidate successful text or start a retry loop.
    await page.waitForTimeout(1200);
    const visibility = await page.evaluate(
      () =>
        new Promise<{ hiddenFrames: number; states: string[] }>((resolve) => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          if (!host) throw new Error('Translation overlay missing');
          let hiddenFrames = 0;
          const states = new Set<string>();
          const started = performance.now();
          const sample = () => {
            if (getComputedStyle(host).visibility !== 'visible') hiddenFrames++;
            states.add(host.dataset.status ?? 'missing');
            if (performance.now() - started >= 3000) resolve({ hiddenFrames, states: [...states] });
            else requestAnimationFrame(sample);
          };
          sample();
        }),
    );
    expect(visibility).toEqual({ hiddenFrames: 0, states: ['error'] });
    expect(failedRequests).toBe(1);
    expect(textRequests).toBe(1);
    await testInfo.attach('failed-lens-observation', {
      body: JSON.stringify({ ...visibility, failedRequests, textRequests, error: failure?.notice }),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('failed-lens.png') });
    await page.mouse.move(610, 400);
    await page.waitForTimeout(1500);
    await expect(lens).toHaveAttribute('data-status', 'error');
    expect(failedRequests).toBe(1);
    await clickTranslationAction(page, panel, tabId);
    await expect(lens).toHaveAttribute('data-status', 'ready');
    expect(failedRequests).toBe(2);
    expect(textRequests).toBe(1);
    expect((await readOverlay())?.texts).toContain('重试成功');
    await page.keyboard.press('Escape');
    await expect(lens).toHaveCount(0);
  },
);
