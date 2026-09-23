import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'retains translated table cells through wheel-driven panning without native scroll events',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
        main{width:800px!important}.port{width:700px;overflow:hidden}
        table{width:700px;table-layout:fixed;border-collapse:collapse}
        td{padding:10px;border:1px solid #ccc}
      </style><main><div class="port"><table><tr><td>模块</td><td>职责</td><td>部署</td></tr></table></div></main>`,
      { 模块: 'Module', 职责: 'Responsibilities', 部署: 'Deployment' },
    );
    await f.page.locator('.port').evaluate((el) => {
      let x = 0;
      el.setAttribute('data-scroll-events', '0');
      el.addEventListener('scroll', () => {
        el.setAttribute(
          'data-scroll-events',
          String(Number(el.getAttribute('data-scroll-events')) + 1),
        );
      });
      el.addEventListener(
        'wheel',
        (event) => {
          if (!(event instanceof WheelEvent) || event.ctrlKey || !event.deltaX) return;
          event.preventDefault();
          x -= event.deltaX;
          const table = el.querySelector('table');
          if (!table) throw new Error('Expected source table');
          table.style.transform = `translateX(${x}px)`;
        },
        { passive: false },
      );
    });
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const before = (await f.read()).find((r) => r.text === 'Responsibilities');
    if (!before) throw new Error('Expected translated table before panning');
    const calls = f.requests.length;
    await f.page.mouse.move(420, 146);
    for (const delta of [120, -120]) {
      await f.page.mouse.wheel(delta, 0);
      await expect(f.page.locator('table')).toHaveCSS(
        'transform',
        delta > 0 ? 'matrix(1, 0, 0, 1, -120, 0)' : 'matrix(1, 0, 0, 1, 0, 0)',
      );
      // Observe beyond the settled gesture as well as the first mutation frame.
      await f.page.waitForTimeout(250);
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Responsibilities');
      const row = (await f.read()).find((r) => r.text === 'Responsibilities');
      expect(row?.box.x).toBeCloseTo(before.box.x - (delta > 0 ? 120 : 0), 1);
      expect(f.requests.length).toBe(calls);
      await expect(f.page.locator('table')).toHaveText('模块职责部署');
    }
    await expect(f.page.locator('.port')).toHaveAttribute('data-scroll-events', '0');
    // Programmatic motion outside a gesture still requires explicit refresh.
    await f.page.locator('table').evaluate((el) => {
      el.style.transform = 'translateX(-50px)';
    });
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .not.toContain('Responsibilities');
    expect(f.requests.length).toBe(calls);
  },
);

extensionTest(
  'keeps static typography readable through viewport and browser zoom changes without model retries',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>
    main{width:520px!important;font:18px/26px Arial}td{border:1px solid #ccc;padding:8px}
    .track{position:relative;width:200px;height:28px;overflow:hidden;margin-top:50px}
    .slide{position:absolute;top:0}@keyframes slide{to{top:-28px}}
  </style><main><h2>模块划分</h2><p>稳定正文</p><table><tr><td>模块</td><td>职责</td></tr></table><div class="track"><span class="slide">轮播文字</span></div></main>`,
      {
        模块划分: 'Module breakdown',
        稳定正文: 'Stable article',
        模块: 'Module',
        职责: 'Responsibility',
        轮播文字: 'Ticker',
      },
    );
    await f.toggle(false);
    await f.page.mouse.move(320, 250);
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Module breakdown');
    await f.page.mouse.move(320, 290);
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Ticker');
    const calls = f.requests.length;
    await f.page.locator('.slide').evaluate(async (el) => {
      (el as HTMLElement).style.animation = 'slide .1s';
      await Promise.all(el.getAnimations().map((a) => a.finished));
      (el as HTMLElement).style.animation = '';
    });
    await expect.poll(async () => (await f.read()).map((r) => r.text)).not.toContain('Ticker');
    for (const factor of [1.25, 1]) {
      await f.panel.evaluate(({ tabId, factor }) => chrome.tabs.setZoom(tabId, factor), {
        tabId: f.tabId,
        factor,
      });
      await f.page.setViewportSize({ width: factor === 1 ? 1100 : 900, height: 900 });
      await f.page
        .locator('main')
        .evaluate(
          (el, size) => ((el as HTMLElement).style.fontSize = size),
          factor === 1 ? '18px' : '20px',
        );
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Module breakdown');
      expect((await f.read()).map((r) => r.text)).not.toContain('Ticker');
    }
    expect(f.requests.length).toBe(calls);
    await f.page.keyboard.press('Alt+KeyR');
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Ticker');
  },
);

for (const height of ['height:16px', 'height:auto'])
  extensionTest(
    `keeps a compact ${height} label separate from an independently positioned numeric ticker`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<style>.header{width:360px;white-space:nowrap;font:12px/16px Arial}.weather{display:inline-block;margin-right:20px;height:16px}.day{display:inline-block;width:16px;height:16px;margin-right:4px}.icon{display:inline-block;width:15px;height:15px;background:#ddd}.condition{display:inline-block;width:24px;${height};margin-left:4px;text-align:center}.port{display:inline-block;position:relative;width:62px;height:16px;overflow:hidden;margin-left:4px}.slide{position:absolute;top:0;left:0;width:62px;height:16px}.second{top:16px}.rating{margin-left:3px}</style><main><div class="header"><a class="weather" href="#weather"><span class="day">今</span><i class="icon"></i><span class="condition">多云</span><span class="port"><span class="slide"><span>23~29°C</span><span class="rating">优</span></span><span class="slide second">晴</span></span></a><a href="#forecast">七日天气</a></div></main>`,
        {
          今: 'Today',
          多云: 'Cloudy',
          '<m0>23~29°C</m0><m1>优</m1>': '<m0>23~29°C</m0> <m1>Good</m1>',
          晴: 'Sunny',
          七日天气: '7-Day Weather',
        },
      );
      const original = await f.page.locator('.condition').boundingBox();
      const numeric = await f.page.locator('.port').boundingBox();
      if (!original || !numeric) throw new Error('Expected compact condition and numeric ticker');
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
      expect((await f.read()).map((row) => row.text)).not.toContain('Cloudy');
      const [result] = await f.panel.evaluate(
        async (tabId) =>
          chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const host = document.querySelector<HTMLElement>(
                '[data-chatbrowserx-overlay=translation]',
              );
              const root = host && chrome.dom.openOrClosedShadowRoot(host);
              const label = [...(root?.querySelectorAll('span') ?? [])].find(
                (el) => el.textContent === '多云' && el.childElementCount === 0,
              );
              return {
                font: label && getComputedStyle(label).fontSize,
                box: label?.getBoundingClientRect().toJSON(),
              };
            },
          }),
        f.tabId,
      );
      expect(result?.result?.font).toBe('12px');
      expect(result?.result?.box?.right).toBeLessThanOrEqual(numeric.x - 3);
      expect(result?.result?.box?.width).toBeCloseTo(original.width, 1);
      expect(result?.result?.box?.left).toBeCloseTo(original.x, 1);
      expect(await f.page.locator('.condition').textContent()).toBe('多云');
    },
  );

extensionTest(
  'keeps neighboring labels stable while a clipped absolute ticker starts and stops',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>@keyframes ticker{from{top:0}to{top:-20px}}.header{width:360px;white-space:nowrap;font:14px/20px Arial}.header>a{display:inline-block;margin-right:20px}.port{display:inline-block;position:relative;width:62px;height:20px;overflow:hidden;margin-right:20px}.slide{position:absolute;top:0;left:0;width:62px;height:20px}.second{top:20px}</style><main><div class="header"><a href="#city">城市</a><span class="port"><span class="slide">晴朗天气</span><span class="slide second">多云天气</span></span><a href="#forecast">天气预报</a><a href="#date">日期</a></div></main>',
      {
        城市: 'City',
        晴朗天气: 'Sunny',
        多云天气: 'Cloudy',
        天气预报: 'Forecast',
        日期: 'Day',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const fixed = () =>
      f.read().then((rows) => rows.filter((r) => !['Sunny', 'Cloudy'].includes(r.text ?? '')));
    const before = await fixed();
    expect(before).toHaveLength(3);
    for (let cycle = 0; cycle < 2; cycle++) {
      await f.page
        .locator('.slide')
        .first()
        .evaluate((el) => {
          (el as HTMLElement).style.animation = 'ticker .9s';
        });
      await f.page.waitForTimeout(250);
      const during = await fixed();
      expect(during.map((r) => r.text)).toEqual(before.map((r) => r.text));
      during.forEach((r, i) => expect(r.box.x).toBeCloseTo(before[i]?.box.x ?? Infinity, 1));
      await f.page
        .locator('.slide')
        .first()
        .evaluate(async (el) => {
          await Promise.all(el.getAnimations().map((a) => a.finished));
          (el as HTMLElement).style.animation = '';
        });
      await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
      const after = await fixed();
      after.forEach((r, i) => expect(r.box.x).toBeCloseTo(before[i]?.box.x ?? Infinity, 1));
    }
    expect((await f.read()).map((r) => r.text)).not.toContain('Sunny');
    await f.page.keyboard.press('Alt+KeyR');
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Sunny');
  },
);

extensionTest(
  'does not rebuild a sliced flow for an unrelated offscreen sibling update',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>第一段</p><p>第二段</p><iframe title="Native media" srcdoc="media"></iframe><aside style="position:absolute;left:-2000px;top:0;width:0;height:0">旧内容</aside></main>',
      { 第一段: 'First paragraph', 第二段: 'Second paragraph', 最新正文: 'Updated prose' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const retained = async (mark: boolean) =>
      f.panel.evaluate(
        async ({ tabId, mark }) => {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (mark) => {
              const host = document.querySelector<HTMLElement>(
                '[data-chatbrowserx-overlay=translation]',
              );
              const group =
                host &&
                chrome.dom.openOrClosedShadowRoot(host)?.querySelector('.translation-group');
              if (mark) group?.setAttribute('data-test-retained', 'yes');
              return group?.getAttribute('data-test-retained');
            },
            args: [mark],
          });
          return r?.result;
        },
        { tabId: f.tabId, mark },
      );
    expect(await retained(true)).toBe('yes');
    await f.page.locator('aside').evaluate((el) => {
      el.textContent = '更新的后台内容';
    });
    await f.page.waitForTimeout(350);
    expect(await retained(false)).toBe('yes');
    expect(f.requests).toHaveLength(1);
    await f.page
      .locator('p')
      .first()
      .evaluate((el) => {
        el.textContent = '最新正文';
      });
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .not.toContain('First paragraph');
    expect(f.requests).toHaveLength(1);
    await f.page.keyboard.press('Alt+KeyR');
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Updated prose');
  },
);

extensionTest(
  'clips a two-line fixed carousel cell before it overlaps the next cell',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.port{position:relative;width:127px;height:34px;overflow:hidden;font:12px/13.8px Arial}ul{position:absolute;top:0;width:127px;margin:0;padding:0;list-style:none}li{float:left;width:127px;height:34px}li a{display:block;font:12px/17px Arial;margin-top:-2px}</style><main><div class="port"><ul><li><a href="#first">第一条标题</a></li><li><a href="#second">第二条标题</a></li></ul></div></main>',
      {
        第一条标题:
          'The previous headline is much longer in English than in Chinese and must not paint into the next fixed carousel cell',
        第二条标题: 'The current headline',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.locator('ul').evaluate((el) => {
      el.style.top = '-34px';
    });
    await expect.poll(async () => (await f.read()).length).toBe(0);
    await f.page.keyboard.press('Alt+KeyR');
    await expect
      .poll(async () =>
        (await f.read()).filter((r) => r.paintedBox.bottom > r.paintedBox.top).map((r) => r.text),
      )
      .toEqual(['The current headline']);
  },
);

extensionTest(
  'keeps fixed-height ticker rows from painting over the following row',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.port{position:relative;width:443px;height:20px;overflow:hidden}ul{position:absolute;top:0;margin:0;padding:0;width:272px;list-style:none}li{height:20px;line-height:20px;font-size:16px}</style><main><div class="port"><ul><li>上一条内容</li><li>本条内容</li></ul></div></main>',
      {
        上一条内容:
          'The previous long translated headline must stay within its original single line',
        本条内容: 'The current translated headline',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const before = (await f.read())[0];
    if (!before) throw new Error('Expected the first ticker translation');
    expect(before.box.height).toBeLessThanOrEqual(20);
    await f.page.locator('ul').evaluate((el) => {
      el.style.top = '-20px';
    });
    await expect.poll(async () => (await f.read()).length).toBe(0);
    await f.page.keyboard.press('Alt+KeyR');
    await expect
      .poll(async () =>
        (await f.read()).filter((r) => r.paintedBox.bottom > r.paintedBox.top).map((r) => r.text),
      )
      .toEqual(['The current translated headline']);
  },
);

extensionTest(
  'preserves individual CSS translation offsets without exposing another ticker slide',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.port{position:relative;width:600px;height:40px;overflow:hidden}.slide{position:absolute;left:0;top:0;width:600px;height:40px}.second{translate:0 80px}</style><main><div class="port"><p class="slide first">当前内容</p><p class="slide second">另一条内容</p></div></main>',
      { 当前内容: 'Current content', 另一条内容: 'Another slide' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.waitForTimeout(350);
    expect(f.requests.flatMap((r) => r.texts)).toEqual(['当前内容']);
    expect((await f.read()).map((r) => r.text)).toEqual(['Current content']);
    await f.page.evaluate(() => {
      const first = document.querySelector<HTMLElement>('.first'),
        second = document.querySelector<HTMLElement>('.second');
      if (!first || !second) throw new Error('Expected ticker slides');
      first.style.translate = '0 -80px';
      second.style.translate = '0 0';
    });
    // The track, not its replaceable slide, owns the manual-refresh boundary.
    await expect.poll(async () => (await f.read()).length).toBe(0);
    await f.page.waitForTimeout(350);
    expect(f.requests.flatMap((r) => r.texts)).toEqual(['当前内容']);
    await f.page.keyboard.press('Alt+KeyR');
    await expect
      .poll(async () =>
        (await f.read()).filter((r) => r.paintedBox.bottom > r.paintedBox.top).map((r) => r.text),
      )
      .toEqual(['Another slide']);
    expect(f.requests.flatMap((r) => r.texts)).toEqual(['当前内容', '另一条内容']);
  },
);

for (const hiddenStyle of ['display:none', 'width:0;height:0;overflow:hidden'])
  extensionTest(
    `ignores changes in an unpainted branch (${hiddenStyle}) but translates it when revealed`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<main><p>可见正文</p><aside style="${hiddenStyle}"><span>隐藏内容</span></aside></main>`,
        { 可见正文: 'Visible prose', '<m0>最新内容</m0>': '<m0>Newly revealed content</m0>' },
      );
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', 'ready');
      const before = await f.panel.evaluate(async (tabId) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const group = root?.querySelector('.translation-group');
            if (!root || !group) throw new Error('Expected the translated reading surface');
            group.setAttribute('data-test-retained', 'yes');
            return root.querySelectorAll('.translation-group').length;
          },
        });
        return r?.result;
      }, f.tabId);
      expect(before).toBe(1);
      await f.page.locator('aside span').evaluate((el) => {
        el.textContent = '最新内容';
      });
      await f.page.waitForTimeout(350);
      const retained = await f.panel.evaluate(async (tabId) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            if (!host) return null;
            return chrome.dom
              .openOrClosedShadowRoot(host)
              ?.querySelector('.translation-group')
              ?.getAttribute('data-test-retained');
          },
        });
        return r?.result;
      }, f.tabId);
      expect(retained).toBe('yes');
      expect(f.requests).toHaveLength(1);
      await f.page.locator('aside').evaluate((el) => {
        el.style.cssText = '';
      });
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Newly revealed content');
    },
  );

extensionTest(
  'retains visible descendants of an empty overflow-visible wrapper',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p>可见正文</p><aside style="height:0;overflow:visible"><span style="float:left">浮动内容</span></aside></main>',
      { 可见正文: 'Visible prose', 浮动内容: 'Visible floating content' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Visible floating content');
  },
);

extensionTest(
  'stops mirroring script-driven motion until manual refresh, then still observes typography changes',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.port{width:900px;height:50px;overflow:hidden}.moving{position:relative;width:900px;height:50px;left:0}</style><main><div class="port"><div class="moving"><p>轮播正文</p></div></div></main>',
      { 轮播正文: 'Rotating content' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const first = (await f.read())[0];
    if (!first) throw new Error('Expected translated text before motion');
    await f.panel.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          if (!host) throw new Error('Expected the translation host');
          chrome.dom
            .openOrClosedShadowRoot(host)
            ?.querySelector('.translation-group')
            ?.setAttribute('data-test-retained', 'yes');
        },
      });
    }, f.tabId);
    await f.page.locator('.moving').evaluate(async (el) => {
      for (let step = 1; step <= 20; step++) {
        (el as HTMLElement).style.left = `${-step}px`;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await f.page.waitForTimeout(350);
    const retained = await f.panel.evaluate(async (tabId) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          if (!host) return null;
          return chrome.dom
            .openOrClosedShadowRoot(host)
            ?.querySelector('.translation-group')
            ?.getAttribute('data-test-retained');
        },
      });
      return r?.result;
    }, f.tabId);
    expect(retained).toBeNull();
    expect(await f.read()).toHaveLength(0);
    expect(f.requests).toHaveLength(1);
    await f.page.keyboard.press('Alt+KeyR');
    await expect
      .poll(async () => (await f.read())[0]?.box.left)
      .toBeCloseTo(first.box.left - 20, 0);
    // Typography changes still invalidate the mirror; the fast path is not a blanket
    // exemption for style attributes or arbitrary carousel-like elements.
    await f.page.locator('.moving').evaluate((el) => {
      (el as HTMLElement).style.fontSize = '24px';
    });
    await expect.poll(async () => (await f.read())[0]?.font).toBe(24);
  },
);

extensionTest(
  'recovers text through manual refresh after a finite entrance animation finishes',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>@keyframes entrance{from{opacity:.5}to{opacity:1}}main{animation:entrance 2s forwards}</style><main><p>正文内容</p></main>',
      { 正文内容: 'Readable article content' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    await f.page.locator('main').evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((a) => a.finished));
    });
    expect(f.requests).toHaveLength(0);
    await f.page.keyboard.press('Alt+KeyR');
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(['Readable article content']);
  },
);

extensionTest(
  'translates highlighted headings and keeps color-only keyframes separate from moving content',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>@keyframes highlight{from{background-color:#fff;color:#222}to{background-color:#ffe680;color:#000}}.highlight{animation:highlight 10s infinite}</style><main><h2 class="highlight">模块划分</h2><p>正文内容</p><table><tr><td>模块名称</td><td>职责</td></tr></table></main>',
      {
        模块划分: 'Module breakdown',
        正文内容: 'Article content',
        模块名称: 'Module name',
        职责: 'Responsibilities',
      },
    );
    const source = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual([
      'Module breakdown',
      'Article content',
      'Module name',
      'Responsibilities',
    ]);
    await f.page.locator('main').evaluate((el) => {
      el.animate([{ backgroundColor: '#fff' }, { backgroundColor: '#ffe680' }], {
        duration: 10000,
        iterations: Infinity,
      });
    });
    await f.page.keyboard.press('Alt+KeyR');
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect(await f.read()).toHaveLength(4);
    expect(await f.page.locator('main').innerHTML()).toBe(source);
    // A concurrent movement must still remain native until explicitly refreshed.
    await f.page.locator('h2').evaluate((el) => {
      el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(10px)' }], {
        duration: 10000,
        iterations: Infinity,
      });
    });
    await f.page.keyboard.press('Alt+KeyR');
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect((await f.read()).map((r) => r.text)).not.toContain('Module breakdown');
    expect((await f.read()).map((r) => r.text)).toContain('Article content');
  },
);

extensionTest(
  'translates a stationary heading beneath a color-only animated highlight mask',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>@keyframes flash{from{background-color:#ffe680}to{background-color:transparent}}.section{position:relative}.mask{position:absolute;inset:0;pointer-events:none;animation:flash 10s infinite}</style><main><div class="section"><h2>模块划分</h2><div class="mask"></div></div><p>正文内容</p></main>',
      { 模块划分: 'Module breakdown', 正文内容: 'Article content' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(['Module breakdown', 'Article content']);
    await f.page.locator('.mask').evaluate((el) => el.remove());
    await f.page.keyboard.press('Alt+KeyR');
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toContain('Module breakdown');
  },
);

extensionTest(
  'keeps translated prose during a color-only link transition',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>a{transition:color 2s;color:black}a.active{color:blue}</style><main><p>正常正文</p><a href="#next">文档链接</a></main>',
      { 正常正文: 'Normal prose', 文档链接: 'Document link' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.locator('a').evaluate((el) => {
      el.classList.add('active');
    });
    await f.page.waitForTimeout(300);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(['Normal prose', 'Document link']);
    expect(f.requests).toHaveLength(1);
  },
);
