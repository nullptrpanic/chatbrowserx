import { createServer, type ServerResponse } from 'node:http';
import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest.use({ extensionHeadless: true });

for (const kind of ['image', 'text'] as const)
  for (const outcome of ['complete', 'fail', 'cancel'] as const) {
    extensionTest(
      `streams a ${kind} preview before ${outcome} without caching unfinished coverage`,
      async ({ extensionSession }, testInfo) => {
        const { context, sidePanelPage: panel } = extensionSession;
        const token = Buffer.from(
          JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'stream-test' } }),
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
        await context.route('https://translation-stream.test/', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body:
              kind === 'text'
                ? '<!doctype html><style>body{margin:0;height:2000px;font:20px Arial}p{position:absolute;left:440px;width:350px;margin:0}#first{top:340px}#second{top:390px}</style><p id="first">Save</p><p id="second">Close</p>'
                : `<!doctype html>
      <style>body{margin:0;height:2000px}img{position:absolute;left:400px;top:300px;width:400px;height:200px}</style><img>
      <script>const c=document.createElement('canvas');c.width=800;c.height=400;const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,800,400);x.fillStyle='black';x.font='40px Arial';x.fillText('Save',80,100);x.fillText('Close',80,200);document.images[0].src=c.toDataURL();</script>`,
          }),
        );
        // Redirect synthetic Provider traffic to a real paused SSE stream. All production code,
        // including fetch, the decoder, controller, IPC and renderer, remains unchanged.
        let count = 0;
        let pending: ServerResponse | undefined;
        let secondBlock: unknown;
        const emit = (event: { type: string; [key: string]: unknown }) =>
          pending?.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        const server = createServer((request, response) => {
          let body = '';
          request.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          request.on('end', () => {
            count++;
            pending = response;
            let firstBlock: unknown = {
              text: 'Save',
              translation: '保存',
              box: [100, 150, 200, 100],
            };
            secondBlock = { text: 'Close', translation: '关闭', box: [100, 400, 200, 100] };
            if (kind === 'text') {
              const input = JSON.parse(body).input[0].content[0].text as string;
              const { texts } = JSON.parse(input) as { texts: { id: string; text: string }[] };
              const first = texts.find((t) => t.text === 'Save');
              const second = texts.find((t) => t.text === 'Close');
              if (!first || !second || texts.length !== 2) throw new Error('Unexpected text batch');
              firstBlock = { id: first.id, translation: '保存' };
              secondBlock = { id: second.id, translation: '关闭' };
            }
            response.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Access-Control-Allow-Origin': '*',
            });
            emit({ type: 'response.created', response: { id: 'stream' } });
            emit({
              type: 'response.output_text.delta',
              delta: '{"blocks":[' + JSON.stringify(firstBlock),
            });
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture address');
        await context.route('https://chatgpt.com/backend-api/codex/responses', (route) =>
          route.fulfill({
            status: 307,
            headers: { Location: `http://127.0.0.1:${address.port}/responses` },
          }),
        );
        try {
          const page = await context.newPage();
          await page.setViewportSize({ width: 1200, height: 800 });
          await page.goto('https://translation-stream.test/');
          if (kind === 'image')
            await page.waitForFunction(() => document.images[0]?.naturalWidth === 800);
          await page.bringToFront();
          await page.mouse.move(600, 400);
          const tabId = await panel.evaluate(
            async () =>
              (await chrome.tabs.query({ url: 'https://translation-stream.test/' }))[0]?.id,
          );
          if (tabId === undefined) throw new Error('Target missing');
          await sendExtensionMessage(panel, {
            version: 1,
            requestId: 'toggle',
            type: 'translation.toggle',
            payload: { tabId },
          });
          const lens = page.locator('[data-chatbrowserx-overlay="translation"]');
          const read = () =>
            panel.evaluate(async (id) => {
              const [result] = await chrome.scripting.executeScript({
                target: { tabId: id },
                func: () => {
                  const host = document.querySelector<HTMLElement>(
                    '[data-chatbrowserx-overlay="translation"]',
                  );
                  const root = host && chrome.dom.openOrClosedShadowRoot(host);
                  return [...(root?.querySelectorAll('.text') ?? [])].map((e) => ({
                    text: e.textContent,
                    y: e.getBoundingClientRect().y,
                  }));
                },
              });
              return result?.result as { text: string; y: number }[];
            }, tabId);
          await expect.poll(async () => (await read()).map((e) => e.text)).toEqual(['保存']);
          await expect(lens).toHaveAttribute('data-status', 'loading');
          const before = (await read())[0];
          if (!before) throw new Error('Missing preview');
          await page.evaluate(() => scrollTo(0, 40));
          await expect.poll(async () => (await read())[0]?.y).toBeCloseTo(before.y - 40, 0);
          await expect(lens).toHaveAttribute('data-status', 'loading');
          await page.screenshot({ path: testInfo.outputPath('first-block-before-completion.png') });
          if (outcome === 'cancel') {
            await page.keyboard.press('Escape');
            await expect(lens).toHaveCount(0);
          } else if (outcome === 'fail') {
            pending?.destroy();
            await expect(lens).toHaveAttribute('data-status', 'error');
            expect(await read()).toEqual([]);
          } else {
            emit({
              type: 'response.output_text.delta',
              delta: ',' + JSON.stringify(secondBlock) + ']}',
            });
            emit({ type: 'response.completed', response: { id: 'stream' } });
            pending?.end();
            await expect(lens).toHaveAttribute('data-status', 'ready');
            expect((await read()).map((e) => e.text)).toEqual(['保存', '关闭']);
            await page.mouse.move(620, 400);
            await page.waitForTimeout(1300);
            await expect(lens).toHaveAttribute('data-status', 'ready');
          }
          expect(count).toBe(1);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
    );
  }
