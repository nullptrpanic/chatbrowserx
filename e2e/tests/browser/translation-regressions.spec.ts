import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'does not cover an excluded fixed input between two normal paragraphs',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>第一段</p><input aria-label="Draft" value="private draft" style="position:fixed;left:300px;top:220px;width:200px;height:40px"><p style="margin-top:200px">第二段</p></main>',
      { 第一段: 'First paragraph', 第二段: 'Second paragraph' },
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const covered = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll('.translation-group') ?? [])].some((group) => {
            const r = group.getBoundingClientRect();
            return r.left < 320 && r.right > 320 && r.top < 240 && r.bottom > 240;
          });
        },
      });
      return result?.result;
    }, f.tabId);
    expect(covered).toBe(false);
    expect((await f.read()).map((r) => r.text)).toEqual(['First paragraph', 'Second paragraph']);
    expect(f.requests.flatMap((r) => r.texts)).not.toContain('private draft');
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'keeps table flow growing independently of a fixed descendant header',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>table{width:100%;table-layout:fixed;border-collapse:collapse}td{border:1px solid #aaa;padding:8px}section{position:relative}#fixed{position:fixed;top:20px;left:60px;width:900px;height:28px;background:#ddd;z-index:10}p{margin:24px 0!important}</style><main><section><div id="fixed">固定表头</div><table><tbody><tr><td>模块</td><td>职责</td></tr></tbody></table></section><p>下一段正文</p><section><table><tbody><tr><td>下一张表格</td></tr></tbody></table></section><div style="height:1200px"></div></main>',
      {
        固定表头: 'Pinned table heading',
        模块: 'Network module',
        职责: 'Preserve all request metadata and audit records while forwarding intercepted traffic to its intended destination. '
          .repeat(5)
          .trim(),
        下一段正文: 'Following paragraph',
        下一张表格: 'The following table',
      },
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const check = async () => {
      const rows = await f.read();
      for (const text of [
        'Pinned table heading',
        'Network module',
        'Following paragraph',
        'The following table',
      ])
        expect(rows.filter((r) => r.text === text)).toHaveLength(1);
      const detail = rows.find((r) => r.text?.startsWith('Preserve all'));
      const paragraph = rows.find((r) => r.text === 'Following paragraph');
      expect(paragraph?.box.top).toBeGreaterThan(detail?.box.bottom ?? Infinity);
      const last = rows.find((r) => r.text === 'The following table');
      expect(last?.box.top).toBeGreaterThan(paragraph?.box.bottom ?? Infinity);
      expect(rows.every((r) => r.font === 20)).toBe(true);
    };
    await check();
    await f.page.mouse.wheel(0, 80);
    await expect
      .poll(async () => (await f.read()).some((r) => r.text === 'The following table'))
      .toBe(true);
    await check();
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'does not flatten an originally multi-row floated link list into a navigation strip',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.links{display:flow-root;width:150px}.links>a{float:left;width:70px;line-height:28px}</style><main><div class="links"><a href="#1">新闻</a><a href="#2">体育</a><a href="#3">科技</a><a href="#4">教育</a></div></main>',
      { 新闻: 'News', 体育: 'Sport', 科技: 'Tech', 教育: 'School' },
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.map((row) => row.text)).toEqual(['News', 'Sport', 'Tech', 'School']);
    expect(rows[2]?.box.top).toBeGreaterThanOrEqual((rows[0]?.box.top ?? NaN) + 28);
    for (const row of rows) expect(row.font).toBe(20);
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'keeps an originally single-line floated link row readable beside independent content',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.links{float:left;width:300px;height:28px}.links>a{float:left;display:block;margin-right:14px;color:black}</style><header style="margin:60px;height:28px"><div class="links"><a href="#news">新闻</a><a href="#sports">体育</a><a href="#technology">科技</a><a href="#education">教育</a></div><input style="float:left;width:200px" aria-label="Search"></header><main style="margin-top:0"><p>正文</p></main>',
      {
        新闻: 'International news headlines',
        体育: 'Sports and competitions',
        科技: 'Technology and innovation',
        教育: 'Education and learning',
        正文: 'Article text',
      },
    );
    const source = await f.page.locator('.links').boundingBox();
    const original = await f.page.locator('header').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.map((row) => row.text)).toEqual([
      'International news headlines',
      'Sports and competitions',
      'Technology and innovation',
      'Education and learning',
      'Article text',
    ]);
    for (const [index, row] of rows.slice(0, 4).entries()) {
      expect(row.font).toBe(20);
      expect(row.paintedBox.right).toBeLessThanOrEqual((source?.x ?? NaN) + (source?.width ?? NaN));
      expect(row.paintedBox.top).toBeGreaterThanOrEqual(source?.y ?? NaN);
      expect(row.paintedBox.bottom).toBeLessThanOrEqual(
        (source?.y ?? NaN) + (source?.height ?? NaN),
      );
      const previous = rows[index - 1];
      if (previous)
        expect(row.paintedBox.left - previous.paintedBox.right).toBeGreaterThanOrEqual(9.5);
    }
    await expect(f.page.locator('header')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'translates a dense visible link grid in batches without dropping late source IDs',
  async ({ extensionSession }) => {
    const translations = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`栏目${i}`, `Topic ${i}`]),
    );
    const f = await setup(
      extensionSession,
      '<main style="font-size:16px;display:grid;grid-template-columns:repeat(10,1fr)">' +
        Object.keys(translations)
          .map((label, i) => `<a href="#${i}">${label}</a>`)
          .join('') +
        '</main>',
      translations,
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((row) => row.text)).toEqual(Object.values(translations));
    expect(f.requests.every((request) => request.texts.length <= 32)).toBe(true);
    await f.page.keyboard.press('Escape');
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((row) => row.text)).toEqual(Object.values(translations));
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'preserves readable gaps when translated flex labels fit but consume the distributed space',
  async ({ extensionSession }) => {
    const labels = ['Blog', 'Columns', 'Features'];
    const f = await setup(
      extensionSession,
      '<main><ul style="display:flex;justify-content:space-between;padding:0;list-style:none"><li style="white-space:nowrap"><a href="#blog">博客</a></li><li style="white-space:nowrap"><a href="#columns">专栏</a></li><li style="white-space:nowrap"><a href="#features">专题</a></li></ul></main>',
      { 博客: 'Blog', 专栏: 'Columns', 专题: 'Features' },
    );
    // Fixture geometry: translated labels fit, leaving four pixels between each pair.
    // An overflow-only repair cannot detect that their original spacing disappeared.
    await f.page.locator('ul').evaluate((el, labels) => {
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('Missing font measurement');
      context.font = '20px Arial';
      el.style.width = `${labels.reduce((sum, label) => sum + context.measureText(label).width, 0) + 8}px`;
    }, labels);
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.font).toBe(20);
    for (let i = 1; i < rows.length; i++) {
      const before = rows[i - 1],
        after = rows[i];
      if (!before || !after) throw new Error('Missing adjacent label');
      expect(after.paintedBox.left - before.paintedBox.right).toBeGreaterThanOrEqual(9.5);
    }
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'keeps a fixed native control above a sliced sibling flow inside the same parent',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="width:500px"><p>第一段</p><p>第二段</p><div style="position:fixed;left:300px;top:150px;background:white;z-index:20"><input aria-label="Draft" value="private draft"></div></main>',
      { 第一段: 'First paragraph', 第二段: 'Second paragraph' },
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const covered = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          const group = root?.querySelector<HTMLElement>('.translation-group');
          if (!group) throw new Error('Missing translation');
          const clip = group.style.clipPath;
          if (!clip.startsWith('path(')) return true;
          const box = group.getBoundingClientRect();
          const context = new OffscreenCanvas(1, 1).getContext('2d');
          if (!context) throw new Error('Missing path measurement');
          return context.isPointInPath(
            new Path2D(JSON.parse(clip.slice(5, -1))),
            320 - box.x,
            155 - box.y,
          );
        },
      });
      return result?.result;
    }, f.tabId);
    expect(covered).toBe(false);
    expect((await f.read()).map((r) => r.text)).toEqual(['First paragraph', 'Second paragraph']);
    expect(f.requests.flatMap((r) => r.texts)).not.toContain('private draft');
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'clips nested inline anchors inside a compact flex navigation row without shrinking fonts',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><ul style="display:flex;justify-content:space-between;width:260px;padding:0;list-style:none"><li style="white-space:nowrap"><a href="#news">新闻</a></li><li style="white-space:nowrap"><a href="#world">国际</a></li><li style="white-space:nowrap"><a href="#tech">科技</a></li></ul></main>',
      {
        新闻: 'International news headlines',
        国际: 'World news and international affairs',
        科技: 'Technology and innovation',
      },
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const links = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll('li > a') ?? [])].map((a) => {
            const cell = a.parentElement;
            // An inline anchor and its icon share a line. Either that anchor or
            // its owning cell may clip the line; forcing the anchor to block
            // would test an implementation detail and can wrap inline icons.
            const clip = [a, cell].find(
              (el) =>
                el &&
                getComputedStyle(el).overflowX === 'hidden' &&
                getComputedStyle(el).textOverflow === 'ellipsis',
            );
            return {
              href: a.getAttribute('href'),
              font: getComputedStyle(a).fontSize,
              whitespace: clip && getComputedStyle(clip).whiteSpace,
              x: clip?.getBoundingClientRect().x,
              width: clip?.getBoundingClientRect().width,
              available: cell?.getBoundingClientRect().width,
              height: clip?.getBoundingClientRect().height,
            };
          });
        },
      });
      return result?.result;
    }, f.tabId);
    expect(links).toHaveLength(3);
    expect(links?.map((link) => link.href)).toEqual(['#news', '#world', '#tech']);
    for (const link of links ?? []) {
      expect(link).toMatchObject({
        font: '20px',
        whitespace: 'nowrap',
        height: 28,
      });
      expect(link.width).toBeGreaterThan(20);
      expect(link.width).toBeLessThanOrEqual((link.available ?? 0) + 0.5);
    }
    const rows = await f.read();
    expect(rows.map((row) => row.text)).toEqual([
      'International news headlines',
      'World news and international affairs',
      'Technology and innovation',
    ]);
    for (const [index, row] of rows.entries()) {
      const clip = links?.[index];
      expect(row.font).toBe(20);
      expect(row.box.height).toBeLessThanOrEqual(28);
      expect(row.paintedBox.left).toBeGreaterThanOrEqual((clip?.x ?? Infinity) - 0.5);
      expect(row.paintedBox.right).toBeLessThanOrEqual(
        (clip?.x ?? -Infinity) + (clip?.width ?? 0) + 0.5,
      );
      expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThan(20);
      if (index > 0) {
        const previous = rows[index - 1];
        if (!previous) throw new Error('Missing adjacent menu label');
        expect(row.paintedBox.left - previous.paintedBox.right).toBeGreaterThanOrEqual(9.5);
        expect(Math.abs(row.box.top - previous.box.top)).toBeLessThan(0.5);
      }
    }
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'keeps translated content when only its empty backing overlaps an independent footer',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="width:700px"><section><p style="width:220px">短文</p></section><footer style="text-align:right"><span><a href="#footer">页脚</a></span><input style="display:block;margin-top:60px" aria-label="Search"></footer></main><div style="height:1600px"></div>',
      { 短文: 'A longer translation wraps on a few lines in the left column.', 页脚: 'Footer' },
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual([
      'A longer translation wraps on a few lines in the left column.',
      'Footer',
    ]);
    const footerCovered = () =>
      f.panel.evaluate(async (tabId) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const text = [...(root?.querySelectorAll('.text') ?? [])];
            const group = text[0]?.closest<HTMLElement>('.translation-group');
            const footer = text.find((el) => el.textContent === 'Footer');
            if (!group || !footer) throw new Error('Missing translated content');
            const clip = group.style.clipPath;
            if (!clip.startsWith('path(')) throw new Error('Missing sibling cutout');
            const box = group.getBoundingClientRect();
            const peer = footer.getBoundingClientRect();
            const context = new OffscreenCanvas(1, 1).getContext('2d');
            if (!context) throw new Error('Missing path measurement');
            return context.isPointInPath(
              new Path2D(JSON.parse(clip.slice(5, -1))),
              peer.x + peer.width / 2 - box.x,
              peer.bottom - 0.5 - box.y,
            );
          },
        });
        return result?.result;
      }, f.tabId);
    expect(await footerCovered()).toBe(false);
    await f.page.mouse.move(700, 400);
    await f.page.mouse.wheel(0, 40);
    await expect.poll(() => f.page.evaluate(() => scrollY)).toBe(40);
    expect(await footerCovered()).toBe(false);
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'does not cut translated glyphs out to make a genuinely overlapping footer fit',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="width:700px"><section><p style="width:220px">短文</p></section><footer><span><a href="#footer">页脚</a></span><input style="display:block;margin-top:60px" aria-label="Search"></footer></main>',
      { 短文: 'A longer translation wraps on a few lines in the left column.', 页脚: 'Footer' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect((await f.read()).map((r) => r.text)).toEqual(['Footer']);
  },
);

extensionTest(
  'checks the translated footer footprint before accepting an empty background cutout',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="width:700px"><section><p style="width:220px">短文</p><p style="margin-left:620px;width:80px">更多</p></section><footer style="text-align:right"><span><a href="#footer">页脚</a></span><input style="display:block;margin-top:100px" aria-label="Search"></footer></main>',
      {
        短文: 'A longer translation wraps on a few lines in the left column.',
        更多: 'Additional',
        页脚: 'Footer details',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect((await f.read()).map((r) => r.text)).toEqual(['Footer details']);
  },
);

extensionTest(
  'keeps a sidebar translated when scrolling changes it from normal flow to fixed',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<header style="height:80px"><aside style="width:150px"><a href="#intro">目录</a></aside></header><main style="margin-left:220px"><p>正文</p><div style="height:2000px"></div></main><script>addEventListener("scroll",()=>{const a=document.querySelector("aside");a.style.position=scrollY>80?"fixed":"static";a.style.top="100px";});</script>',
      { 目录: 'Contents', 正文: 'Article text' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((row) => row.text)).toContain('Contents');
    await f.page.mouse.move(700, 400);
    await f.page.mouse.wheel(0, 280);
    await expect.poll(() => f.page.evaluate(() => scrollY)).toBeGreaterThan(200);
    await f.page.waitForTimeout(600);
    expect((await f.read()).map((row) => row.text)).toContain('Contents');
  },
);

extensionTest(
  'reflows ordinary paragraphs around an unchanged SVG image object',
  async ({ extensionSession }) => {
    const svg =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="176" height="180"><rect width="176" height="180" fill="orange"/></svg>',
      );
    const f = await setup(
      extensionSession,
      `<main style="width:300px"><p>短标题</p><object type="image/svg+xml" data="${svg}" style="display:block;width:176px;height:180px"></object><p>图后说明</p></main>`,
      {
        短标题:
          'This is a longer translated paragraph that needs several lines before the original illustration.',
        图后说明: 'The explanation after the illustration.',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const image = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay="translation"]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          const img = root?.querySelector('img');
          const text = root?.querySelector('.text');
          return {
            url: img?.src,
            width: img?.getBoundingClientRect().width,
            height: img?.getBoundingClientRect().height,
            top: img?.getBoundingClientRect().top,
            textBottom: text?.getBoundingClientRect().bottom,
            objects: root?.querySelectorAll('object,embed,iframe').length,
          };
        },
      });
      return result?.result;
    }, f.tabId);
    expect(image).toMatchObject({
      url: svg,
      width: 176,
      height: 180,
      objects: 0,
    });
    expect(image?.top).toBeGreaterThanOrEqual(image?.textBottom ?? NaN);
    expect(await f.page.locator('object').getAttribute('data')).toBe(svg);
  },
);

extensionTest(
  'does not add the original parent padding and first margin to a sliced paragraph flow',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="padding:24px 0"><p style="margin:12px 0">段落一</p><p style="margin:12px 0">段落二</p><p style="margin:12px 0">段落三</p><p style="margin:12px 0">段落四</p><canvas width="176" height="180" style="display:block"></canvas></main>',
      {
        段落一: 'Paragraph one',
        段落二: 'Paragraph two',
        段落三: 'Paragraph three',
        段落四: 'Paragraph four',
      },
    );
    const first = await f.page.locator('p').first().boundingBox();
    const surface = await f.page.locator('canvas').boundingBox();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(4);
    expect(Math.abs((rows[0]?.ownerBox?.top ?? NaN) - (first?.y ?? NaN))).toBeLessThan(1);
    expect(rows.at(-1)?.box.bottom).toBeLessThanOrEqual(surface?.y ?? NaN);
  },
);

extensionTest(
  'preserves code whitespace and literals in a translated article',
  async ({ extensionSession }) => {
    const code = 'const user = {\n  name: "原文",\n};';
    const f = await setup(
      extensionSession,
      `<main><p>示例说明</p><pre><code>${code}</code></pre><p>下一段</p></main>`,
      { 示例说明: 'Example explanation', 下一段: 'Next paragraph' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const mirrored = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay="translation"]',
          );
          const pre = host && chrome.dom.openOrClosedShadowRoot(host)?.querySelector('pre');
          return {
            text: pre?.textContent,
            whitespace: pre && getComputedStyle(pre).whiteSpace,
          };
        },
      });
      return result?.result;
    }, f.tabId);
    expect(mirrored).toEqual({ text: code, whitespace: 'pre' });
    expect(f.requests.flatMap((r) => r.texts)).toEqual(['示例说明', '下一段']);
    expect(await f.page.locator('pre').textContent()).toBe(code);
  },
);

extensionTest(
  'does not charge discarded parent copies against independent safe children',
  async ({ extensionSession }) => {
    const decoration = '<span></span>'.repeat(1800);
    const f = await setup(
      extensionSession,
      `<main style="display:flex;justify-content:space-between;margin:120px 60px;width:900px"><section style="width:300px"><p>左侧正文</p>${decoration}</section><section style="width:300px"><p>右侧正文</p>${decoration}</section></main><canvas width="100" height="28" style="position:absolute;left:460px;top:120px"></canvas>`,
      { 左侧正文: 'Left article', 右侧正文: 'Right article' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((row) => row.text)).toEqual(['Left article', 'Right article']);
  },
);

extensionTest(
  'keeps a detached table header at full width beside an excluded input row',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<table style="margin:40px;width:1000px;border-spacing:0"><tbody><tr style="background:#ff6600"><td><table style="width:100%;border-spacing:0"><tbody><tr><td style="width:100%"><a href="#submit">提交</a></td><td style="text-align:right;white-space:nowrap"><a href="#login">登录</a></td></tr></tbody></table></td></tr><tr><td><input aria-label="search"></td></tr></tbody></table>',
      { 提交: 'Submit', 登录: 'Log in' },
    );
    const original = await f.page.locator('body > table').evaluate((el) => el.outerHTML);
    const source = await f.page.locator('a').last().boundingBox();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const login = (await f.read()).find((row) => row.text === 'Log in');
    expect(login?.box.right).toBeGreaterThan(1000);
    expect(
      Math.abs((login?.box.right ?? 0) - ((source?.x ?? 0) + (source?.width ?? 0))),
    ).toBeLessThan(3);
    await expect(f.page.locator('body > table')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'keeps a fixed sidebar translated when its ordinary ancestor scrolls out of view',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<header style="height:80px"><aside style="position:fixed;left:0;top:100px;width:150px"><a href="#intro">目录</a></aside></header><main style="margin-left:220px"><p>正文</p><div style="height:2000px"></div></main>',
      { 目录: 'Contents', 正文: 'Article text' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((row) => row.text)).toContain('Contents');
    await f.page.mouse.move(700, 400);
    await f.page.mouse.wheel(0, 280);
    await expect.poll(() => f.page.evaluate(() => scrollY)).toBeGreaterThan(200);
    await expect.poll(async () => (await f.read()).map((row) => row.text)).toContain('Contents');
    await f.page.waitForTimeout(400);
    expect((await f.read()).map((row) => row.text)).toContain('Contents');
  },
);
