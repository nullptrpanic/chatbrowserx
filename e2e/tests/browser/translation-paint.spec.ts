import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'translates static translated virtual rows without changing their source',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main><div style="position:relative;height:150px;overflow:auto"><div style="height:800px"><div style="position:absolute;transform:translateY(50px);width:500px;height:32px"><a>虚拟列表标题</a></div></div></div><canvas width="500" height="40"></canvas></main>`,
      { '<m0>虚拟列表标题</m0>': '<m0>Virtual list heading</m0>' },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toEqual(['Virtual list heading']);
    const translated = (await f.read())[0];
    const original = await f.page.locator('a').boundingBox();
    if (!translated || !original) throw new Error('Source or translated row missing');
    expect(Math.abs(translated.box.y - original.y)).toBeLessThan(1);
    expect(translated.font).toBe(20);
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
  },
);

extensionTest(
  'retains a static sibling backdrop behind white navigation text',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>.paint{position:absolute;left:60px;top:120px;width:900px;height:100px;background:linear-gradient(#1452aa,#1452aa)}nav{position:relative;color:white;height:60px;display:flex;gap:40px}nav a{position:relative}</style><div class="paint"></div><main><nav><a>新闻</a><a>科技</a></nav><canvas width="900" height="40"></canvas></main>`,
      { 新闻: 'News', 科技: 'Technology' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const screenshot = await f.page.screenshot();
    const pixel = await f.panel.evaluate(
      async (png) => {
        const image = await createImageBitmap(await (await fetch(png)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(400, 150, 1, 1).data];
      },
      `data:image/png;base64,${screenshot.toString('base64')}`,
    );
    expect(pixel).toEqual([20, 82, 170, 255]);
  },
);

extensionTest(
  'keeps masks and icon sizes in a translated flex label',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main><a style="display:flex;align-items:center;width:280px;white-space:nowrap;overflow:hidden"><i style="display:block;width:24px;height:24px;flex-shrink:0;background:#234;mask-image:linear-gradient(transparent 50%,black 50%)"></i><svg width="24" height="24" style="width:24px;height:24px"><circle cx="12" cy="12" r="10"/></svg><span>腾讯新闻</span></a><canvas width="400" height="30"></canvas></main>`,
      { 腾讯新闻: 'Tencent News and latest international headlines' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const icons = await f.panel.evaluate(async (tabId) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          if (!root) throw new Error('Mirror missing');
          return [...root.querySelectorAll('.translation-group i,.translation-group svg')].map(
            (el) => ({
              width: el.getBoundingClientRect().width,
              mask: getComputedStyle(el).maskImage,
            }),
          );
        },
      });
      return r?.result;
    }, f.tabId);
    expect(icons).toHaveLength(2);
    expect(icons?.[0]?.mask).toContain('linear-gradient');
    expect(icons?.[1]?.width).toBe(24);
  },
);

extensionTest(
  'collects text revealed when a translated article contracts',
  async ({ extensionSession }) => {
    const long = '这是一段很长的说明文字。'.repeat(55);
    const f = await setup(
      extensionSession,
      `<main style="width:450px;margin:400px 350px"><p>${long}</p><h2>后面的标题</h2><p>后面的内容</p></main>`,
      {
        [long]: 'Short introduction.',
        后面的标题: 'Following heading',
        后面的内容: 'Following paragraph.',
      },
    );
    expect((await f.page.locator('h2').boundingBox())?.y).toBeGreaterThan(900);
    await f.toggle(false);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toEqual(['Short introduction.', 'Following heading', 'Following paragraph.']);
    // Unrelated hydration/attribute updates must not drop already translated blocks
    // whose source is off-screen but whose shorter, reflowed copy is now visible.
    await f.page.locator('main').evaluate((el) => el.setAttribute('data-hydrated', 'true'));
    await f.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toEqual(['Short introduction.', 'Following heading', 'Following paragraph.']);
    await expect(f.page.locator('h2')).toHaveText('后面的标题');
    const requests = f.requests.length;
    await f.page.keyboard.press('Escape');
    await f.toggle(false);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toEqual(['Short introduction.', 'Following heading', 'Following paragraph.']);
    expect(f.requests).toHaveLength(requests);
  },
);

extensionTest(
  'keeps background-image icons at their original size beside longer labels',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main><a style="display:flex;align-items:center;width:200px;white-space:nowrap;overflow:hidden"><i style="display:block;width:24px;height:24px;background-image:linear-gradient(blue,blue)"></i><span>新闻</span></a><canvas width="400" height="30"></canvas></main>`,
      { 新闻: 'International news and latest updates' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const width = await f.panel.evaluate(async (tabId) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return root?.querySelector('.translation-group i')?.getBoundingClientRect().width;
        },
      });
      return r?.result;
    }, f.tabId);
    expect(width).toBe(24);
  },
);

extensionTest(
  'translates a headline containing a small animated decoration',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>@keyframes pulse{from{opacity:.4}to{opacity:1}}.dot{display:inline-block;width:12px;height:12px;animation:pulse .5s infinite alternate;background:blue}</style><main><p><i class="dot"></i>实时新闻标题</p><canvas width="600" height="80"></canvas></main>`,
      { 实时新闻标题: 'Live news headline' },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(['Live news headline']);
    expect(await f.page.locator('.dot').evaluate((el) => el.getAnimations()[0]?.playState)).toBe(
      'running',
    );
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
  },
);

extensionTest(
  'keeps sticky navigation above the independently scrolling translation',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<header style="position:sticky;top:0;z-index:10;height:50px;background:blue;color:white">固定导航</header><main style="margin-top:0;height:1400px;background:white"><p>文章内容</p><p style="margin-top:300px">后面的段落</p></main>`,
      {
        固定导航: 'Sticky navigation',
        文章内容: 'Article content',
        后面的段落: 'Later content',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.mouse.move(500, 400);
    await f.page.mouse.wheel(0, 150);
    await expect.poll(() => f.page.evaluate(() => scrollY)).toBeGreaterThan(100);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const png = await f.page.screenshot();
    const pixel = await f.panel.evaluate(
      async (data) => {
        const image = await createImageBitmap(await (await fetch(data)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height),
          ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(800, 40, 1, 1).data];
      },
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(pixel).toEqual([0, 0, 255, 255]);
  },
);

extensionTest(
  'keeps native sticky controls above translated article content while scrolling',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<header style="position:sticky;top:0;z-index:10;height:70px;background:blue"><input aria-label="Search" style="width:100px"></header><main style="margin-top:0;height:1400px;background:white"><p>文章内容</p><p style="margin-top:300px">后面的段落</p></main>`,
      { 文章内容: 'Article content', 后面的段落: 'Later content' },
    );
    const original = await f.page.locator('header').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.mouse.move(500, 400);
    await f.page.mouse.wheel(0, 150);
    await expect.poll(() => f.page.evaluate(() => scrollY)).toBeGreaterThan(100);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    // Playwright screenshots temporarily hide input carets, serializing inline styles.
    // Assert extension invariance before that screenshot-only browser mutation.
    await expect(f.page.locator('header')).toHaveJSProperty('outerHTML', original);
    const png = await f.page.screenshot();
    const pixel = await f.panel.evaluate(
      async (data) => {
        const image = await createImageBitmap(await (await fetch(data)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height),
          ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.drawImage(image, 0, 0);
        return [...ctx.getImageData(800, 40, 1, 1).data];
      },
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(pixel).toEqual([0, 0, 255, 255]);
  },
);

extensionTest(
  'clips only a floating native panel footprint, not the surrounding translation',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main style="background:#eee;height:600px"><p>文章内容</p></main><aside style="position:fixed;left:400px;top:300px;z-index:10;width:120px;height:100px;background:blue"><input aria-label="Search" style="width:50px"></aside>`,
      { 文章内容: 'Article content' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const png = await f.page.screenshot();
    const pixels = await f.panel.evaluate(
      async (data) => {
        const image = await createImageBitmap(await (await fetch(data)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height),
          ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas missing');
        ctx.drawImage(image, 0, 0);
        return [450, 550].map((x) => [...ctx.getImageData(x, 350, 1, 1).data]);
      },
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(pixels).toEqual([
      [0, 0, 255, 255],
      [238, 238, 238, 255],
    ]);
    expect((await f.read()).map((r) => r.text)).toEqual(['Article content']);
  },
);

for (const position of ['fixed', 'sticky'])
  extensionTest(
    `protects the painted children of a transparent ${position} dynamic shell without rejecting neighboring prose`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<style>aside{position:${position};float:left;left:0;top:100px;width:240px;height:360px;z-index:10}aside span{display:block;width:80px;background:blue;color:white}main{margin:120px 0 0 260px!important;width:600px!important}.wide{margin-left:-120px}</style><aside><span>菜单</span></aside><main><p class="wide">静态正文</p></main>`,
        { 菜单: 'Menu', 静态正文: 'Static body content' },
      );
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Static body content');
      const calls = f.requests.length;
      await f.page.locator('aside').evaluate((el) => {
        el.style.transform = 'translateX(-60px)';
      });
      await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Static body content');
      expect((await f.read()).map((r) => r.text)).not.toContain('Menu');
      expect(f.requests.length).toBe(calls);
      await expect(f.page.locator('main')).toHaveText('静态正文');
      await expect(f.page.locator('aside')).toHaveText('菜单');
      const png = await f.page.screenshot();
      const box = await f.page.locator('aside span').boundingBox();
      if (!box) throw new Error('Expected native menu');
      const pixel = await f.panel.evaluate(
        async ({ data, x, y }) => {
          const image = await createImageBitmap(await (await fetch(data)).blob());
          const canvas = new OffscreenCanvas(image.width, image.height),
            ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas missing');
          ctx.drawImage(image, 0, 0);
          return [...ctx.getImageData(x, y, 1, 1).data];
        },
        {
          data: `data:image/png;base64,${png.toString('base64')}`,
          x: 10,
          y: box.y + box.height - 2,
        },
      );
      expect(pixel).toEqual([0, 0, 255, 255]);
    },
  );

extensionTest(
  'does not reject a text label beside a doubly clipped accessibility control',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main><div style="display:flex;position:relative"><span style="display:flex;width:460px">编码令牌</span><label style="position:relative"><span style="position:absolute;left:-1px;top:10px;width:1px;height:1px;overflow:hidden;clip:rect(0px,0px,0px,0px);clip-path:inset(50%)"><input type="checkbox" aria-label="Option"></span><span>选项</span></label></div></main>`,
      { 编码令牌: 'Encoded token', '<m0>选项</m0>': '<m0>Option</m0>' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(['Encoded token', 'Option']);
    await expect(f.page.locator('input')).not.toBeChecked();
  },
);

for (const populated of [false, true])
  extensionTest(
    `uses only painted content in a ${populated ? 'populated' : 'empty'} transparent fixed shell`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<main><article style="height:600px;background:#ddd">文章标题</article><canvas width="600" height="40"></canvas></main>
        <div style="position:fixed;z-index:20;left:60px;top:120px;width:900px;height:400px;pointer-events:none">
          <div style="padding:16px"></div>
          ${populated ? '<div style="position:absolute;left:300px;top:70px;width:180px;height:45px;background:blue"><input aria-label="Native control"></div>' : ''}
        </div>`,
        { 文章标题: 'Article heading' },
      );
      const original = await f.page.locator('body').evaluate((el) => el.innerHTML);
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', 'ready');
      const coverage = await f.panel.evaluate(async (tabId) => {
        const [reply] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const group = root?.querySelector<HTMLElement>('.translation-group');
            if (!group) throw new Error('Missing translation');
            const box = group.getBoundingClientRect();
            const clip = group.style.clipPath;
            if (!clip.startsWith('path(')) return { clip };
            const context = new OffscreenCanvas(1, 1).getContext('2d');
            if (!context) throw new Error('Missing canvas context');
            const path = new Path2D(JSON.parse(clip.slice(5, -1)));
            return {
              clip,
              emptySpace: context.isPointInPath(path, 300 - box.x, 140 - box.y),
              nativePanel: context.isPointInPath(path, 400 - box.x, 210 - box.y),
            };
          },
        });
        return reply?.result;
      }, f.tabId);
      if (populated) expect(coverage).toMatchObject({ emptySpace: true, nativePanel: false });
      else expect(coverage?.clip).toMatch(/^inset\(/);
      expect((await f.read()).map((row) => row.text)).toEqual(['Article heading']);
      expect(await f.page.locator('body').evaluate((el) => el.innerHTML)).toBe(original);
    },
  );

extensionTest(
  'preserves the scroll window of a virtualized sidebar inside a percent-height shell',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<aside style="position:fixed;top:0;left:30px;width:300px;height:100%;display:flex;flex-direction:column"><header style="height:60px;flex:none">导航</header><div class="port" style="flex:1;min-height:0;overflow:auto"><div style="height:3000px;position:relative"><div style="position:absolute;transform:translateY(1500px)"><p>当前列表标题</p></div></div></div></aside>`,
      { 导航: 'Navigation', 当前列表标题: 'Current list heading' },
    );
    await f.page.locator('.port').evaluate((el) => {
      el.scrollTop = 1400;
    });
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const row = (await f.read()).find((r) => r.text === 'Current list heading');
    expect(row?.paintedBox.top).toBeGreaterThan(60);
    expect(row?.paintedBox.bottom).toBeLessThan(250);
    expect(row?.paintedBox.bottom).toBeGreaterThan(row?.paintedBox.top ?? 0);
    expect(await f.page.locator('.port').evaluate((el) => el.scrollTop)).toBe(1400);
  },
);

extensionTest(
  'keeps a narrow utility label original beside live media instead of showing an abbreviation',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<canvas width="790" height="120" style="position:absolute;left:0;top:160px"></canvas><aside style="position:fixed;left:800px;top:180px;width:40px;height:60px;display:flex;flex-direction:column;align-items:center;font:12px/20px Arial;background:white"><i style="width:20px;height:20px;background:blue"></i><span>无障碍</span></aside>`,
      { 无障碍: 'Accessibility' },
    );
    await f.toggle();
    const original = await f.page.locator('aside').innerHTML();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect((await f.read()).map((r) => r.text)).not.toContain('Accessibility');
    const [result] = await f.panel.evaluate(
      async (tabId) =>
        chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const copy = root?.querySelector('aside');
            const label = copy?.querySelector('span');
            return {
              text: label?.textContent,
              font: label && getComputedStyle(label).fontSize,
              box: label?.getBoundingClientRect().toJSON(),
              iconWidth: copy?.querySelector('i')?.getBoundingClientRect().width,
            };
          },
        }),
      f.tabId,
    );
    expect(result?.result).toMatchObject({ text: '无障碍', font: '12px', iconWidth: 20 });
    expect(result?.result?.box?.left).toBeGreaterThanOrEqual(800);
    expect(result?.result?.box?.right).toBeLessThanOrEqual(840);
    expect(await f.page.locator('aside').innerHTML()).toBe(original);
  },
);
extensionTest(
  'retains an opaque fixed header above a scrolled native iframe',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<header style="position:fixed;left:60px;top:0;width:900px;height:46px;background:white;z-index:100">固定导航</header><main><iframe title="Advertisement" srcdoc="Native media" style="width:900px;height:320px;border:0"></iframe><p>后续正文</p><div style="height:2000px"></div></main>',
      { 固定导航: 'Fixed navigation', 后续正文: 'Following prose' },
    );
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Fixed navigation');
    await f.page.evaluate(() => window.scrollTo(0, 180));
    await f.page.waitForTimeout(350);
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Fixed navigation');
    await f.page.locator('iframe').evaluate((el) => {
      Object.assign(el.style, {
        position: 'fixed',
        top: '0',
        left: '60px',
        zIndex: '200',
        background: 'red',
      });
    });
    await f.page.waitForTimeout(350);
    // A completely clipped copy may remain mounted; assert visible native pixels,
    // not absence from the shadow DOM, when the iframe moves into the foreground.
    const png = await f.page.screenshot();
    const pixel = await f.panel.evaluate(
      async (data) => {
        const image = await createImageBitmap(await (await fetch(data)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas missing');
        context.drawImage(image, 0, 0);
        return [...context.getImageData(400, 20, 1, 1).data];
      },
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(pixel).toEqual([255, 0, 0, 255]);
  },
);

extensionTest(
  'clips an empty fixed wrapper baseline without hiding native pixels underneath',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<header style="position:fixed;left:60px;top:0;width:900px;height:46px;z-index:100"><nav style="height:45px;background:white"><a>固定导航</a></nav></header><main><iframe title="Advertisement" srcdoc="Native media" style="width:900px;height:320px;border:0;background:red"></iframe><p>后续正文</p><div style="height:2000px"></div></main>',
      { '<m0>固定导航</m0>': '<m0>Fixed navigation</m0>', 后续正文: 'Following prose' },
    );
    await f.toggle();
    await f.page.evaluate(() => window.scrollTo(0, 180));
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Fixed navigation');
    const png = await f.page.screenshot();
    const pixel = await f.panel.evaluate(
      async (data) => {
        const image = await createImageBitmap(await (await fetch(data)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas missing');
        context.drawImage(image, 0, 0);
        return [...context.getImageData(400, 45, 1, 1).data];
      },
      `data:image/png;base64,${png.toString('base64')}`,
    );
    expect(pixel).toEqual([255, 0, 0, 255]);
  },
);

for (const background of ['transparent', 'rgba(255,255,255,.5)'])
  extensionTest(
    `does not back a ${background} fixed label with white over native media`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<header style="position:fixed;left:60px;top:0;width:900px;height:46px;background:${background};z-index:100">固定导航</header><main><iframe title="Advertisement" srcdoc="Native media" style="width:900px;height:320px;border:0"></iframe><p>后续正文</p><div style="height:2000px"></div></main>`,
        { 固定导航: 'Fixed navigation', 后续正文: 'Following prose' },
      );
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .toContain('Fixed navigation');
      await f.page.evaluate(() => window.scrollTo(0, 180));
      await f.page.waitForTimeout(350);
      await expect
        .poll(async () => (await f.read()).map((r) => r.text))
        .not.toContain('Fixed navigation');
    },
  );

extensionTest(
  'ignores clipped source control labels when protecting a fixed header above media',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<header style="position:fixed;left:60px;top:0;width:900px;height:46px;z-index:100;font:12px/20px Arial"><nav style="height:45px;background:white"><a href="#nav">固定导航</a><a href="#close" style="position:absolute;left:800px;top:14px;width:24px;height:21px;overflow:hidden;line-height:21px">关闭取消固定</a></nav></header><main><iframe title="Advertisement" srcdoc="Native media" style="width:900px;height:320px;border:0"></iframe><p>后续正文</p><div style="height:2000px"></div></main>',
      { 固定导航: 'Fixed navigation', 关闭取消固定: 'Unpin', 后续正文: 'Following prose' },
    );
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Fixed navigation');
    await f.page.evaluate(() => window.scrollTo(0, 180));
    await f.page.waitForTimeout(350);
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Fixed navigation');
    await expect(f.page.locator('a[href="#close"]')).toHaveText('关闭取消固定');
  },
);

extensionTest(
  'does not let fixed prose expansion cover previously visible native media',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<header style="position:fixed;left:60px;top:0;width:300px;background:white;z-index:100">正文</header><main><iframe title="Advertisement" srcdoc="Native media" style="width:900px;height:320px;border:0"></iframe><p>后续正文</p><div style="height:2000px"></div></main>',
      {
        正文: 'Expanded prose needs several lines of space and cannot be allowed to hide visible media below this fixed header.',
        后续正文: 'Following prose',
      },
    );
    await f.toggle();
    await f.page.evaluate(() => window.scrollTo(0, 180));
    await f.page.waitForTimeout(350);
    await expect
      .poll(async () => (await f.read()).some((r) => r.text?.startsWith('Expanded prose')))
      .toBe(false);
    await expect(f.page.locator('header')).toHaveText('正文');
  },
);
