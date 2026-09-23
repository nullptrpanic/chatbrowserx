import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'keeps constraint scans out of a large hidden subtree while rendering the visible structure',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><nav style="display:flex;gap:20px;white-space:nowrap"><a href="#news">新闻</a><a href="#maps">地图</a></nav><p>可见正文</p><div hidden id="hidden-tree">' +
        '<span></span>'.repeat(8000) +
        '</div></main>',
      { 新闻: 'News', 地图: 'Maps', 可见正文: 'Visible prose' },
    );
    const source = await f.page.locator('main').innerHTML();
    const errors: string[] = [];
    f.page.on('pageerror', (error) => errors.push(error.message));
    await f.panel.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const hidden = document.getElementById('hidden-tree');
          const computed = window.getComputedStyle.bind(window);
          let excludedReads = 0;
          window.getComputedStyle = (el, pseudo) => {
            if (el.parentElement === hidden) excludedReads++;
            return computed(el, pseudo);
          };
          Object.defineProperty(window, '__translationExcludedReads', {
            get: () => excludedReads,
          });
        },
      });
    }, f.tabId);
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((row) => row.text).sort())
      .toEqual(['Maps', 'News', 'Visible prose']);
    const rows = await f.read();
    expect(rows.every((row) => row.font === 20)).toBe(true);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
    const [reads] = await f.panel.evaluate(
      async (tabId) =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => Reflect.get(window, '__translationExcludedReads') as number,
        }),
      f.tabId,
    );
    expect(reads?.result).toBe(0);
    expect(errors).toEqual([]);
    expect(f.requests.flatMap((request) => request.texts).sort()).toEqual([
      '可见正文',
      '地图',
      '新闻',
    ]);
  },
);

extensionTest(
  'shares compact flex navigation width when glyph ink is taller than its CSS line box',
  async ({ extensionSession }) => {
    const translations = {
      要闻: 'Top News',
      科技: 'Technology',
      财经: 'Finance',
      AI: 'AI',
      热问: 'Trending Questions',
      教育: 'Education',
      国际: 'International',
      军事: 'Military',
      娱乐: 'Entertainment',
      电视剧: 'TV Dramas',
      亚运会: 'Asian Games',
      体育: 'Sports',
      NBA: 'NBA',
      汽车: 'Cars',
      房产: 'Real Estate',
      游戏: 'Games',
      QQ游戏: 'QQ Games',
      小游戏中心: 'Mini Games Center',
      更多: 'More',
    };
    const f = await setup(
      extensionSession,
      `<style>nav ul{display:flex;align-items:center;margin:0;padding:10px 0;list-style:none;font:16px/14px Arial}nav li{flex:0 0 auto;margin-right:34px}nav li:last-child{margin-right:0}nav a{display:inline-block;position:relative;font:18px/14px Arial}</style><main style="zoom:.9;width:1440px;margin:90px 80px"><nav><ul>${Object.keys(
        translations,
      )
        .map((label) => `<li><a href="#${label}">${label}</a></li>`)
        .join('')}</ul></nav></main>`,
      translations,
    );
    await f.page.setViewportSize({ width: 1440, height: 900 });
    const source = await f.page.locator('main').innerHTML();
    const box = await f.page.locator('ul').boundingBox();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(17);
    const rows = await f.read();
    expect(rows.every((row) => row.paintedBox.right <= (box?.x ?? 0) + (box?.width ?? 0) + 1)).toBe(
      true,
    );
    const last = rows.at(-1)?.paintedBox;
    expect((last?.right ?? 0) - (last?.left ?? 0)).toBeGreaterThan(28);
    expect(rows.every((row) => row.box.height < 24)).toBe(true);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
  },
);

extensionTest(
  'renders admitted visible prose and table cells before a large trailing DOM exhausts discovery',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>可见正文</p><table style="width:600px;table-layout:fixed"><tr><th>字段</th><th>说明</th></tr><tr><td>名称</td><td>完整描述</td></tr></table></main>' +
        '<div hidden></div>'.repeat(10020),
      {
        可见正文: 'Visible prose',
        字段: 'Field',
        说明: 'Description',
        名称: 'Name',
        完整描述: 'Complete description',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((row) => row.text).sort())
      .toEqual(['Visible prose', 'Field', 'Description', 'Name', 'Complete description'].sort());
    expect((await f.read()).every((row) => row.font === 20)).toBe(true);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
    expect(f.requests.flatMap((request) => request.texts)).toHaveLength(5);
    const count = f.requests.length;
    await f.page.keyboard.press('Escape');
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(5);
    expect(f.requests).toHaveLength(count);
  },
);

extensionTest(
  'keeps an ellipsized table link beside an independent native timestamp',
  async ({ extensionSession }) => {
    const source = 'docs(readme): update blog link to devblogs and use relative addresses';
    const translation =
      'Update all documentation links to the new developer blog and keep relative addresses consistent across every translated page';
    const f = await setup(
      extensionSession,
      `<main><table style="width:900px;table-layout:fixed;border-collapse:collapse;font:14px/21px Arial"><colgroup><col style="width:360px"><col style="width:405px"><col style="width:135px"></colgroup><tr style="height:41px"><td style="padding:0 16px">README.md</td><td style="padding:0 0 0 16px;vertical-align:middle"><div style="min-width:0"><div style="max-width:100%;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><a href="#commit">${source}</a></div></div></td><td style="padding:0 16px;text-align:right;vertical-align:middle"><relative-time></relative-time></td></tr></table></main>`,
      { 'README.md': 'README.md', [source]: translation },
    );
    await f.page.locator('relative-time').evaluate((el) => {
      el.attachShadow({ mode: 'open' }).innerHTML =
        '<span style="display:inline-block;width:68px;height:17px;background:rgb(0,64,255)"></span>';
    });
    const original = await f.page.locator('main').innerHTML();
    const clip = await f.page.locator('td:nth-child(2)>div>div').boundingBox();
    const originalLink = await f.page.locator('a').boundingBox();
    await f.toggle();
    await expect.poll(async () => (await f.read()).map((row) => row.text)).toContain(translation);
    const row = (await f.read()).find((row) => row.text === translation);
    expect(row?.paintedBox.right).toBeLessThanOrEqual((clip?.x ?? 0) + (clip?.width ?? 0) + 0.5);
    expect(row?.box.height).toBeLessThanOrEqual(21);
    expect(row?.box.y).toBeCloseTo(originalLink?.y ?? 0, 0);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'preserves overlapping static graphics inside a translated link',
  async ({ extensionSession }) => {
    const images = ['red', 'green', 'blue']
      .map((color, index) => {
        const url = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${color}"/></svg>`)}`;
        return `<img src="${url}" style="display:flex;position:relative;width:32px;height:32px;border-radius:50%;margin-left:${index ? '-17.6px' : '0'};z-index:${3 - index}">`;
      })
      .join('');
    const f = await setup(
      extensionSession,
      `<main><h2>成员</h2><a href="#members" style="display:flex;align-items:center;gap:10px"><span style="display:flex;width:fit-content"><span style="display:flex">${images}</span></span><span>三位参与者</span></a></main>`,
      { 成员: 'Members', 三位参与者: 'Three participants' },
    );
    const original = await f.page.locator('main').innerHTML();
    const boxes = await f.page
      .locator('img')
      .evaluateAll((images) => images.map((image) => image.getBoundingClientRect().toJSON()));
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(2);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll('img') ?? [])].map((image) =>
              image.getBoundingClientRect().toJSON(),
            );
          },
        }),
      f.tabId,
    );
    expect(result?.result).toHaveLength(3);
    for (const [index, copy] of (result?.result ?? []).entries()) {
      const source = boxes[index];
      if (!source) throw new Error('Missing source graphic');
      for (const dimension of ['x', 'y', 'width', 'height'] as const)
        expect(copy[dimension], `graphic ${index}: ${dimension}`).toBeCloseTo(source[dimension], 0);
    }
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'lets opposing intrinsic floated links retain a single line without freezing source widths',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="width:700px"><nav style="overflow:hidden;padding:10px 30px;border-block:1px solid #ccc"><div style="float:left"><a><i style="display:inline-block;width:14px">←</i></a> <a>图像</a></div><div style="float:right"><a>列表</a> <a><i style="display:inline-block;width:14px">→</i></a></div></nav><iframe title="Native content" style="display:block;border:0;width:700px;height:100px"></iframe></main>',
      {
        '<m0>图像</m0>': '<m0>HTML images</m0>',
        '<m0>列表</m0>': '<m0>HTML lists</m0>',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    const nav = await f.page.locator('nav').boundingBox();
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((row) => row.text))
      .toEqual(['HTML images', 'HTML lists']);
    const rows = await f.read();
    expect(rows[0]?.box.y).toBeCloseTo(rows[1]?.box.y ?? -1, 0);
    expect(rows.every((row) => row.box.bottom < (nav?.y ?? 0) + (nav?.height ?? 0))).toBe(true);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'discovers a visible fixed island before its offscreen ancestor has ever been observed',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>可见正文</p><div style="height:2px;margin-top:1200px"><aside style="position:fixed;top:200px;left:60px;width:200px;background:#eee"><a>固定侧栏</a></aside></div></main>',
      {
        可见正文: 'Visible article',
        '<m0>固定侧栏</m0>': '<m0>Fixed sidebar</m0>',
      },
    );
    const source = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((row) => row.text).sort())
      .toEqual(['Fixed sidebar', 'Visible article']);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
  },
);

extensionTest(
  'keeps a reflowed article when only empty flow padding reaches adjacent native media',
  async ({ extensionSession }) => {
    const prose = 'A longer translated paragraph that wraps naturally onto a second line.';
    const f = await setup(
      extensionSession,
      '<main style="width:400px"><article><p>简短正文。</p><table style="width:100%"><tr><td>表格内容</td></tr></table></article><nav style="display:block;padding-bottom:100px"><p>下页</p></nav><iframe title="Native surface" srcdoc="<body style=\'margin:0;background:rgb(0,64,255)\'></body>" style="display:block;width:400px;height:100px;border:0"></iframe></main>',
      { '简短正文。': prose, 表格内容: 'Table content', 下页: 'Next page' },
    );
    const source = await f.page.locator('main').innerHTML();
    const native = await f.page.locator('iframe').boundingBox();
    if (!native) throw new Error('Native surface missing');
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((row) => row.text))
      .toEqual([prose, 'Table content', 'Next page']);
    expect((await f.read()).every((row) => row.box.bottom < native.y)).toBe(true);
    const screenshot = await f.page.screenshot();
    const pixel = await f.panel.evaluate(
      async ({ png, x, y }) => {
        const bitmap = await createImageBitmap(await (await fetch(png)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.drawImage(bitmap, 0, 0);
        return [...ctx.getImageData(x, y, 1, 1).data];
      },
      {
        png: `data:image/png;base64,${screenshot.toString('base64')}`,
        x: native.x + 20,
        y: native.y + 10,
      },
    );
    expect(pixel).toEqual([0, 64, 255, 255]);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
  },
);

extensionTest(
  'keeps nested inline decoration inside the enclosing single-line contract',
  async ({ extensionSession }) => {
    const translated =
      'A complete headline that is intentionally much longer than the available single line';
    const f = await setup(
      extensionSession,
      '<main style="width:300px"><div style="height:24px;font:16px/24px Arial;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><a href="#headline"><strong style="white-space:normal">普通新闻</strong></a></div><iframe title="Native content" style="display:block;width:300px;height:100px;border:0"></iframe></main>',
      { '<m0>普通新闻</m0>': `<m0>${translated}</m0>` },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const [row] = await f.read();
    expect(row?.box.height).toBeLessThanOrEqual(24);
    expect(row?.paintedBox.right).toBeLessThanOrEqual(360);
    expect(row?.paintedBox.right).toBeGreaterThan(350);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'lets an intrinsic navigation column use the empty gap before a fixed sibling',
  async ({ extensionSession }) => {
    const labels = {
      新闻: 'News',
      体育: 'Sports',
      科技: 'Technology',
      财经: 'Finance',
      文化: 'Culture',
      教育: 'Education',
    };
    const f = await setup(
      extensionSession,
      `<style>.row{height:40px;font:14px/20px Arial}.links{float:left}.links a{float:left;margin-right:14px}.tools{float:right;width:240px;height:20px}iframe{display:block;width:900px;height:100px;border:0}</style><main><div class="row"><div class="links">${Object.keys(
        labels,
      )
        .map((s, i) => `<a href="#${i}">${s}</a>`)
        .join(
          '',
        )}</div><aside class="tools">独立工具栏</aside></div><iframe title="Native content"></iframe></main>`,
      { ...labels, 独立工具栏: 'Independent toolbar' },
    );
    const original = await f.page.locator('main').innerHTML();
    const tools = await f.page.locator('.tools').boundingBox();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(7);
    const rows = await f.read();
    for (const text of Object.values(labels)) {
      const row = rows.find((r) => r.text === text);
      expect(
        (row?.paintedBox.right ?? 0) - (row?.paintedBox.left ?? 0),
        text,
      ).toBeGreaterThanOrEqual((row?.box.width ?? Infinity) - 0.5);
      expect(row?.paintedBox.right).toBeLessThan(tools?.x ?? 0);
      expect(row?.font).toBe(14);
    }
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'retains a naturally wrapping intrinsic link row without inventing truncation',
  async ({ extensionSession }) => {
    const labels = {
      新闻: 'News',
      体育: 'Sports',
      科技: 'Technology',
      财经: 'Finance',
      文化: 'Culture',
      教育: 'Education',
    };
    const f = await setup(
      extensionSession,
      `<style>.links{float:left;width:260px;font:14px/20px Arial}.links a{float:left;margin-right:14px}footer{clear:both}</style><main><div class="links">${Object.keys(
        labels,
      )
        .map((s, i) => `<a href="#${i}">${s}</a>`)
        .join('')}</div><footer>后续正文</footer></main>`,
      { ...labels, 后续正文: 'Following content' },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(7);
    const rows = await f.read();
    for (const text of Object.values(labels)) {
      const row = rows.find((r) => r.text === text);
      expect(row).toBeDefined();
      expect(
        (row?.paintedBox.right ?? 0) - (row?.paintedBox.left ?? 0),
        text,
      ).toBeGreaterThanOrEqual((row?.box.width ?? Infinity) - 0.5);
      expect(row?.font).toBe(14);
    }
    const bottom = Math.max(
      ...rows.filter((r) => r.text !== 'Following content').map((r) => r.box.bottom),
    );
    expect(rows.find((r) => r.text === 'Following content')?.box.top).toBeGreaterThanOrEqual(
      bottom,
    );
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'keeps linked headlines above floated summaries and an independent native surface',
  async ({ extensionSession }) => {
    const labels = {
      头条新闻一:
        'A complete translation of an important headline with several details discussed at the meeting',
      头条新闻二:
        'Another headline with an extended translation that needs to stay above the news summaries',
      第一条: 'First summary',
      第二条: 'Second summary',
      第三条: 'Third summary',
      第四条: 'Fourth summary',
    };
    const f = await setup(
      extensionSession,
      `<style>.column{width:600px;overflow:hidden}.headlines{font:bold 18px/30px Arial}.headlines ul{list-style:none;padding:0;margin:0}.summaries{display:flow-root;font:16px/30px Arial}.summaries>div{float:left;width:290px}.summaries a{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;height:30px}canvas{display:block;margin-top:20px}</style><main><div class="column"><div><div class="headlines"><ul><li><p><a href="#a">头条新闻一</a></p></li><li><p><a href="#b">头条新闻二</a></p></li></ul></div><div class="summaries"><div><a href="#c">第一条</a><a href="#d">第二条</a></div><div><a href="#e">第三条</a><a href="#f">第四条</a></div></div></div><canvas width="600" height="140"></canvas></div></main>`,
      labels,
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toEqual(Object.values(labels));
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'preserves native button content alignment without adding interaction',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><button style="width:160px;height:60px;border:0;padding:0;font:20px/24px Arial;background:#526bff;color:white;border-radius:16px">开始搜索</button></main>',
      { 开始搜索: 'Search now' },
    );
    const original = await f.page.locator('main').innerHTML();
    const source = await f.page.locator('button').evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      return {
        box: button.getBoundingClientRect().toJSON(),
        text: range.getBoundingClientRect().toJSON(),
      };
    });
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const [flow] = await f.read();
    expect(flow?.font).toBe(20);
    expect(Math.abs((flow?.box.y ?? 0) - source.text.y)).toBeLessThan(1);
    expect(flow?.ownerBox?.width).toBe(source.box.width);
    expect(flow?.ownerBox?.height).toBe(source.box.height);
    const [state] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const button =
              host &&
              chrome.dom
                .openOrClosedShadowRoot(host)
                ?.querySelector<HTMLButtonElement>('.translation-group button');
            return button
              ? {
                  type: button.type,
                  inert: button.inert,
                  tabIndex: button.tabIndex,
                }
              : null;
          },
        }),
      f.tabId,
    );
    expect(state?.result).toEqual({
      type: 'button',
      inert: true,
      tabIndex: -1,
    });
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'does not turn a numbered whitespace-preserving paragraph into compact navigation',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="width:760px"><div style="display:flex"><span aria-hidden="true">2.</span><div style="display:flex;flex-direction:column;flex:1;min-width:1px"><p style="margin:0;white-space:break-spaces"><span>采用分布式</span><span style="text-decoration:underline">网关</span><span>，部署在节点上，对业务不可见。</span></p></div></div></main>',
      {
        '<m0>采用分布式</m0><m1>网关</m1><m2>，部署在节点上，对业务不可见。</m2>':
          '<m0>Use a distributed </m0><m1>gateway</m1><m2>, deployed on the node and invisible to the business application.</m2>',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const flow = host && chrome.dom.openOrClosedShadowRoot(host)?.querySelector('.text');
            if (!flow) return null;
            const nodes: Text[] = [];
            const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode())
              if (n.textContent?.trim()) nodes.push(n as Text);
            return {
              whiteSpace: getComputedStyle(flow).whiteSpace,
              firstLines: nodes.map((n) => {
                const range = document.createRange();
                range.setStart(n, 0);
                range.setEnd(n, 1);
                return range.getBoundingClientRect().top;
              }),
            };
          },
        }),
      f.tabId,
    );
    expect(result?.result?.whiteSpace).toBe('break-spaces');
    const lines = result?.result?.firstLines ?? [];
    expect(lines).toHaveLength(3);
    expect(Math.max(...lines) - Math.min(...lines)).toBeLessThan(1);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'keeps indentation on its line while permitting marker reordering within that line',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><section style="white-space:pre-wrap">    <strong>第一段</strong> <em>第二段</em>\n  第三段</section></main>',
      {
        '<m0>第一段</m0> <m1>第二段</m1> <m2>第三段</m2>':
          '<m2>Third</m2> <m1>Second</m1> <m0>First</m0>',
      },
    );
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    expect((await f.read())[0]?.text).toBe('    Second First\n  Third');
  },
);

extensionTest(
  'does not turn the used width of an intrinsic floated tab into a text limit',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>.bar{width:360px;height:34px;line-height:34px;border:1px solid #ddd;margin-bottom:20px;font-size:12px}.tabs{float:left;height:35px;margin-left:-2px}.tab{float:left;font:16px/29px Arial;height:33px;padding:0 12px 0 13px;border-top:3px solid orange;border-right:1px solid #ddd;margin-top:-1px}.date{float:right;margin-right:10px}</style><main>${['新闻', '专栏'].map((label) => `<div class="bar"><div class="tabs"><div><span class="tab"><a href="#tab">${label}</a></span></div></div><span class="date" aria-hidden="true">2026.09.21</span></div>`).join('')}</main>`,
      { 新闻: 'News', 专栏: 'Columns' },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(2);
    for (const flow of await f.read()) {
      expect(flow.font).toBe(16);
      expect(flow.paintedBox.right - flow.paintedBox.left, flow.text ?? '').toBeGreaterThanOrEqual(
        flow.box.width - 1,
      );
    }
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'preserves decorated editor runs even when their typography matches',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main class="page-block root-block" contenteditable="true"><p class="zone-container text-editor"><span>请选择 </span><span style="background:rgb(220,225,230);padding:2px 6px;border:1px solid red"><span>选项</span></span><span> 继续。</span></p></main>',
      {
        '请选择 选项 继续。': 'Choose option to continue.',
        '请选择 <m0>选项</m0> 继续。': 'Choose <m0>option</m0> to continue.',
      },
      'https://fixture.larkoffice.com/docx/decorations',
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll('.text span') ?? [])]
              .filter(
                (element) => getComputedStyle(element).backgroundColor === 'rgb(220, 225, 230)',
              )
              .map((element) => ({
                text: element.textContent,
                padding: getComputedStyle(element).paddingLeft,
                border: getComputedStyle(element).borderLeftWidth,
              }));
          },
        }),
      f.tabId,
    );
    expect(result?.result).toEqual([{ text: 'option', padding: '6px', border: '1px' }]);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'preserves floated photo cards instead of treating them as a navigation row',
  async ({ extensionSession }) => {
    const photo =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="105" height="70"><rect width="105" height="70" fill="#189c82"/></svg>',
      );
    const f = await setup(
      extensionSession,
      `<style>.photos{width:360px;display:flow-root}.photos a{float:left;position:relative;width:105px;height:90px;margin-right:19px;overflow:hidden;border:1px solid #ccc;white-space:nowrap;font:16px/20px Arial}.photos a:last-child{margin:0}.photos img{display:block;width:105px;height:70px}</style><main><div class="photos">${['第一张图', '第二张图', '第三张图'].map((label) => `<a href="#photo"><img src="${photo}">${label}</a>`).join('')}</div></main>`,
      {
        第一张图: 'First photograph with a long caption',
        第二张图: 'Second photograph with a long caption',
        第三张图: 'Third photograph with a long caption',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    const boxes = await f.page
      .locator('img')
      .evaluateAll((images) => images.map((image) => image.getBoundingClientRect().toJSON()));
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(3);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll('img') ?? [])].map((image) => ({
              complete: image.complete && image.naturalWidth > 0,
              box: image.getBoundingClientRect().toJSON(),
            }));
          },
        }),
      f.tabId,
    );
    expect(result?.result).toHaveLength(3);
    for (const [index, image] of (result?.result ?? []).entries()) {
      expect(image.complete).toBe(true);
      const source = boxes[index];
      if (!source) throw new Error(`Missing source photo ${index}`);
      for (const dimension of ['x', 'y', 'width', 'height'] as const)
        expect(image.box[dimension], `photo ${index}: ${dimension}`).toBeCloseTo(
          source[dimension],
          0,
        );
    }
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'keeps the source width of a full-width reading control',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><button style="width:100%;height:48px;text-align:left;font:20px/28px Arial">搜索文档</button></main>',
      { 搜索文档: 'Search documentation' },
    );
    const original = await f.page.locator('main').innerHTML();
    const source = await f.page.locator('button').boundingBox();
    expect(source).not.toBeNull();
    if (!source) throw new Error('Missing source control');
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const [flow] = await f.read();
    expect(flow?.ownerBox?.width).toBeCloseTo(source.width, 0);
    expect(flow?.ownerBox?.height).toBeCloseTo(source.height, 0);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'uses spare shared navigation width before ellipsizing short labels',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>nav{display:flex;gap:30px}nav a{display:block;height:28px;white-space:nowrap}</style>
     <main><nav><a href="/news">新闻</a><a href="/sports">体育</a><a href="/finance">财经</a><a href="/technology">科技</a></nav></main>`,
      { 新闻: 'News', 体育: 'Sports', 财经: 'Finance', 科技: 'Technology' },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(4);
    for (const flow of await f.read()) {
      expect(flow.font).toBe(20);
      expect(
        flow.paintedBox.right - flow.paintedBox.left,
        `visible label: ${flow.text}`,
      ).toBeGreaterThanOrEqual(flow.box.width - 1);
    }
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'retains inline code decoration around translated text',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>请选择 <code style="background:rgb(220,225,230);padding:2px 6px;border:1px solid red;border-radius:4px">选项</code> 继续。</p></main>',
      { '请选择 <m0>选项</m0> 继续。': 'Choose <m0>option</m0> to continue.' },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const code = root?.querySelector('code');
            if (!code) return null;
            const s = getComputedStyle(code);
            return {
              text: code.textContent,
              background: s.backgroundColor,
              padding: s.paddingLeft,
              border: s.borderLeftWidth,
            };
          },
        }),
      f.tabId,
    );
    expect(result?.result).toEqual({
      text: 'option',
      background: 'rgb(220, 225, 230)',
      padding: '6px',
      border: '1px',
    });
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'retains source indentation in a non-pre whitespace-preserving example',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><section style="white-space:pre-wrap">    示例内容</section></main>',
      { 示例内容: 'Example content', '    示例内容': '    Example content' },
    );
    const original = await f.page.locator('section').textContent();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const [flow] = await f.read();
    expect(flow?.text).toBe('    Example content');
    expect(await f.page.locator('section').textContent()).toBe(original);
  },
);

for (const [kind, indent] of [
  ['nonbreaking', '\u00a0 \u00a0 \u00a0 '],
  ['wide', '\u2003\u2003\u2003'],
] as const)
  extensionTest(
    `retains ${kind} indentation under normal whitespace beside explicit breaks`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<main><section style="font:16px/24px monospace;white-space:normal"><span>开始</span><br>\n${indent}<span style="color:green">&lt;item&gt;</span>示例文字<span style="color:green">&lt;/item&gt;</span><br><span>结束</span></section></main>`,
        {
          '<m0>开始</m0>': '<m0>Start</m0>',
          '<m0>&lt;item&gt;</m0>示例文字<m1>&lt;/item&gt;</m1>':
            '<m0>&lt;item&gt;</m0>Example text<m1>&lt;/item&gt;</m1>',
          '<m0>结束</m0>': '<m0>End</m0>',
        },
      );
      const original = await f.page.locator('main').innerHTML();
      const originalBox = await f.page.locator('section > span').nth(1).boundingBox();
      await f.toggle();
      await expect.poll(async () => (await f.read()).length).toBe(3);
      const [result] = await f.panel.evaluate(
        async (id) =>
          chrome.scripting.executeScript({
            target: { tabId: id },
            func: () => {
              const host = document.querySelector<HTMLElement>(
                '[data-chatbrowserx-overlay=translation]',
              );
              const root = host && chrome.dom.openOrClosedShadowRoot(host);
              const flow = [...(root?.querySelectorAll('.text') ?? [])].find((el) =>
                el.textContent?.includes('Example text'),
              );
              const marker = flow?.querySelector('span');
              return {
                text: flow?.textContent,
                x: marker?.getBoundingClientRect().x,
              };
            },
          }),
        f.tabId,
      );
      expect(result?.result?.text).toBe(`\n${indent}<item>Example text</item>`);
      expect(originalBox).not.toBeNull();
      expect(Math.abs((result?.result?.x ?? -1000) - (originalBox?.x ?? 0))).toBeLessThan(0.5);
      expect(await f.page.locator('main').innerHTML()).toBe(original);
    },
  );

extensionTest(
  'keeps one decorated link around reordered nested markers',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>请 <a href="#options" style="padding:2px 8px;background:rgb(220,225,230);border:1px solid red"><span>打开</span> <strong>选项</strong></a> 继续。</p></main>',
      {
        '请 <m0>打开</m0> <m1>选项</m1> 继续。': 'Continue with <m1>options</m1> <m0>open</m0>.',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(1);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const links = [...(root?.querySelectorAll('.text a') ?? [])];
            return links.map((link) => ({
              text: link.textContent,
              padding: getComputedStyle(link).paddingLeft,
              strong: link.querySelector('strong')?.textContent,
              href: link.getAttribute('href'),
            }));
          },
        }),
      f.tabId,
    );
    expect(result?.result).toEqual([
      {
        text: 'options open',
        padding: '8px',
        strong: 'options',
        href: '#options',
      },
    ]);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'keeps explicit line breaks inside a shared inline shell',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p><code style="background:rgb(220,225,230)">第一行<br>第二行</code></p></main>',
      {
        '<m0>第一行</m0>': '<m0>First line</m0>',
        '<m0>第二行</m0>': '<m0>Second line</m0>',
      },
    );
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(2);
    const rows = await f.read();
    const [first, second] = rows;
    if (!first || !second) throw new Error('Missing translated lines');
    expect(second.box.top).toBeGreaterThan(first.box.bottom);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll('.text') ?? [])].map(
              (flow) => flow.parentElement?.tagName,
            );
          },
        }),
      f.tabId,
    );
    expect(result?.result).toEqual(['CODE', 'CODE']);
  },
);

for (const reordered of [false, true])
  extensionTest(
    `preserves literal newlines and per-line indentation with ${reordered ? 'reordered' : 'ordered'} markers`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        '<main><section style="white-space:pre-wrap">    第一行\n  第二行</section></main>',
        {
          '第一行 第二行': 'First line Second line',
          '<m0>第一行</m0> <m1>第二行</m1>': reordered
            ? '<m1>Second line</m1> <m0>First line</m0>'
            : '<m0>First line</m0> <m1>Second line</m1>',
        },
      );
      await f.toggle();
      await expect.poll(async () => (await f.read()).length).toBe(1);
      expect((await f.read())[0]?.text).toBe('    First line\n  Second line');
    },
  );

extensionTest(
  'preserves a graphic inside a decorated inline link without duplicating its shell',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>查看 <a href="#item" style="background:rgb(220,225,230);padding:2px 5px"><svg aria-hidden="true" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>选项</a> 继续。</p></main>',
      { 查看: 'See ', '<m0>选项</m0> 继续。': '<m0>option</m0> to continue.' },
    );
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(2);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const links = [...(root?.querySelectorAll('a') ?? [])];
            return links.map((a) => ({
              text: a.textContent,
              graphics: a.querySelectorAll('svg').length,
            }));
          },
        }),
      f.tabId,
    );
    expect(result?.result).toEqual([{ text: 'option', graphics: 1 }]);
  },
);
