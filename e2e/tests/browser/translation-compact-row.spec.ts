import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'keeps nested label spacing that reserves a background icon inside a shared row',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.row{display:flex;width:280px;font:16px/24px Arial}.row>a{white-space:nowrap;margin-right:16px}.icon{background-image:linear-gradient(blue,blue);background-size:16px 16px;background-repeat:no-repeat;background-position:left center}.icon span{display:inline-block;margin-left:24px}</style><main><div class="row"><a class="icon"><span>设置</span></a><a>更多消息</a></div></main>',
      { 设置: 'Settings', 更多消息: 'All recent messages and notifications' },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(2);
    const [result] = await f.panel.evaluate(
      async (tabId) =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const label = [...(root?.querySelectorAll('.text') ?? [])].find(
              (el) => el.textContent === 'Settings',
            );
            const icon = label?.closest('a');
            if (!label || !icon) throw new Error('Missing icon label');
            return label.getBoundingClientRect().left - icon.getBoundingClientRect().left;
          },
        }),
      f.tabId,
    );
    expect(result?.result).toBeGreaterThanOrEqual(24);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'shares a bounded inline navigation row when label borders exceed its line box',
  async ({ extensionSession }) => {
    const translations = {
      推荐: 'Recommended',
      视频: 'Videos',
      汽车: 'Cars',
      游戏: 'Games',
      直播: 'Live streams',
      体育: 'Sports',
      娱乐: 'Entertainment',
      科技: 'Technology',
      财经: 'Finance',
      女性: 'Women',
      历史: 'History',
      时尚: 'Fashion',
    };
    const f = await setup(
      extensionSession,
      `<style>h3{position:relative;width:900px;height:40px;font:18px/40px Arial}.track{position:absolute;top:-1px;width:768px;height:100%}.track>div{display:inline-block;position:relative}.track a{display:inline-block;position:relative;box-sizing:border-box;height:100%;margin-left:32px;border-top:2px solid transparent;font:16px/40px Arial}</style><main><h3><span class="track">${Object.keys(
        translations,
      )
        .map((label, index) => `<div><a href="#item-${index}">${label}</a></div>`)
        .join('')}</span></h3></main>`,
      translations,
    );
    const original = await f.page.locator('main').innerHTML();
    const positions = await f.page
      .locator('.track a')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().y));
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(12);
    const rows = await f.read();
    expect(rows.map((row) => row.text)).toEqual(Object.values(translations));
    for (const [index, row] of rows.entries()) {
      expect(row.font).toBe(16);
      expect(
        Math.abs((row.ownerBox?.y ?? Infinity) - (positions[index] ?? Infinity)),
      ).toBeLessThanOrEqual(1);
      expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThanOrEqual(
        Math.min(row.box.width, 48) - 0.5,
      );
      expect(row.paintedBox.bottom - row.paintedBox.top).toBeGreaterThanOrEqual(
        row.box.height - 0.5,
      );
    }
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

for (const bound of ['height:auto', 'max-height:240px'])
  extensionTest(
    `allows a wrapping row to grow when ${bound} leaves room for more lines`,
    async ({ extensionSession }) => {
      const translations = {
        开发: 'Developer resources',
        文档: 'Documentation guides',
        社区: 'Community discussions',
        支持: 'Technical support',
      };
      const f = await setup(
        extensionSession,
        `<style>.links{display:flex;flex-wrap:wrap;width:272px;${bound};overflow:hidden;font:14px/20px Arial}.links a{white-space:nowrap;padding:2px 12px}</style><main><div class="links">${Object.keys(
          translations,
        )
          .map((label, index) => `<a href="#item-${index}">${label}</a>`)
          .join('')}</div></main>`,
        translations,
      );
      const original = await f.page.locator('main').innerHTML();
      await f.toggle();
      await expect.poll(async () => (await f.read()).length).toBe(4);
      const rows = await f.read();
      for (const row of rows) {
        expect(row.font).toBe(14);
        expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThanOrEqual(
          row.box.width - 0.5,
        );
      }
      expect(
        Math.max(...rows.map((row) => row.box.y)) - Math.min(...rows.map((row) => row.box.y)),
      ).toBeGreaterThan(20);
      expect(await f.page.locator('main').innerHTML()).toBe(original);
    },
  );

for (const bound of ['height:16px', 'max-height:16px'])
  extensionTest(
    `keeps every visible link in a clipped wrapping row with ${bound}`,
    async ({ extensionSession }) => {
      const translations = {
        通信: 'Communication',
        工具: 'Utilities',
        办公: 'Office applications',
        音乐: 'Music services',
        浏览器: 'Web browsers',
        输入法: 'Input methods',
        应用: 'Applications',
      };
      const f = await setup(
        extensionSession,
        `<style>.links{display:flex;flex-wrap:wrap;align-items:center;width:415px;${bound};padding-bottom:10px;overflow:hidden;font:16px/18.4px Arial}.links>div{display:flex;justify-content:space-around;margin:0 16px 10px 0}.links>div:last-child{margin-right:0}.links a{white-space:nowrap;font:14px/16.1px Arial}</style><main><div class="links">${Object.keys(
          translations,
        )
          .map((label, index) => `<div><a href="#item-${index}">${label}</a></div>`)
          .join('')}</div></main>`,
        translations,
      );
      const original = await f.page.locator('main').innerHTML();
      await f.toggle();
      await expect.poll(async () => (await f.read()).length).toBe(7);
      const rows = await f.read();
      expect(rows.map((row) => row.text)).toEqual(Object.values(translations));
      for (const row of rows) {
        expect(row.font).toBe(14);
        expect(row.paintedBox.bottom - row.paintedBox.top).toBeGreaterThanOrEqual(
          row.box.height - 0.5,
        );
        expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThanOrEqual(42);
      }
      expect(
        Math.max(...rows.map((row) => row.box.y)) - Math.min(...rows.map((row) => row.box.y)),
      ).toBeLessThan(0.5);
      expect(await f.page.locator('main').innerHTML()).toBe(original);
    },
  );

extensionTest(
  'preserves natural wrapping of padded flex labels instead of shrinking them into one row',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.labels{display:flex;flex-wrap:wrap;gap:8px 2px;width:272px;font:14px/21px Arial}.labels a{display:flex;box-sizing:border-box;white-space:nowrap;padding:2px 12px;border:1px solid transparent;border-radius:20px;background:lightblue;font:600 12px/19.5px Arial}</style><main><div class="labels"><a>javascript</a><a>language</a><a>typechecker</a><a>typescript</a></div><p>正文</p></main>',
      {
        javascript: 'javascript',
        language: '语言',
        typechecker: '类型检查器',
        typescript: 'typescript',
        正文: 'Article',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(3);
    const [result] = await f.panel.evaluate(
      async (tabId) =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll('.text') ?? [])]
              .filter((el) => el.textContent === '语言' || el.textContent === '类型检查器')
              .map((el) => {
                const range = document.createRange();
                range.selectNodeContents(el);
                return {
                  text: el.textContent,
                  ink: range.getBoundingClientRect().width,
                  visible: el.getBoundingClientRect().width,
                  font: getComputedStyle(el).fontSize,
                };
              });
          },
        }),
      f.tabId,
    );
    expect(result?.result?.map((row) => row.text)).toEqual(['语言', '类型检查器']);
    for (const row of result?.result ?? []) {
      expect(row.font).toBe('12px');
      expect(row.visible).toBeGreaterThanOrEqual(row.ink - 0.5);
    }
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'does not redistribute restored original labels when a nested neighbor still translates',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><div style="display:flex;width:323px;font:16px/20px Arial;align-items:center"><a href="#home" style="display:block;flex:none;width:126px;height:32px;margin-right:15px;background:blue"></a><div><div style="display:flex;align-items:center;height:20px;margin-right:10px"><div style="display:flex;white-space:nowrap"><span style="max-width:90px;overflow:hidden;text-overflow:ellipsis">某某市</span><i style="width:18px;height:18px;margin-left:5px;background:blue"></i><span style="margin-left:5px">多云</span><span style="margin-left:5px">25℃</span></div><i style="display:block;width:20px;height:20px;margin-left:5px;background:red"></i></div></div></div><p>正文</p></main>',
      {
        某某市: 'Long City Name',
        多云: 'Cloudy',
        '25℃': '25°C',
        正文: 'Article',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    const source = await f.page.locator('span').first().boundingBox();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    const [result] = await f.panel.evaluate(
      async (tabId) =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const city = [...(root?.querySelectorAll('span') ?? [])].find(
              (el) => el.textContent === '某某市',
            );
            return city?.getBoundingClientRect().width;
          },
        }),
      f.tabId,
    );
    expect(result?.result).toBeGreaterThanOrEqual((source?.width ?? Infinity) - 0.5);
    expect((await f.read()).map((r) => r.text)).toContain('Article');
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'restores the source layout as well as text when a compact row falls back',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><div style="display:flex;width:147px;font:16px/20px Arial;white-space:nowrap"><span style="max-width:90px;overflow:hidden;text-overflow:ellipsis">某某市</span><i style="width:18px;height:18px;margin-left:5px;background:blue"></i><span style="margin-left:5px">多云</span><span style="margin-left:5px">25℃</span></div><p>正文</p></main>',
      {
        某某市: 'Long City Name',
        多云: 'Cloudy',
        '25℃': '25°C',
        正文: 'Article',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    const sourceWidths = await f.page
      .locator('main>div>span')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    const [result] = await f.panel.evaluate(
      async (tabId) =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll('main>div>span') ?? [])].map((el) => ({
              text: el.textContent,
              width: el.getBoundingClientRect().width,
            }));
          },
        }),
      f.tabId,
    );
    expect(result?.result).toEqual(
      ['某某市', '多云', '25℃'].map((text, i) => ({
        text,
        width: sourceWidths[i],
      })),
    );
    expect((await f.read()).map((r) => r.text)).toEqual(['Article']);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'retains a tiny bounded readout and a direct button label while translating normal prose',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><div style="width:28px;height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:14px/20px Arial">晴天</div><button style="display:flex;width:28px;height:20px;border:0;padding:0;font:14px/20px Arial">设置</button><p>正文</p></main>',
      { 晴天: 'Sunny', 设置: 'Settings', 正文: 'Article' },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect((await f.read()).map((r) => r.text)).toEqual(['Article']);
    const [result] = await f.panel.evaluate(
      async (tabId) =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelector('main')?.children ?? [])].map((el) => ({
              text: el.textContent,
              font: getComputedStyle(el).fontSize,
            }));
          },
        }),
      f.tabId,
    );
    expect(result?.result).toEqual([
      { text: '晴天', font: '14px' },
      { text: '设置', font: '14px' },
      { text: 'Article', font: '20px' },
    ]);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'keeps an unreadable fixed utility label original without losing adjacent translations',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>button{display:flex;align-items:center;justify-content:space-between;height:38px;border:0;padding:0;font:14px/15px Arial}button i{display:block;flex:none;width:17px;height:17px;background:rgb(0,64,255)}button span{display:block;flex:none}</style><main><div style="position:relative;width:380px;height:38px"><input value="draft" style="width:100%;height:100%;box-sizing:border-box"><button style="position:absolute;right:0;top:0;width:51px"><i></i><span>搜索</span></button></div><button style="width:180px;margin-top:30px"><i></i><span>保存结果</span></button><p style="margin-top:30px;width:270px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">普通新闻标题</p></main>`,
      {
        搜索: 'Search',
        保存结果: 'Save results',
        普通新闻标题: 'A normal news headline with a deliberately longer translated ending',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    const inspect = () =>
      f.panel.evaluate(async (tabId) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const label = [...(root?.querySelectorAll('button span') ?? [])].find(
              (el) => el.textContent === '搜索',
            );
            const icon = label?.closest('button')?.querySelector('i');
            return {
              text: label?.textContent,
              font: label && getComputedStyle(label).fontSize,
              width: label?.getBoundingClientRect().width,
              iconWidth: icon?.getBoundingClientRect().width,
              notice: root?.querySelector('.notice')?.textContent,
              rejections: root?.querySelector<HTMLElement>('[data-translation-rejections]')?.dataset
                .translationRejections,
            };
          },
        });
        return result?.result;
      }, f.tabId);
    await f.toggle();
    for (const phase of ['initial', 'refresh', 'reopen']) {
      if (phase === 'refresh') await f.page.keyboard.press('Alt+KeyR');
      if (phase === 'reopen') {
        await f.page.keyboard.press('Escape');
        await f.toggle();
      }
      await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
      const state = await inspect();
      expect(state).toMatchObject({
        text: '搜索',
        font: '14px',
        width: 28,
        iconWidth: 17,
      });
      expect(state?.notice).toContain('left unchanged');
      expect(JSON.parse(state?.rejections ?? '[]').map((r: string[]) => r[1])).toEqual([
        'label-overflow',
      ]);
      const rows = await f.read();
      expect(rows.map((r) => r.text)).toEqual([
        'Save results',
        'A normal news headline with a deliberately longer translated ending',
      ]);
      const save = rows.find((r) => r.text === 'Save results');
      expect(save?.font).toBe(14);
      expect(save?.paintedBox.right).toBeCloseTo(save?.box.right ?? -1, 1);
      expect(await f.page.locator('main').innerHTML()).toBe(original);
      await expect(f.page.locator('input')).toHaveValue('draft');
    }
    expect(f.requests.flatMap((r) => r.texts)).toContain('搜索');
    expect(f.requests.length).toBe(2);
  },
);

extensionTest(
  'preserves a text-free graphic width while sharing a compact row',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main style="width:360px"><nav style="display:flex;align-items:center;height:32px;gap:8px"><span style="display:block;width:120px;height:24px;flex:0 0 auto;background:rgb(0,64,255)"></span><a href="#label" style="display:block;flex:0 0 auto">新闻</a></nav></main>',
      {
        新闻: 'A considerably longer headline that needs a bounded row budget',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    const box = await f.page.locator('nav>span').boundingBox();
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
            return [...(root?.querySelectorAll('span') ?? [])]
              .find((el) => getComputedStyle(el).backgroundColor === 'rgb(0, 64, 255)')
              ?.getBoundingClientRect()
              .toJSON();
          },
        }),
      f.tabId,
    );
    expect(result?.result?.width).toBeCloseTo(box?.width ?? -1, 0);
    expect(result?.result?.height).toBeCloseTo(box?.height ?? -1, 0);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

extensionTest(
  'shares compact row space without truncating short labels or wrapping their icon',
  async ({ extensionSession }) => {
    const translations = {
      新闻: 'Latest international and regional headlines',
      科技: 'Technology and scientific research developments',
      财经: 'Financial markets and business news',
      教育: 'Educational resources and learning',
      AI: 'AI',
      更多: 'More',
    };
    const f = await setup(
      extensionSession,
      `<style>nav ul{display:flex;align-items:center;padding:16px 0;margin:0;list-style:none;font:18px/20px Arial}nav li{flex:0 0 auto;margin-right:30px}nav li:last-child{margin-right:0}nav a{display:inline-block;position:relative;line-height:20px;white-space:normal}nav svg{vertical-align:middle;margin-left:8px}</style><main style="width:600px"><nav><ul>${Object.keys(
        translations,
      )
        .map(
          (label) =>
            `<li><a href="#${label}">${label}${label === '更多' ? '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 3L6 8L11 3" fill="none" stroke="blue"/></svg>' : ''}</a></li>`,
        )
        .join('')}</ul></nav></main>`,
      translations,
    );
    const original = await f.page.locator('main').innerHTML();
    const nav = await f.page.locator('nav').boundingBox();
    await f.toggle();
    await expect.poll(async () => (await f.read()).length).toBe(5);
    const rows = await f.read();
    const more = rows.find((row) => row.text === 'More');
    if (!more) throw new Error('Missing translated short label');
    expect(more.paintedBox.right - more.paintedBox.left).toBeGreaterThanOrEqual(
      more.box.width - 0.5,
    );
    expect(
      rows.every((row) => row.paintedBox.right <= (nav?.x ?? 0) + (nav?.width ?? 0) + 0.5),
    ).toBe(true);
    const [result] = await f.panel.evaluate(
      async (id) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return root?.querySelector('svg')?.getBoundingClientRect().toJSON();
          },
        }),
      f.tabId,
    );
    const icon = result?.result;
    expect(icon).toBeDefined();
    expect(
      Math.abs((icon?.y ?? 0) + (icon?.height ?? 0) / 2 - more.box.y - more.box.height / 2),
    ).toBeLessThan(4);
    expect(icon?.x).toBeGreaterThanOrEqual(more.box.right);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);
