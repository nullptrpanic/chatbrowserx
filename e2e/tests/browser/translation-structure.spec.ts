import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';
import { subtractRegions } from '../../../src/page/translation/translation-regions';

extensionTest.use({ extensionHeadless: true });

for (const tag of ['a', 'span', 'div'])
  for (const moving of [false, true])
    extensionTest(
      `uses the same compact budget for nested ${tag} labels with moving=${moving}`,
      async ({ extensionSession }, info) => {
        const long =
          'A very long translated utility label that must keep its icon and original size';
        const prose =
          'This linked paragraph is intentionally much longer after translation and must still reflow across multiple lines of normal prose.';
        const f = await setup(
          extensionSession,
          `<style>
        main{width:520px!important;font:18px/26px Arial}
        .toolbar{display:flex;gap:16px;width:520px;height:30px;white-space:nowrap}
        .cell{display:flex;gap:8px;align-items:center;min-width:0;width:180px;flex:0 1 auto}
        .label{min-width:0}.icon{display:block;background:rgb(255,0,0);width:16px;height:16px;flex:0 0 16px}
        .moving{width:100px;flex:none;${moving ? 'animation:move 1s infinite alternate' : ''}}
        @keyframes move{to{transform:translateX(3px)}}
        p{margin-top:45px!important;white-space:normal;width:320px}
      </style><main><section class="toolbar"><${tag} class="cell" href="#one"><i class="icon"></i><span class="label">普通新闻</span></${tag}>
        <span class="moving">${moving ? '动态内容' : ''}</span>
        <${tag} class="cell" href="#two"><i class="icon"></i><span class="label">下一条</span></${tag}></section>
        <p><a href="#prose">这是普通正文</a></p></main>`,
          { 普通新闻: long, 下一条: 'Another translated utility', 这是普通正文: prose },
        );
        const before = await f.page.locator('main').innerHTML();
        await f.toggle();
        await expect
          .poll(async () => (await f.read()).map((r) => r.text))
          .toEqual([long, 'Another translated utility', prose]);
        const rows = await f.read();
        const [label, next, paragraph] = rows;
        if (!label || !next || !paragraph) throw new Error('Missing translated labels or prose');
        expect(label.font).toBe(18);
        expect(label.paintedBox.bottom - label.paintedBox.top).toBeLessThanOrEqual(27);
        expect(label.paintedBox.right - label.paintedBox.left).toBeGreaterThan(30);
        expect(label.paintedBox.right).toBeLessThanOrEqual(next.paintedBox.left);
        expect(paragraph.box.height).toBeGreaterThan(52);
        const icons = await f.panel.evaluate(
          async (tabId) =>
            (
              await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                  const host = document.querySelector<HTMLElement>(
                    '[data-chatbrowserx-overlay=translation]',
                  );
                  return [
                    ...((host &&
                      chrome.dom
                        .openOrClosedShadowRoot(host)
                        ?.querySelectorAll<HTMLElement>('i')) ||
                      []),
                  ].map((el) => ({
                    width: el.getBoundingClientRect().width,
                    height: el.getBoundingClientRect().height,
                    color: getComputedStyle(el).backgroundColor,
                  }));
                },
              })
            )[0]?.result,
          f.tabId,
        );
        expect(icons).toEqual([
          { width: 16, height: 16, color: 'rgb(255, 0, 0)' },
          { width: 16, height: 16, color: 'rgb(255, 0, 0)' },
        ]);
        expect(await f.page.locator('main').innerHTML()).toBe(before);
        await f.page.screenshot({ path: info.outputPath('compact-and-prose.png') });
      },
    );

extensionTest(
  'translates independent playlist labels beside a live animated indicator',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>@keyframes pulse{from{opacity:.4}to{opacity:1}}.row{display:flex;gap:8px;height:32px}.row a{display:block;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.indicator{display:block;width:10px;height:12px;animation:pulse .5s infinite alternate}</style><main style="width:600px"><canvas width="600" height="100"></canvas><section><div class="row"><i class="indicator"></i><a href="#first">正在播放的新闻</a></div><div class="row"><a href="#next">下一条新闻</a></div></section></main>`,
      {
        正在播放的新闻:
          'The currently playing news headline remains readable next to its live indicator',
        下一条新闻: 'The following news headline also translates independently',
      },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.map((row) => row.text)).toEqual([
      'The currently playing news headline remains readable next to its live indicator',
      'The following news headline also translates independently',
    ]);
    for (const row of rows) {
      expect(row.font).toBe(20);
      const box = row.groupBox;
      if (!box) throw new Error('Translated label must have a structural group');
    }
    // Tiny decorative animations now have a static counterpart in the read-only
    // structure, rather than poisoning a headline which owns the same inline flow.
    const decoration = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const icon = host && chrome.dom.openOrClosedShadowRoot(host)?.querySelector('i');
          return (
            icon && {
              width: icon.getBoundingClientRect().width,
              animation: getComputedStyle(icon).animationName,
            }
          );
        },
      });
      return result?.result;
    }, f.tabId);
    expect(decoration).toEqual({ width: 10, animation: 'none' });
    expect(
      await f.page.locator('.indicator').evaluate((el) => el.getAnimations()[0]?.playState),
    ).toBe('running');
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
  },
);

extensionTest(
  'covers the original overflow footprint when preceding translated prose pushes a table down',
  async ({ extensionSession }, info) => {
    const f = await setup(
      extensionSession,
      '<main style="margin-left:250px;width:500px"><p>标题</p><div style="margin-left:-150px;width:650px;clip-path:inset(-500px 0px -500px -500px)"><table style="width:800px;table-layout:fixed;border-collapse:collapse"><tbody><tr><td style="color:red">原文文字不应透出</td><td>第二列</td></tr></tbody></table></div></main>',
      {
        标题: 'A long English heading which wraps across several lines before the translated table begins.',
        原文文字不应透出: 'X',
        第二列: 'Second column',
      },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    const cell = await f.page.locator('td').first().boundingBox();
    if (!cell) throw new Error('Source cell missing');
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const translatedCell = (await f.read()).find((row) => row.text === 'X');
    expect(translatedCell?.box.top).toBeGreaterThan(cell.y + cell.height);
    const screenshot = await f.page.screenshot({
      path: info.outputPath('reflowed-overflow.png'),
    });
    const residue = await f.panel.evaluate(
      async ({ png, top, height }) => {
        const bitmap = await createImageBitmap(await (await fetch(png)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.drawImage(bitmap, 0, 0);
        // This strip is outside the main flow's left edge and above the translated table.
        // It must contain no source glyphs; the translated red X is below this strip.
        const pixels = ctx.getImageData(110, top, 120, height).data;
        let red = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            (pixels[i] ?? 0) > 160 &&
            (pixels[i + 1] ?? 255) < 100 &&
            (pixels[i + 2] ?? 255) < 100
          )
            red++;
        return red;
      },
      {
        png: `data:image/png;base64,${screenshot.toString('base64')}`,
        top: Math.ceil(cell.y),
        height: Math.floor(cell.height),
      },
    );
    expect(
      residue,
      'Reflow must cover the source overflow as well as the translated overflow',
    ).toBe(0);
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
  },
);

extensionTest(
  'does not reject overlapping overflow decorations that fit within a few structural rectangles',
  async ({ extensionSession }) => {
    const marks = Array.from(
      { length: 40 },
      (_, i) =>
        `<i style="position:absolute;left:0;top:${i * 4.5}px;width:10px;height:2px;background:#ddd"></i>`,
    ).join('');
    const heading =
      'A long English heading which wraps across several lines before the translated content begins.';
    const f = await setup(
      extensionSession,
      `<main style="margin-left:250px;width:500px"><p>标题</p><section style="position:relative;height:180px"><div style="position:absolute;left:-150px;top:0;width:0;height:0">${marks}</div><div style="position:absolute;left:-150px;top:0;width:180px;height:180px;background:#eee"></div><p>内容</p></section></main>`,
      { 标题: heading, 内容: 'Translated content' },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((row) => row.text)).toEqual([heading, 'Translated content']);
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
  },
);

extensionTest(
  'backs transparent left-overflowing structure without leaking the original glyphs',
  async ({ extensionSession }, info) => {
    const f = await setup(
      extensionSession,
      '<main style="margin-left:250px;width:500px"><div style="margin-left:-150px;width:650px;clip-path:inset(-500px 0px -500px -500px)"><table style="width:800px;table-layout:fixed"><tbody><tr><td style="color:red">原文文字不应透出</td><td>第二列</td></tr></tbody></table></div><p>下方正文</p></main>',
      {
        原文文字不应透出: 'X',
        第二列: 'Second column',
        下方正文: 'Following prose',
      },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const screenshot = await f.page.screenshot({
      path: info.outputPath('left-overflow.png'),
    });
    const residue = await f.panel.evaluate(
      async (png) => {
        const bitmap = await createImageBitmap(await (await fetch(png)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(125, 122, 115, 28).data;
        let red = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            (pixels[i] ?? 0) > 160 &&
            (pixels[i + 1] ?? 255) < 100 &&
            (pixels[i + 2] ?? 255) < 100
          )
            red++;
        return red;
      },
      `data:image/png;base64,${screenshot.toString('base64')}`,
    );
    expect(residue, 'Only the short translated X may be red; source glyphs must be covered').toBe(
      0,
    );
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
  },
);

extensionTest(
  'does not crop visible table overflow at the structural island origin',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="margin-left:250px;width:500px"><div style="margin-left:-150px;width:650px;clip-path:inset(-500px 0px -500px -500px)"><table style="width:800px;background:white"><tbody><tr><td>第一列</td><td>第二列</td></tr></tbody></table></div><p>下方正文</p></main>',
      {
        第一列: 'First column',
        第二列: 'Second column',
        下方正文: 'Following prose',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const paintedLeft = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          const group = root?.querySelector<HTMLElement>('.translation-group');
          if (!group) throw new Error('Missing structural island');
          const parts = getComputedStyle(group).clipPath.slice(6, -1).split(/\s+/).map(parseFloat);
          return group.getBoundingClientRect().left + (parts[3] ?? parts[1] ?? parts[0] ?? 0);
        },
      });
      return result?.result;
    }, f.tabId);
    expect(paintedLeft).toBeLessThanOrEqual(100);
    expect((await f.read()).map((row) => row.text)).toContain('First column');
  },
);

extensionTest(
  'keeps a partially inset-clipped table and only collects its visible cells',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="width:500px"><div style="width:360px;clip-path:inset(-500px 0px -500px -500px)"><table style="width:900px;table-layout:fixed"><colgroup><col style="width:300px"><col style="width:300px"><col style="width:300px"></colgroup><tbody><tr><td>第一列</td><td>第二列</td><td>不应发送的隐藏列</td></tr></tbody></table></div><p>表格之后的正文</p></main>',
      {
        第一列: 'The first column has enough translated text to wrap naturally onto another line.',
        第二列: 'Second column',
        表格之后的正文: 'Prose following the table',
      },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.text)).toContain('Second column');
    expect(f.requests.flatMap((request) => request.texts)).not.toContain('不应发送的隐藏列');
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
  },
);

extensionTest(
  'does not promote loose body text into a whole-page layout island',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<h1>标题</h1>9/6/2026<p>文章正文</p><input value="private draft">',
      {
        标题: 'Article title',
        '9/6/2026': '9/6/2026',
        文章正文: 'Article body',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((row) => row.text)).toEqual(['Article title', 'Article body']);
  },
);

extensionTest(
  'keeps every item of a non-shrinking link row inside the viewport',
  async ({ extensionSession }) => {
    const translations = {
      要闻: 'Latest international news',
      热问: 'Trending community questions',
      电视剧: 'Television drama series',
      房产: 'Residential real estate',
    };
    const f = await setup(
      extensionSession,
      `<main style="width:600px"><ul style="display:flex;align-items:center;height:52px;margin:0;padding:0;list-style:none">${Object.keys(
        translations,
      )
        .map(
          (t, i) =>
            `<li style="flex-shrink:0;margin-right:34px"><a ${i < 3 ? 'href="#item"' : ''} style="display:inline-block;font:18px/20px Arial">${t}</a></li>`,
        )
        .join('')}</ul></main>`,
      translations,
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.ownerBox.right).toBeLessThanOrEqual(661);
      expect(row.paintedBox.right).toBeLessThanOrEqual(661);
      expect(row.ownerBox.height).toBeLessThanOrEqual(22);
      expect(row.font).toBe(18);
    }
    for (const [i, row] of rows.entries()) {
      const previous = rows[i - 1];
      if (previous) expect(row.ownerBox.left - previous.ownerBox.right).toBeLessThanOrEqual(18);
    }
  },
);

extensionTest(
  'does not cover a live form control embedded in a text owner',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><label><input type="checkbox" checked>启用</label><p>独立正文</p></main>',
      { '<m0>启用</m0>': '<m0>Enable</m0>', 独立正文: 'Independent text' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect((await f.read()).map((row) => row.text)).toEqual(['Independent text']);
    await expect(f.page.locator('input')).toBeChecked();
  },
);

extensionTest(
  'lets auto-width flex labels use native word wrapping',
  async ({ extensionSession }) => {
    const translations = {
      要闻: 'Top News',
      热问: 'Trending Questions',
      电视剧: 'TV Dramas',
      房产: 'Real Estate',
    };
    const f = await setup(
      extensionSession,
      `<main style="width:350px"><ul style="display:flex;justify-content:space-between;align-items:center;gap:12px;height:52px;margin:0;padding:0;list-style:none">${Object.keys(
        translations,
      )
        .map((t) => `<li><a style="display:inline-block;font:18px/20px Arial">${t}</a></li>`)
        .join('')}</ul></main>`,
      translations,
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.box.right).toBeLessThanOrEqual(411);
      expect(row.box.height).toBeLessThanOrEqual(42);
      expect(row.font).toBe(18);
    }
  },
);

extensionTest(
  'scrolls the document through overscroll rules on non-scrolling ancestors',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>*{overscroll-behavior:none}</style><main><a href="#link" style="display:block;height:80px">链接</a><div style="height:2000px"></div></main>',
      { 链接: 'Translated link' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.mouse.move(100, 140);
    await f.page.mouse.wheel(0, 280);
    await expect.poll(() => f.page.evaluate(() => scrollY)).toBeGreaterThan(200);
  },
);

extensionTest(
  'preserves native multi-line clamping and single-line inline badges',
  async ({ extensionSession }) => {
    const long =
      'A long translated news description that should use at most two lines before the browser displays its native ellipsis. '.repeat(
        3,
      );
    const f = await setup(
      extensionSession,
      `<main><p style="width:240px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font:16px/24px Arial">新闻摘要</p><p><span style="display:inline-block;width:30px;height:18px;font:12px/18px Arial;background:blue;color:white;vertical-align:middle">专题</span></p></main>`,
      { 新闻摘要: long, 专题: 'Featured story' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read(),
      prose = rows.find((r) => r.text === long),
      badge = rows.find((r) => r.text === 'Featured story');
    expect(prose?.ownerBox.height).toBe(48);
    expect(badge?.box.height).toBeLessThanOrEqual(18);
    expect(badge?.box.right).toBeLessThanOrEqual(badge?.ownerBox.right ?? 0);
  },
);

extensionTest(
  'does not clip out-of-flow navigation in a zero-height ancestor',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<header style="height:0"><nav style="position:absolute;top:24px;left:24px;display:flex"><a>新闻</a></nav></header><input style="margin-top:100px">',
      { 新闻: 'News' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const row = (await f.read())[0];
    expect(row?.groupBox.bottom).toBeGreaterThanOrEqual(row?.box.bottom ?? Infinity);
    expect(row?.groupBox.height).toBeGreaterThan(0);
  },
);

extensionTest(
  'paints the full width of an overflowing table inside its source scrollport',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main style="width:360px"><table style="width:2px;table-layout:fixed"><colgroup><col style="width:180px"><col style="width:360px"></colgroup><tbody><tr><td>左列</td><td>右列</td></tr></tbody></table></main>`,
      {
        左列: 'Left column',
        右列: 'The entire wider column remains visible in the reading copy',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const row = (await f.read()).find((r) => r.text?.startsWith('The entire'));
    expect(row).toBeDefined();
    if (!row) throw new Error('Translated table text missing');
    const backgrounds = await f.panel.evaluate(async (tabId) => {
      const [reply] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [
            ...(root?.querySelectorAll('.translation-group,.translation-overflow-background') ??
              []),
          ].map((el) => el.getBoundingClientRect().toJSON());
        },
      });
      return reply?.result ?? [];
    }, f.tabId);
    // A local overflow rectangle must cover the wider table, not widen the opaque
    // backdrop for every other row (which would cover unrelated gutter annotations).
    expect(subtractRegions(row.box, backgrounds)).toHaveLength(0);
  },
);

extensionTest(
  'keeps a read-only table coherent around invisible editor sentinels',
  { tag: '@smoke' },
  async ({ extensionSession }) => {
    const long =
      'A complete translated explanation that needs several lines inside a narrow table cell and must push the following row down.';
    const f = await setup(
      extensionSession,
      `<main style="width:400px" contenteditable="true"><table style="width:400px;table-layout:fixed;border-collapse:collapse"><tbody>
    <tr><td style="width:180px;overflow:hidden;padding:8px;border:1px solid gray"><span>\u200b</span><div contenteditable="false">说明</div><span>\ufeff</span></td><td><div contenteditable="false">用途</div></td></tr>
    <tr><td style="overflow:hidden;padding:8px;border:1px solid gray"><span>\u200b</span><div contenteditable="false">下一行</div></td><td></td></tr>
    </tbody></table></main>`,
      { 说明: long, 用途: 'Purpose', 下一行: 'Next row' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read(),
      first = rows.find((r) => r.text === long),
      next = rows.find((r) => r.text === 'Next row');
    expect(first?.paintedBox.bottom).toBeGreaterThanOrEqual((first?.box.bottom ?? Infinity) - 1);
    expect(next?.box.top).toBeGreaterThan((first?.box.bottom ?? Infinity) + 8);
  },
);

extensionTest(
  'keeps compact headlines translated without covering neighboring live media',
  async ({ extensionSession }) => {
    const long = 'A translated headline that is longer than the original compact news label';
    const f = await setup(
      extensionSession,
      `<main style="width:600px"><section id="news" style="display:flex;gap:20px"><div style="width:380px"><div style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;text-overflow:ellipsis"><a href="#news">新闻标题</a></div></div><div style="width:200px"><a href="#product">产品推荐</a></div></section><section style="margin-top:12px;display:flex;gap:20px"><p style="width:280px">下方正文</p><canvas width="280" height="80"></canvas></section></main>`,
      { 新闻标题: long, 产品推荐: 'Products', 下方正文: 'Other text' },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.map((r) => r.text)).toEqual([long, 'Products', 'Other text']);
    expect(rows.find((r) => r.text === long)?.font).toBe(20);
    const next = await f.page.locator('canvas').boundingBox();
    if (!next) throw new Error('Native surface missing');
    expect(rows.find((r) => r.text === long)?.groupBox.bottom).toBeLessThanOrEqual(next.y);
    expect(await f.page.locator('main').evaluate((el) => el.outerHTML)).toBe(source);
  },
);

extensionTest(
  'limits a layout fallback to the conflicting column instead of its safe sibling',
  async ({ extensionSession }) => {
    const long = 'A very long translated title '.repeat(12);
    const f = await setup(
      extensionSession,
      `<main style="width:600px"><section style="display:flex;gap:20px"><div style="width:280px"><h2 style="font:20px/28px Arial;margin:0">标题</h2></div><div style="width:280px"><a href="#product">产品推荐</a></div></section><section style="margin-top:12px;display:flex;gap:20px"><p style="width:280px">下方正文</p><canvas width="280" height="80"></canvas></section></main>`,
      { 标题: long, 产品推荐: 'Products', 下方正文: 'Other text' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    const rows = await f.read();
    expect(rows.map((r) => r.text)).not.toContain(long);
    expect(rows.map((r) => r.text)).toContain('Products');
    expect(rows.map((r) => r.text)).toContain('Other text');
    expect(await f.page.locator('h2').textContent()).toBe('标题');
    const rejections = () =>
      f.panel.evaluate(async (tabId) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const layer =
              host &&
              chrome.dom
                .openOrClosedShadowRoot(host)
                ?.querySelector<HTMLElement>('[data-translation-rejections]');
            return layer?.dataset.translationRejections;
          },
        });
        return result?.result;
      }, f.tabId);
    expect(await rejections()).toContain('peer-overlap');
    expect(await rejections()).not.toContain('标题');
    const calls = f.requests.length;
    await f.page.locator('canvas').evaluate((el) => el.remove());
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain(long);
    await expect.poll(rejections).toBe('[]');
    expect(f.requests.length).toBe(calls);
  },
);

extensionTest(
  'synchronizes existing translations in the scroll event before another animation frame',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<div id="port" style="position:fixed;inset:30px;overflow:auto"><main><p>滚动正文</p><div style="height:1800px"></div></main></div>`,
      { 滚动正文: 'Scrolling text' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const result = await f.panel.evaluate(async (tabId) => {
      const [response] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const shadow = host && chrome.dom.openOrClosedShadowRoot(host);
          const group = shadow?.querySelector('.translation-group');
          const port = document.querySelector('#port');
          const source = document.querySelector('main');
          if (!shadow || !group || !port || !source) throw new Error('Scroll fixture missing');
          const offset = group.getBoundingClientRect().top - source.getBoundingClientRect().top;
          const errors = [];
          for (const top of [40, 90, 140, 70, 0]) {
            port.scrollTop = top;
            port.dispatchEvent(new Event('scroll'));
            errors.push(
              Math.abs(
                group.getBoundingClientRect().top - source.getBoundingClientRect().top - offset,
              ),
            );
          }
          return {
            errors,
            retained: group === shadow.querySelector('.translation-group'),
          };
        },
      });
      return response?.result;
    }, f.tabId);
    expect(result?.retained).toBe(true);
    expect(Math.max(...(result?.errors ?? [Infinity]))).toBeLessThan(1);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect(f.requests.flatMap((r) => r.texts)).toEqual(['滚动正文']);
  },
);

extensionTest(
  'keeps the same translation aligned during continuous native wheel scrolling',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>连续滚动</p><div style="height:1800px"></div></main>',
      { 连续滚动: 'Continuous scrolling' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.panel.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const shadow = host && chrome.dom.openOrClosedShadowRoot(host);
          const group = shadow?.querySelector('.translation-group');
          const source = document.querySelector('main');
          if (!group || !source) throw new Error('Scroll fixture missing');
          const offset = group.getBoundingClientRect().top - source.getBoundingClientRect().top;
          const result = { events: 0, frames: 0, maxOffset: 0, retained: true };
          let animation = 0;
          const measure = () => {
            result.retained &&= group.isConnected;
            result.maxOffset = Math.max(
              result.maxOffset,
              Math.abs(
                group.getBoundingClientRect().top - source.getBoundingClientRect().top - offset,
              ),
            );
          };
          const scroll = () => {
            result.events++;
            measure();
          };
          const tick = () => {
            result.frames++;
            measure();
            animation = requestAnimationFrame(tick);
          };
          window.addEventListener('scroll', scroll, true);
          animation = requestAnimationFrame(tick);
          Object.assign(globalThis, {
            stopTranslationScrollTest: () => {
              window.removeEventListener('scroll', scroll, true);
              cancelAnimationFrame(animation);
              return result;
            },
          });
        },
      });
    }, f.tabId);
    await f.page.mouse.move(600, 450);
    for (const direction of [1, -1])
      for (let step = 0; step < 12; step++) {
        await f.page.mouse.wheel(0, direction * 20);
        await f.page.waitForTimeout(20);
      }
    const result = await f.panel.evaluate(async (tabId) => {
      const [response] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const state = globalThis as typeof globalThis & {
            stopTranslationScrollTest?: () => {
              events: number;
              frames: number;
              maxOffset: number;
              retained: boolean;
            };
          };
          const result = state.stopTranslationScrollTest?.();
          delete state.stopTranslationScrollTest;
          return result;
        },
      });
      return response?.result;
    }, f.tabId);
    expect(result?.events).toBeGreaterThanOrEqual(20);
    expect(result?.frames).toBeGreaterThan(20);
    expect(result?.maxOffset).toBeLessThan(1);
    expect(result?.retained).toBe(true);
    expect(f.requests).toHaveLength(1);
  },
);

extensionTest(
  'keeps overflow backing and fixed watermarks aligned throughout scrolling',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<div id="port" style="position:fixed;top:40px;left:0;width:1000px;height:300px;overflow:auto"><main style="margin-left:250px;width:500px"><div style="margin-left:-150px;width:650px"><table style="width:800px;height:900px;table-layout:fixed"><tbody><tr><td style="vertical-align:top">首列</td><td style="vertical-align:top">次列</td></tr></tbody></table></div></main></div><div class="ssrWaterMark" style="position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(45deg,transparent,#eeeeee44)"></div>`,
      { 首列: 'First', 次列: 'Second' },
      'https://fixture.larkoffice.com/docx/scroll-backing',
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const results = await f.panel.evaluate(async (tabId) => {
      const [response] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          const port = document.querySelector('#port');
          if (!root || !port) throw new Error('Scroll fixture missing');
          return [80, 160, 40].map((top) => {
            port.scrollTop = top;
            port.dispatchEvent(new Event('scroll'));
            return {
              backed: [...root.querySelectorAll('.translation-overflow-background')].some((el) => {
                const r = el.getBoundingClientRect();
                return r.left <= 110 && r.right >= 110 && r.top <= 250 && r.bottom >= 250;
              }),
              watermarks: [...root.querySelectorAll('.translation-watermark')].map(
                (el) => el.getBoundingClientRect().top,
              ),
            };
          });
        },
      });
      return response?.result;
    }, f.tabId);
    expect(results).toHaveLength(3);
    for (const result of results ?? []) {
      expect(result.backed).toBe(true);
      expect(result.watermarks.length).toBeGreaterThan(0);
      result.watermarks.forEach((top) => expect(top).toBeCloseTo(0, 1));
    }
  },
);

extensionTest(
  'leaves an expanding mixed-media island native before covering its next section',
  async ({ extensionSession }) => {
    const long = 'A very long translated title '.repeat(12);
    const f = await setup(
      extensionSession,
      `<main style="width:600px"><section style="width:280px"><h2 style="font:20px/28px Arial;margin:0">标题</h2></section><section style="margin-top:12px;display:flex;gap:20px"><p style="width:280px">下方正文</p><canvas width="280" height="80"></canvas></section></main>`,
      { 标题: long, 下方正文: 'Other text' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    const rows = await f.read();
    expect(rows.map((r) => r.text)).not.toContain(long);
    expect(rows.map((r) => r.text)).toContain('Other text');
    expect(await f.page.locator('h2').textContent()).toBe('标题');
  },
);

for (const translation of ['Vote', 'Upvote'])
  extensionTest(
    `retains a nonzero display-contents child with ${translation === 'Vote' ? 'fitting' : 'overflowing'} label`,
    async ({ extensionSession }, info) => {
      const f = await setup(
        extensionSession,
        '<main style="display:flex;gap:20px"><div style="display:contents"><button style="font:16px/24px Arial;padding:8px">赞同</button></div><input value="draft"></main>',
        { 赞同: translation },
      );
      const source = await f.page.locator('main').innerHTML();
      const input = await f.page.locator('input').boundingBox();
      await f.toggle();
      const fitting = translation === 'Vote';
      await expect(f.lens).toHaveAttribute('data-status', fitting ? 'ready' : 'unsupported');
      const copy = await f.panel.evaluate(async (tabId) => {
        const [response] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const button = root?.querySelector('button');
            if (!button) throw new Error('The button must have a nonzero safe copy');
            const range = document.createRange();
            range.selectNodeContents(button);
            const ink = range.getBoundingClientRect();
            const box = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return {
              text: button.textContent,
              width: box.width,
              sourceWidth: document.querySelector('button')?.getBoundingClientRect().width,
              font: style.fontSize,
              leading: style.lineHeight,
              contained: ink.left >= box.left && ink.right <= box.right,
            };
          },
        });
        return response?.result;
      }, f.tabId);
      expect(copy?.text).toBe(fitting ? translation : '赞同');
      expect(copy?.width).toBeGreaterThan(50);
      expect(copy?.width).toBe(copy?.sourceWidth);
      expect(copy?.font).toBe('16px');
      expect(copy?.leading).toBe('24px');
      expect(copy?.contained).toBe(true);
      expect((await f.read()).map((row) => row.text)).toEqual(fitting ? [translation] : []);
      expect(await f.page.locator('main').innerHTML()).toBe(source);
      expect(await f.page.locator('input').boundingBox()).toEqual(input);
      await f.page.screenshot({ path: info.outputPath(`display-contents-${translation}.png`) });
    },
  );

extensionTest(
  'scrolls the source scrollport when wheeling over a translated link',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<div id="port" style="position:fixed;inset:0;overflow:auto"><main><a style="display:block;height:100px" href="#link">链接</a><div style="height:1500px"></div></main></div>`,
      { 链接: 'Translated link' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.mouse.move(160, 160);
    await f.page.mouse.wheel(0, 120);
    await expect
      .poll(() => f.page.locator('#port').evaluate((el) => el.scrollTop))
      .toBeGreaterThan(100);
  },
);

extensionTest(
  'translates dimmed labels without treating hidden icon tooltips as unsupported text',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main><a style="display:inline-block;opacity:.5">编码器</a><div style="transform:translateY(-3px)"><svg width="20" height="20"><circle cx="10" cy="10" r="6"/></svg><span style="visibility:hidden">Hidden tooltip</span><span style="opacity:0">Invisible tooltip</span></div></main>`,
      { 编码器: 'Encoder' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(['Encoder']);
    expect(f.requests.flatMap((r) => r.texts)).toEqual(['编码器']);
  },
);

extensionTest(
  'preserves ancestor CSS zoom without fitting the translated font',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<div style="zoom:.9"><main><nav style="display:flex;height:52px;font:20px/28px Arial"><a>新闻</a></nav></main></div>',
      { 新闻: 'News' },
    );
    const source = await f.page.locator('nav').boundingBox();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const row = (await f.read())[0];
    expect(row?.font).toBe(20);
    expect(row?.ownerBox.height).toBeCloseTo(source?.height ?? NaN, 0);
    expect(row?.box.height).toBeLessThan(23);
    expect(row?.box.top).toBeLessThan((source?.y ?? 0) + 10);
  },
);

extensionTest(
  'reflows adjacent flex sections in one bounded flow',
  async ({ extensionSession }) => {
    const long =
      'A much longer translated heading that occupies several lines in the original narrow column and pushes the next section down.';
    const f = await setup(
      extensionSession,
      '<main style="width:300px"><section style="display:flex"><h2 style="font:20px/28px Arial;margin:0">第一部分</h2></section><section style="display:flex;margin-top:12px"><h2 style="font:20px/28px Arial;margin:0">第二部分</h2></section></main>',
      { 第一部分: long, 第二部分: 'Next section' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    const first = rows.find((r) => r.text === long),
      next = rows.find((r) => r.text === 'Next section');
    expect(next?.box.top).toBeGreaterThanOrEqual((first?.box.bottom ?? Infinity) + 12);
  },
);

extensionTest('anchors a standalone sticky footer exactly once', async ({ extensionSession }) => {
  const f = await setup(
    extensionSession,
    `<style>body{height:100vh;overflow:auto;margin:0}.spacer{height:860px}footer{position:sticky;bottom:0;height:40px;background:#eee;font:16px/24px Arial}</style><div class="spacer"></div><footer>关于我们</footer>`,
    { 关于我们: 'About us' },
  );
  const source = await f.page.locator('footer').boundingBox();
  await f.toggle();
  await expect(f.lens).toHaveAttribute('data-status', 'ready');
  const row = (await f.read()).find((r) => r.text === 'About us');
  expect(row?.ownerBox.y).toBe(source?.y);
  expect(row?.ownerBox.height).toBe(source?.height);
});

extensionTest(
  'preserves fixed table columns and an external sticky scrollport',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
    body{margin:0}.scrollport{position:fixed;inset:64px 0 0;overflow:auto}
    main{width:600px!important;margin:0!important;font:16px/24px Arial}
    .spacer{height:180px}.heading{position:sticky;top:26px;background:#eee;height:40px}
    table{width:2px;table-layout:fixed;border-collapse:collapse}td{min-width:50px;padding:8px;border:1px solid #ccc;overflow:hidden;word-break:break-word}
    </style><div class="scrollport"><main class="page-block root-block">
    <div class="spacer"></div><div class="heading zone-container text-editor" contenteditable="true"><div class="ace-line">字段说明</div></div>
    <table><colgroup><col style="width:196.5px"><col style="width:403.5px"></colgroup><tbody><tr>
    <td><div class="zone-container text-editor" contenteditable="true"><div class="ace-line">用户</div></div></td>
    <td><div class="zone-container text-editor" contenteditable="true"><div class="ace-line">追踪上下文</div></div></td>
    </tr></tbody></table><div style="height:1000px"></div></main></div>`,
      {
        字段说明: 'Field descriptions',
        用户: 'User',
        追踪上下文:
          'Associate each request with its user, trace, and audit context without changing the source document.',
      },
      'https://fixture.larkoffice.com/docx/fixed-columns',
    );
    await f.page.locator('.scrollport').evaluate((el) => {
      el.scrollTop = 160;
    });
    const original = await f.page
      .locator('td')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const columns = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll('td') ?? [])].map(
            (el) => el.getBoundingClientRect().width,
          );
        },
      });
      return result?.result;
    }, f.tabId);
    expect(columns).toHaveLength(2);
    columns?.forEach((width, i) => expect(width).toBeCloseTo(original[i] ?? NaN, 1));
    const heading = (await f.read()).find((r) => r.text === 'Field descriptions');
    expect(heading?.ownerBox.y).toBe(90);
  },
);

extensionTest(
  'keeps a translated button readable without collapsing its source height',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><button style="height:48px;width:110px;font:16px/20px Arial">搜索</button><i style="display:inline-block;transform:translateY(-2px)">&#xe001;</i></main>',
      { 搜索: 'Search' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const button = (await f.read()).find((r) => r.text === 'Search');
    expect(button?.ownerBox.height).toBeGreaterThanOrEqual(48);
    expect(button?.font).toBe(16);
  },
);

extensionTest(
  'uses the native single-line headline contract before any fitting',
  async ({ extensionSession }, info) => {
    const headlines = ['第一条新闻', '第二条新闻'] as const;
    const translations = [
      'Undergraduates return to vocational colleges to retrain for a completely different career',
      'Another considerably longer English headline must keep the exact same typography',
    ] as const;
    const f = await setup(
      extensionSession,
      `<main><style>
    ul{list-style:none;margin:0;padding:0;width:480.5px;font:16px/36px Arial}
    li{display:flex;align-items:center;gap:12px;height:36px}
    a{display:block;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#222}
    i{flex:none;font:12px/18px Arial;background:orange;color:white}
    </style><ul>${headlines.map((text, i) => `<li><b aria-hidden="true">${i + 1}</b><a href="#${i}">${text}</a><i>热</i></li>`).join('')}</ul></main>`,
      {
        [headlines[0]]: translations[0],
        [headlines[1]]: translations[1],
        热: 'Hot',
      },
    );
    const original = await f.page.locator('main').evaluate((el) => ({
      html: el.outerHTML,
      box: el.getBoundingClientRect().toJSON(),
    }));
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    for (const text of translations) {
      const row = rows.find((r) => r.text === text);
      expect(row, text).toBeDefined();
      expect(row?.font).toBe(16);
      // Original single-line list stays single-line even when there is room to squeeze two lines.
      expect(row?.box.height).toBeLessThan(25);
    }
    expect(
      await f.page.locator('main').evaluate((el) => ({
        html: el.outerHTML,
        box: el.getBoundingClientRect().toJSON(),
      })),
    ).toEqual(original);
    await f.page.screenshot({
      path: info.outputPath('single-line-headlines.png'),
    });
  },
);

for (const route of ['docx', 'wiki'])
  extensionTest(
    `reflows ${route} document table rows and following prose together at the source font size`,
    async ({ extensionSession }, info) => {
      const long =
        'Identify the sandbox creator and associate each request with its user, trace, and audit context without changing the source document.';
      const f = await setup(
        extensionSession,
        `<main class="page-block root-block" contenteditable="true"><style>
    main{width:540.5px!important;font:16px/24px Arial}
    table{width:100%;table-layout:fixed;border-collapse:collapse}td,th{border:1px solid #aaa;padding:8px;vertical-align:top}
    .ace-line{min-height:24px}.next{margin-top:20px}input{display:none}
    </style><table><colgroup><col style="width:30%"><col style="width:70%"></colgroup>
    <tbody><tr><th colspan="2"><div class="zone-container text-editor" contenteditable="true"><div class="ace-line">字段说明</div></div></th></tr>
    <tr><td rowspan="2"><div class="zone-container text-editor" contenteditable="true"><div class="ace-line">用户</div></div></td><td><div class="zone-container text-editor" contenteditable="true"><div class="ace-line">追踪上下文</div></div></td></tr>
    <tr><td><div class="zone-container text-editor" contenteditable="true"><div class="ace-line">审计</div></div></td></tr></tbody></table>
    <div class="next zone-container text-editor" contenteditable="true"><p class="ace-line">下一段</p></div><input value="private draft"></main>`,
        {
          字段说明: 'Field descriptions',
          用户: 'User',
          追踪上下文: long,
          审计: 'Audit',
          下一段: 'The next paragraph follows the complete table.',
        },
        `https://fixture.larkoffice.com/${route}/structure`,
      );
      const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', 'ready');
      const rows = await f.read();
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.font === 16)).toBe(true);
      const measured = await f.panel.evaluate(async (tabId) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const table = root?.querySelector('table');
            const cells = [...(table?.querySelectorAll('td,th') ?? [])];
            return {
              cells: cells.map((el) => ({
                text: el.textContent,
                box: el.getBoundingClientRect().toJSON(),
                colspan: el.getAttribute('colspan'),
                rowspan: el.getAttribute('rowspan'),
              })),
              table: table?.getBoundingClientRect().toJSON(),
              next: [...(root?.querySelectorAll('.text') ?? [])]
                .find((el) => el.textContent?.startsWith('The next paragraph'))
                ?.getBoundingClientRect()
                .toJSON(),
              editable: root?.querySelectorAll('[contenteditable],input,script,iframe').length,
            };
          },
        });
        return result?.result;
      }, f.tabId);
      expect(measured?.cells).toHaveLength(4);
      expect(measured?.cells[0]?.colspan).toBe('2');
      expect(measured?.cells[1]?.rowspan).toBe('2');
      expect(measured?.cells[2]?.text).toBe(long);
      expect(measured?.cells[3]?.box.top).toBeGreaterThanOrEqual(
        measured?.cells[2]?.box.bottom ?? Infinity,
      );
      expect(measured?.next?.top).toBeGreaterThan(measured?.table?.bottom ?? Infinity);
      expect(measured?.editable).toBe(0);
      expect(await f.page.locator('main').evaluate((el) => el.outerHTML)).toBe(original);
      expect(JSON.stringify(f.requests)).not.toContain('private draft');
      await f.page.screenshot({
        path: info.outputPath('document-table-flow.png'),
      });
    },
  );
