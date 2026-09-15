import { extensionTest, expect } from './fixtures/extension-test';
import type { ExtensionSession } from './fixtures/extension-context';
import { sendExtensionMessage } from './helpers/extension-runtime';
import type { TranslationResult } from '../../../src/translation/region-translation';

extensionTest.use({ extensionHeadless: true });

async function fixture(
  session: ExtensionSession,
  html: string,
  translations: Record<string, string>,
  imageBlocks: TranslationResult['blocks'] = [
    { text: 'HERE', translation: '这里', box: [0, 400, 300, 100] },
  ],
) {
  const { context, sidePanelPage: panel } = session;
  const token = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_translation_followup' },
    }),
  ).toString('base64url');
  await sendExtensionMessage(panel, {
    version: 1,
    requestId: 'settings',
    type: 'settings.save',
    payload: {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      language: 'zh-CN',
      systemPrompt: '',
      codexAccessToken: `e30.${token}.`,
    },
  });
  await context.route('https://translation-followup.test/', (r) =>
    r.fulfill({ contentType: 'text/html', body: `<!doctype html>${html}` }),
  );
  const requests = { text: 0, sources: [] as string[], images: [] as string[] };
  await context.route('https://chatgpt.com/backend-api/codex/responses', (r) => {
    const input = r.request().postDataJSON().input[0].content;
    const image = input.find((c: { type: string }) => c.type === 'input_image');
    if (image) requests.images.push(image.image_url);
    else requests.text++;
    const blocks = image
      ? imageBlocks
      : JSON.parse(input[0].text).texts.map((t: { id: string; text: string }) => {
          requests.sources.push(t.text);
          if (!(t.text in translations)) throw new Error(`Unexpected source: ${t.text}`);
          return { id: t.id, translation: translations[t.text] };
        });
    const events = [
      { type: 'response.created', response: { id: 'followup' } },
      { type: 'response.output_text.delta', delta: JSON.stringify({ blocks }) },
      { type: 'response.completed', response: { id: 'followup' } },
    ];
    return r.fulfill({
      contentType: 'text/event-stream',
      body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    });
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto('https://translation-followup.test/');
  await page.bringToFront();
  await page.mouse.move(500, 400);
  const tabId = await panel.evaluate(
    async () => (await chrome.tabs.query({ url: 'https://translation-followup.test/' }))[0]?.id,
  );
  if (tabId === undefined) throw new Error('Missing target');
  const lens = page.locator('[data-chatbrowserx-overlay=translation]');
  const toggle = async () => {
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: crypto.randomUUID(),
      type: 'translation.toggle',
      payload: { tabId },
    });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -2000);
    await page.keyboard.up('Control');
    await expect(lens).toHaveAttribute('data-status', 'ready');
  };
  return { page, panel, tabId, lens, toggle, requests };
}

extensionTest(
  'never reveals clipped navigation labels, and translates them after opening',
  async ({ extensionSession }, info) => {
    const { page, panel, tabId, toggle, requests } = await fixture(
      extensionSession,
      `<style>body{margin:0;background:white;font:20px/30px Arial}p{margin:0}article{position:absolute;left:100px;top:150px}nav{position:absolute;left:750px;top:100px;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}nav div{width:160px;background:linear-gradient(to right,#fef3c7,white)}#overflow{position:absolute;left:750px;top:250px;overflow:hidden;width:1px;height:1px}#overflow p{width:160px}details{position:absolute;left:100px;top:400px}</style><article>Visible paragraph.</article><nav><div>Website</div><div>Community</div><div>Solutions</div></nav><div id="overflow"><p>Clipped label</p></div><details><summary>Open menu</summary><p>Hidden item</p></details>`,
      {
        'Visible paragraph.': '可见段落。',
        Website: '网站',
        Community: '社区',
        Solutions: '解决方案',
        'Open menu': '打开菜单',
        'Hidden item': '隐藏项目',
        'Clipped label': '裁剪文字',
      },
    );
    await toggle();
    expect(requests.sources.sort()).toEqual(['Open menu', 'Visible paragraph.']);
    const read = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            return host
              ? [...(chrome.dom.openOrClosedShadowRoot(host)?.querySelectorAll('.text') ?? [])].map(
                  (t) => t.textContent,
                )
              : [];
          },
        });
        return result?.result;
      }, tabId);
    expect((await read())?.sort()).toEqual(['可见段落。', '打开菜单']);
    await page.screenshot({ path: info.outputPath('hidden-navigation.png') });
    await page.evaluate(() => {
      const nav = document.querySelector('nav');
      if (nav) nav.style.cssText = 'clip-path:none;width:180px;height:auto;overflow:visible';
    });
    await expect.poll(read).toContain('网站');
    await page.evaluate(() => {
      document.querySelector('nav')?.removeAttribute('style');
    });
    await expect.poll(async () => (await read())?.sort()).toEqual(['可见段落。', '打开菜单']);
  },
);

extensionTest(
  'protects chart ticks and notation, with readable source-sized image translations',
  async ({ extensionSession }, info) => {
    const png = await extensionSession.sidePanelPage.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 600;
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('Missing canvas');
      ctx.scale(2, 2);
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, 600, 300);
      ctx.fillStyle = 'black';
      ctx.font = '24px Arial';
      ctx.fillText('Training progress', 180, 38);
      ctx.save();
      ctx.translate(25, 190);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText('Over refusal', 0, 0);
      ctx.restore();
      for (let i = 0; i < 5; i++) ctx.fillText(`0.${9 - i}`, 40, 70 + i * 28);
      ctx.fillStyle = 'green';
      ctx.fillText('Pol', 300, 234);
      ctx.fillStyle = 'black';
      ctx.fillText('Short', 360, 234);
      ctx.fillText('Labels', 360, 276);
      return c.toDataURL();
    });
    const blocks = [
      { text: 'Training progress', translation: '训练进展', box: [300, 60, 500, 80] },
      { text: 'Over refusal', translation: '过度拒绝率', box: [20, 150, 20, 500] },
      { kind: 'notation', text: 'Pol', translation: '多项式', box: [500, 700, 80, 80] },
      {
        text: 'Short',
        translation: '这是一个在原位置无法清晰显示的过长翻译',
        box: [600, 700, 120, 80],
      },
      { text: 'Labels', translation: '标签翻译', box: [600, 840, 140, 80] },
    ] as TranslationResult['blocks'];
    const { page, panel, tabId, toggle, requests } = await fixture(
      extensionSession,
      `<style>body{margin:0;background:white}img{position:absolute;left:200px;top:200px;width:600px;height:300px}</style><img src="${png}">`,
      {},
      blocks,
    );
    await page.waitForFunction(() => document.images[0]?.complete);
    const imageBox = await page.locator('img').boundingBox();
    const before = await page.screenshot();
    await toggle();
    const painted = await panel.evaluate(async (id) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          return host
            ? [
                ...(chrome.dom
                  .openOrClosedShadowRoot(host)
                  ?.querySelectorAll<HTMLElement>('.text') ?? []),
              ].map((t) => ({
                text: t.textContent,
                box: t.getBoundingClientRect().toJSON(),
                fontSize: parseFloat(t.style.fontSize),
              }))
            : [];
        },
      });
      return r?.result;
    }, tabId);
    expect(painted?.map((p) => p.text)).toEqual(['训练进展', '标签翻译']);
    expect(painted?.[0]?.fontSize).toBeGreaterThanOrEqual(38.4); // >= 80% of 48 intrinsic pixels
    expect(painted?.[0]?.box.left).toBeGreaterThanOrEqual(378);
    expect(painted?.[0]?.box.right).toBeLessThanOrEqual(682);
    expect(painted?.[1]?.fontSize).toBeGreaterThanOrEqual(38.4);
    expect(painted?.[1]?.fontSize).toBeLessThan(48);
    expect(await page.locator('img').boundingBox()).toEqual(imageBox);
    const after = await page.screenshot({ path: info.outputPath('chart-preserved.png') });
    const diff = await panel.evaluate(
      async ({ before, after }) => {
        const contexts = await Promise.all(
          [before, after].map(async (url) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
            if (!ctx) throw new Error('Missing pixels');
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            return ctx;
          }),
        );
        const [original, translated] = contexts;
        if (!original || !translated) throw new Error('Missing comparison pixels');
        let changed = 0;
        // The axis, ticks, symbols and rejected long label must remain pixel-identical.
        for (const [x, y, w, h] of [
          [200, 245, 100, 155],
          [490, 400, 200, 42],
        ] as const) {
          const a = original.getImageData(x, y, w, h).data,
            b = translated.getImageData(x, y, w, h).data;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
        }
        return changed;
      },
      {
        before: `data:image/png;base64,${before.toString('base64')}`,
        after: `data:image/png;base64,${after.toString('base64')}`,
      },
    );
    expect(diff).toBe(0);
    expect(requests.images).toHaveLength(1);
    await page.keyboard.press('Escape');
    await toggle();
    expect(requests.images).toHaveLength(1);
  },
);

extensionTest(
  'reuses text and mask nodes during window/nested scroll, including sticky labels',
  async ({ extensionSession }, info) => {
    const { page, panel, tabId, toggle, requests } = await fixture(
      extensionSession,
      `<style>body{margin:0;min-height:2000px;background:white;font:20px/30px Arial}p{margin:0}#moving{position:absolute;left:200px;top:240px}#scroller{position:absolute;left:200px;top:400px;width:600px;height:160px;overflow:auto}#sticky{position:sticky;top:0;background:white}#nested{margin-top:40px}#space{height:500px}</style><p id="moving">Moving paragraph.</p><div id="scroller"><p id="sticky">Sticky paragraph.</p><p id="nested">Nested paragraph.</p><div id="space"></div></div>`,
      {
        'Moving paragraph.': '移动段落。',
        'Sticky paragraph.': '固定段落。',
        'Nested paragraph.': '嵌套段落。',
      },
    );
    await toggle();
    const read = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            if (!root) throw new Error('Missing lens');
            const state = globalThis as unknown as { followupNodes?: Map<string, Element[]> };
            state.followupNodes ??= new Map();
            return ['moving', 'sticky', 'nested'].map((id, index) => {
              const source = document.getElementById(id);
              const text = [...root.querySelectorAll<HTMLElement>('.text')].find(
                (t) => t.textContent === ['移动段落。', '固定段落。', '嵌套段落。'][index],
              );
              if (!source || !text?.parentElement) throw new Error('Missing paragraph');
              const masks = [...text.parentElement.querySelectorAll('.source-mask')];
              const saved = state.followupNodes?.get(id);
              state.followupNodes?.set(id, [text, ...masks]);
              const range = document.createRange();
              range.selectNodeContents(source);
              const original = range.getBoundingClientRect().toJSON();
              range.selectNodeContents(text);
              return {
                same: !saved || saved.every((n, i) => n === [text, ...masks][i]),
                original,
                translated: range.getBoundingClientRect().toJSON(),
                masks: masks.map((m) => m.getBoundingClientRect().toJSON()),
              };
            });
          },
        });
        return result?.result ?? [];
      }, tabId);
    expect(await read()).toHaveLength(3);
    for (const [windowY, nestedY] of [
      [40, 0],
      [80, 30],
      [60, 15],
      [0, 0],
    ] as const) {
      await page.evaluate(
        ({ windowY, nestedY }) => {
          window.scrollTo(0, windowY);
          const s = document.getElementById('scroller');
          if (s) s.scrollTop = nestedY;
        },
        { windowY, nestedY },
      );
      await page.evaluate(
        () =>
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
      );
      const rows = await read();
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.same, 'pure scroll must not replace fitted paragraphs or masks').toBe(true);
        expect(row.translated.top).toBeCloseTo(row.original.top, 0);
        expect(row.translated.left).toBeCloseTo(row.original.left, 0);
        expect(row.masks[0].top).toBeLessThanOrEqual(row.original.top);
        expect(row.masks[0].bottom).toBeGreaterThanOrEqual(row.original.bottom);
      }
    }
    expect(requests.text).toBe(1);
    expect(requests.images).toEqual([]);
    await page.screenshot({ path: info.outputPath('scroll-stable.png') });
  },
);

for (const fit of ['cover', 'contain'])
  extensionTest(
    `translates ${fit} from original pixels and clips patches inside the padded rounded image`,
    async ({ extensionSession }, info) => {
      const png = await extensionSession.sidePanelPage.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 800;
        c.height = 400;
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('Missing canvas');
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, 200, 400);
        ctx.fillStyle = 'white';
        ctx.fillRect(200, 0, 400, 400);
        ctx.fillStyle = 'blue';
        ctx.fillRect(600, 0, 200, 400);
        ctx.fillStyle = 'black';
        ctx.font = '40px Arial';
        ctx.fillText('HERE', 210, 200);
        return c.toDataURL();
      });
      const { page, panel, tabId, toggle, requests } = await fixture(
        extensionSession,
        `<style>body{margin:0;min-height:2000px;background:white}img{position:absolute;left:200px;top:200px;width:200px;height:200px;object-fit:${fit};object-position:50% 50%;border:10px solid #777;padding:6px;background:#ff0;border-radius:30px}</style><img src="${png}">`,
        {},
      );
      await page.waitForFunction(() => document.images[0]?.naturalWidth === 800);
      await toggle();
      expect(requests.images).toHaveLength(1);
      const imageUrl = requests.images[0];
      if (!imageUrl) throw new Error('Missing image request');
      const pixels = await panel.evaluate(async (url) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = c.getContext('2d');
        if (!ctx) throw new Error('Missing canvas');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return {
          width: c.width,
          height: c.height,
          left: [...ctx.getImageData(2, 2, 1, 1).data],
          right: [...ctx.getImageData(c.width - 3, 2, 1, 1).data],
        };
      }, imageUrl);
      expect(pixels).toEqual({
        width: 400,
        height: fit === 'cover' ? 400 : 200,
        left: fit === 'cover' ? [255, 255, 255, 255] : [255, 0, 0, 255],
        right: fit === 'cover' ? [255, 255, 255, 255] : [0, 0, 255, 255],
      });
      const rect = () =>
        panel.evaluate(async (id) => {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: id },
            func: () => {
              const host = document.querySelector<HTMLElement>(
                '[data-chatbrowserx-overlay=translation]',
              );
              const text =
                host &&
                [
                  ...(chrome.dom.openOrClosedShadowRoot(host)?.querySelectorAll('.text') ?? []),
                ].find((t) => t.textContent === '这里');
              return text?.getBoundingClientRect().toJSON();
            },
          });
          return r?.result;
        }, tabId);
      // At most one CSS pixel of mask margin, including under intrinsic-image scaling.
      expect((await rect())?.left).toBeCloseTo(215, 0);
      expect((await rect())?.top).toBeCloseTo(fit === 'cover' ? 295 : 305.5, 0);
      const screenshot = await page.screenshot({ path: info.outputPath(`${fit}-crop.png`) });
      const padding = await panel.evaluate(
        async (url) => {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob());
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
          if (!ctx) throw new Error('Missing canvas');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return [...ctx.getImageData(214, 300, 1, 1).data];
        },
        `data:image/png;base64,${screenshot.toString('base64')}`,
      );
      expect(padding).toEqual([255, 255, 0, 255]);
      await page.evaluate(() => window.scrollTo(0, 40));
      await expect
        .poll(async () => (await rect())?.top)
        .toBeCloseTo(fit === 'cover' ? 255 : 265.5, 0);
      await page.keyboard.press('Escape');
      await toggle();
      expect(requests.images).toHaveLength(1);
    },
  );

extensionTest(
  'preserves the native gradient underneath text masks instead of painting a flat rectangle',
  async ({ extensionSession }, info) => {
    const { page, panel, tabId, toggle, requests } = await fixture(
      extensionSession,
      `<style>body{margin:0;background:white;font:20px/32px Arial}article{position:absolute;left:150px;top:200px;width:600px;height:180px;padding:20px;border:8px solid #333;background:linear-gradient(to right,rgba(180,80,255,.3),white)}p{margin:0}</style><article><p>A gradient card with a long original sentence and a short translation.</p></article>`,
      { 'A gradient card with a long original sentence and a short translation.': '渐变卡片。' },
    );
    await page.locator('p').evaluate((p) => (p.style.visibility = 'hidden'));
    const baseline = await page.screenshot();
    await page.locator('p').evaluate((p) => (p.style.visibility = ''));
    await toggle();
    const region = await panel.evaluate(async (id) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const mask =
            host && chrome.dom.openOrClosedShadowRoot(host)?.querySelector('.source-mask');
          return mask?.getBoundingClientRect().toJSON();
        },
      });
      return r?.result;
    }, tabId);
    if (!region) throw new Error('Missing gradient mask');
    const translated = await page.screenshot({ path: info.outputPath('gradient-native.png') });
    const maxDifference = await panel.evaluate(
      async ({ before, after, region }) => {
        const contexts = await Promise.all(
          [before, after].map(async (url) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
            if (!ctx) throw new Error('Missing canvas');
            ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
            return ctx;
          }),
        );
        const [original, translated] = contexts;
        if (!original || !translated) throw new Error('Missing comparison pixels');
        let diff = 0;
        // Sample the right-hand mask area, beyond the short Chinese translation.
        for (let x = Math.ceil(region.left + region.width * 0.6); x < region.right - 2; x += 5)
          for (let y = Math.ceil(region.top); y < region.bottom; y++) {
            const a = original.getImageData(x, y, 1, 1).data,
              b = translated.getImageData(x, y, 1, 1).data;
            for (let i = 0; i < 3; i++) {
              const left = a[i],
                right = b[i];
              if (left === undefined || right === undefined) throw new Error('Missing pixel');
              diff = Math.max(diff, Math.abs(left - right));
            }
          }
        return diff;
      },
      {
        before: `data:image/png;base64,${baseline.toString('base64')}`,
        after: `data:image/png;base64,${translated.toString('base64')}`,
        region,
      },
    );
    expect(maxDifference).toBeLessThanOrEqual(1);
    expect(requests.text).toBe(1);
    expect(requests.images).toEqual([]);
  },
);
