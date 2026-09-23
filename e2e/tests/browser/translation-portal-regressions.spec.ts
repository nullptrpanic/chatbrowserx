import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

for (const surface of ['animated', 'iframe', 'visible-iframe', 'unknown-clip'] as const)
  extensionTest(
    `protects only the visible native footprint of a ${surface} surface above an ordinary menu`,
    async ({ extensionSession }, info) => {
      const labels = ['普通新闻', '网站推荐', '实用工具'];
      const translations = {
        普通新闻: 'News',
        网站推荐: 'Recommended Sites',
        实用工具: 'Useful Tools',
      };
      const clipped = surface === 'animated' || surface === 'iframe';
      const f = await setup(
        extensionSession,
        `<style>
          main{width:590px!important;font:14px/20px Arial}
          .links{display:flex;gap:30px;height:30px}
          .viewport{position:absolute;top:60px;left:60px;width:590px;height:${surface === 'unknown-clip' ? 180 : 24}px;${clipped ? 'overflow:hidden' : ''};${surface === 'unknown-clip' ? 'clip-path:circle(500px)' : ''}}
          .surface{position:relative;top:-100px;display:block;width:590px;height:180px;border:0}
          .moving{animation:ticker 60s infinite;font:14px/20px Arial}
          @keyframes ticker{from{transform:translateY(0)}to{transform:translateY(2px)}}
        </style><div class="viewport">${surface === 'animated' ? '<div class="surface moving">动态消息<br>动态消息<br>动态消息<br>动态消息<br>动态消息<br>动态消息<br>动态消息</div>' : '<iframe class="surface" title="Native media" srcdoc="Native media"></iframe>'}</div>
        <main><div class="links">${labels.map((label, i) => `<a href="#${i}">${label}</a>`).join('')}</div></main>`,
        translations,
      );
      const original = await f.page.locator('main').innerHTML();
      await f.toggle();
      await expect(f.lens).toHaveAttribute(
        'data-status',
        surface === 'iframe' ? 'ready' : 'unsupported',
      );
      await expect
        .poll(async () => (await f.read()).map((row) => row.text))
        .toEqual(clipped ? Object.values(translations) : []);
      expect(f.requests.flatMap((r) => r.texts)).not.toContain('动态消息');
      expect(await f.page.locator('main').innerHTML()).toBe(original);
      await f.page.screenshot({ path: info.outputPath(`${surface}-native-footprint.png`) });
    },
  );

extensionTest(
  'keeps a margin-padded clipped inline menu translated above native media',
  async ({ extensionSession }, info) => {
    const labels = ['网站推荐', '新闻一', '新闻二', '新闻三', '新闻四', '新闻五', '新闻六'];
    const translations = Object.fromEntries(
      labels.map((label, index) => [label, `Recommended news publication number ${index + 1}`]),
    );
    const f = await setup(
      extensionSession,
      `<style>
        main{width:590px!important;font:14px/16.1px Arial}
        .links{height:28px;position:relative;overflow:hidden;border:1px solid #ddd}
        .links a{display:inline-block;line-height:20px;margin:4px 37px 4px 0}
        .links a:first-child{margin-left:10px}.links a:last-child{margin-right:0}
        iframe{display:block;margin-top:10px;width:590px;height:90px;border:0}
      </style><main><div><div class="links">${labels.map((label, i) => `<a href="#${i}">${label}</a>`).join('')}</div></div>
      <iframe title="Native media" srcdoc="Native media"></iframe></main>`,
      translations,
    );
    const original = await f.page.locator('main').innerHTML();
    const menu = await f.page.locator('.links').boundingBox();
    if (!menu) throw new Error('Expected the clipped inline menu');
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.map((row) => row.text)).toEqual(Object.values(translations));
    rows.forEach((row, i) => {
      expect(row.font).toBe(14);
      expect(row.paintedBox.top).toBeGreaterThanOrEqual(menu.y);
      expect(row.paintedBox.bottom).toBeLessThanOrEqual(menu.y + menu.height);
      expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThan(24);
      if (i > 0)
        expect(row.paintedBox.left).toBeGreaterThan(rows[i - 1]?.paintedBox.right ?? Infinity);
    });
    expect(await f.page.locator('main').innerHTML()).toBe(original);
    await f.page.screenshot({ path: info.outputPath('clipped-inline-menu.png') });
  },
);

extensionTest(
  'preserves separate nowrap utility label slots beside a deferred animated cell',
  async ({ extensionSession }, info) => {
    const f = await setup(
      extensionSession,
      `<style>
        .toolbar{display:flex;align-items:center;width:500px;font:14px/16.1px Arial}
        .toolbar>*{margin-right:16px;white-space:nowrap}
        .label{display:flex;width:56px}.nested{width:56px;line-height:34px}
        .service{display:flex;width:62px;position:relative}
        .badge{position:absolute;right:-8px;top:-10px;width:20px;height:8px;background:red}
        .login{display:flex;width:82px;line-height:38px}
        .moving{width:100px;height:30px;animation:ticker 60s infinite}
        @keyframes ticker{from{transform:translateY(0)}to{transform:translateY(2px)}}
      </style><main><div class="toolbar"><div class="label">网页设置</div>
      <div class="nested"><div>快速访问</div></div><a class="service" href="#service">技能服务<span class="badge"></span></a>
      <a class="login" href="#login">登录</a><div class="moving">动态内容</div></div></main>`,
      {
        网页设置: 'Webpage Settings',
        快速访问: 'Quick Access',
        技能服务: 'Skills Services',
        登录: 'Log in',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    const slots = await f.page
      .locator('.toolbar > :not(.moving)')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    const rows = await f.read();
    expect(rows).toHaveLength(4);
    rows.forEach((row, index) => {
      expect(row.font).toBe(14);
      expect(row.paintedBox.left).toBeGreaterThanOrEqual(slots[index]?.left ?? Infinity);
      expect(row.paintedBox.right).toBeLessThanOrEqual(slots[index]?.right ?? 0);
      expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThan(24);
    });
    expect(f.requests.flatMap((r) => r.texts)).not.toContain('动态内容');
    expect(await f.page.locator('main').innerHTML()).toBe(original);
    await f.page.screenshot({ path: info.outputPath('native-toolbar-cell.png') });
  },
);

extensionTest(
  'keeps mixed compact toolbar labels separated without shrinking fonts or clipping icons',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.toolbar{display:flex;align-items:center;justify-content:flex-end;width:550px;font:14px/16px Arial}.toolbar>*{margin-right:16px;white-space:nowrap}.toolbar>:last-child{margin:0}.icon{width:32px;height:32px;background:orange;border-radius:50%;flex-shrink:0}.label{width:56px;display:flex}.nested{width:56px;line-height:34px}.service{width:61px;display:flex;position:relative}.badge{position:absolute;right:-8px;top:-10px;width:20px;height:8px;background:red}.login{display:flex;width:82px;line-height:38px}.download{width:135px}.download>a{display:flex;align-items:center}.download i{width:16px;height:16px;background:gray;flex-shrink:0;margin-right:4px}</style><main><div class="toolbar"><a class="icon" href="#mail"></a><a class="icon" href="#games"></a><div class="label">网页设置</div><div class="nested"><div>快速访问</div></div><a class="service" href="#service">技能服务<span class="badge"></span></a><a class="login" href="#login">登录</a><div class="download"><a href="#download"><i></i><span>安装电脑版</span></a></div></div></main>',
      {
        网页设置: 'Webpage Settings',
        快速访问: 'Quick Access',
        技能服务: 'Skills Services',
        登录: 'Log in',
        安装电脑版: 'Install Desktop App',
      },
    );
    const original = await f.page.locator('main').innerHTML();
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(5);
    rows.forEach((row, index) => {
      expect(row.font).toBe(14);
      expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThan(24);
      if (index > 0)
        expect(
          row.paintedBox.left - (rows[index - 1]?.paintedBox.right ?? Infinity),
        ).toBeGreaterThanOrEqual(6.5);
    });
    const icons = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll('.translation-group a') ?? [])]
            .filter((el) => ['#mail', '#games'].includes(el.getAttribute('href') ?? ''))
            .map((el) => el.getBoundingClientRect().width);
        },
      });
      return result?.result;
    }, f.tabId);
    expect(icons).toEqual([32, 32]);
    expect(await f.page.locator('main').innerHTML()).toBe(original);
  },
);

for (const visibility of ['visible', 'visibility:hidden', 'opacity:0', 'display:none'])
  extensionTest(
    `preserves the ${visibility} separator spacing between translated inline headlines`,
    async ({ extensionSession }) => {
      const first = 'Major projects have received upgrades';
      const second = 'Wings of innovation';
      const f = await setup(
        extensionSession,
        `<style>.headlines{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:1;overflow:hidden;text-overflow:ellipsis;width:900px;font:26px/38px Arial}.headlines a{margin:0 .5px}.separator{margin:0 5px;${visibility === 'visible' ? '' : visibility}}</style><main><div class="headlines"><a href="#one">工程项目有了新升级</a><span class="separator">|</span><a href="#two">创新之翼</a></div></main>`,
        { 工程项目有了新升级: first, 创新之翼: second },
      );
      const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
      const sourceGap = await f.page.locator('.headlines').evaluate((el) => {
        const [first, second] = el.querySelectorAll('a');
        if (!first || !second) throw new Error('Missing source headlines');
        return second.getBoundingClientRect().left - first.getBoundingClientRect().right;
      });
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((row) => row.text))
        .toEqual([first, second]);
      const [a, b] = await f.read();
      if (!a || !b) throw new Error('Missing translated headlines');
      expect(b.box.top).toBe(a.box.top);
      expect(b.box.left - a.box.right).toBeCloseTo(sourceGap, 0);
      await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
    },
  );

extensionTest(
  'keeps an invisible text spacer untranslatable and non-interactive in the copy',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main><p><a href="#one">第一条</a><a href="#hidden" style="opacity:0;margin:0 5px">隐藏操作</a><a href="#two">第二条</a></p></main>',
      { 第一条: 'First story', 第二条: 'Second story' },
    );
    const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((row) => row.text)).toEqual(['First story', 'Second story']);
    const hidden = await f.panel.evaluate(async (tabId) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          const spacer = root?.querySelector<HTMLAnchorElement>('a[href="#hidden"]');
          if (!spacer || !root) return null;
          const box = spacer.getBoundingClientRect();
          const hit = root.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return {
            width: box.width,
            opacity: getComputedStyle(spacer).opacity,
            ariaHidden: spacer.getAttribute('aria-hidden'),
            receivesPointer: hit === spacer || (hit !== null && spacer.contains(hit)),
          };
        },
      });
      return r?.result;
    }, f.tabId);
    expect(hidden?.width).toBeGreaterThan(0);
    expect(hidden?.opacity).toBe('0');
    expect(hidden?.ariaHidden).toBe('true');
    expect(hidden?.receivesPointer).toBe(false);
    expect(f.requests.flatMap((r) => r.texts)).not.toContain('隐藏操作');
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
  },
);

for (const native of [true, false])
  extensionTest(
    `keeps linked headlines ${native ? 'inside their row budget above native media' : 'naturally wrapping in an unconstrained flow'}`,
    async ({ extensionSession }) => {
      const first = 'An expanded translated headline with enough words to wrap over several lines';
      const second = 'Another detailed translated news headline that needs more than one line';
      const f = await setup(
        extensionSession,
        `<style>.news{width:340px;list-style:none;padding:0;margin:0;font:18px/28px Arial}.news p{margin:0}canvas{display:block}</style><main style="width:340px"><ul class="news"><li><p><a href="#first">第一条新闻标题</a></p></li><li><a href="#second">第二条新闻标题</a></li></ul>${native ? '<canvas width="340" height="150"></canvas>' : ''}</main>`,
        { 第一条新闻标题: first, 第二条新闻标题: second },
      );
      const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
      const rows = await f.page
        .locator('.news>li')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((row) => row.text))
        .toEqual([first, second]);
      const translated = await f.read();
      expect(translated.every((row) => row.font === 18)).toBe(true);
      if (native) {
        translated.forEach((row, i) => {
          const sourceRow = rows[i];
          if (!sourceRow) throw new Error('Missing source row');
          expect(row.paintedBox.bottom).toBeLessThanOrEqual(sourceRow.bottom);
          expect(row.paintedBox.right).toBeLessThanOrEqual(sourceRow.right);
          expect(row.paintedBox.bottom - row.paintedBox.top).toBeGreaterThan(16);
        });
        const ellipsis = await f.panel.evaluate(async (tabId) => {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const host = document.querySelector<HTMLElement>(
                '[data-chatbrowserx-overlay=translation]',
              );
              const p =
                host &&
                chrome.dom.openOrClosedShadowRoot(host)?.querySelector('.translation-group p');
              return (
                p &&
                getComputedStyle(p).overflowX === 'hidden' &&
                getComputedStyle(p).textOverflow === 'ellipsis'
              );
            },
          });
          return r?.result;
        }, f.tabId);
        expect(ellipsis).toBe(true);
      } else {
        const sourceRow = rows[0];
        if (!sourceRow) throw new Error('Missing source row');
        expect(translated[0]?.box.height).toBeGreaterThan(sourceRow.height);
      }
      await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
    },
  );

for (const constraint of ['', 'height:130px', 'max-height:130px', 'contain:paint'])
  extensionTest(
    `preserves translated float-column visibility with ${constraint || 'auto height'} clipping`,
    async ({ extensionSession }, info) => {
      const f = await setup(
        extensionSession,
        `<style>.columns{overflow:hidden;width:600px;${constraint}}.native{float:left;width:300px;height:130px}.native canvas{display:block}.column{float:right;width:260px;font:16px/24px Arial}.footer{height:60px;line-height:60px;text-align:right}.footer a{font:14px/60px Arial}</style><main><div class="columns"><div class="native"><canvas width="300" height="130"></canvas></div><div class="column"><p>简短的正文说明</p><div class="footer"><a href="#submit">投稿入口</a></div></div></div></main>`,
        {
          简短的正文说明:
            'This paragraph becomes much longer in the translated language. Its ordinary content must wrap naturally at the original font size without silently cutting off the submission action that follows it.',
          投稿入口: 'Submit content',
        },
      );
      const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
      const columns = await f.page.locator('.columns').boundingBox();
      if (!columns) throw new Error('Missing float columns');
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', /^(ready|unsupported)$/);
      const painted = await f.panel.evaluate(async (tabId) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            const text = [...(root?.querySelectorAll<HTMLElement>('.text') ?? [])].find(
              (el) => el.textContent === 'Submit content',
            );
            const group = text?.closest('.translation-group');
            if (!text || !group) return null;
            const clip = getComputedStyle(group).clipPath;
            if (!clip.startsWith('inset(')) throw new Error(`Unexpected group clip: ${clip}`);
            const insets = clip.slice(6, -1).split(/\s+/).map(parseFloat);
            const range = document.createRange();
            range.selectNodeContents(text);
            return {
              bottom: range.getBoundingClientRect().bottom,
              clipBottom: group.getBoundingClientRect().bottom - (insets[2] ?? insets[0] ?? 0),
              font: getComputedStyle(text).fontSize,
            };
          },
        });
        return r?.result;
      }, f.tabId);
      if (!painted) throw new Error('Missing translated footer');
      expect(painted.font).toBe('14px');
      expect(painted.bottom).toBeGreaterThan(columns.y + columns.height);
      if (constraint) expect(painted.clipBottom).toBeLessThanOrEqual(columns.y + columns.height);
      else expect(painted.bottom).toBeLessThanOrEqual(painted.clipBottom);
      await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', source);
      await f.page.screenshot({ path: info.outputPath('float-column-clipping.png') });
    },
  );

for (const side of ['left', 'right'])
  extensionTest(
    `keeps a compact translated action clear of an absolutely positioned ${side} graphic`,
    async ({ extensionSession }, info) => {
      const translated = 'Publisher account submissions';
      const f = await setup(
        extensionSession,
        `<style>.row{position:relative;width:270px;height:60px;line-height:60px;text-align:${side === 'left' ? 'right' : 'left'}}.graphic{position:absolute;${side}:0;top:10px;width:140px;height:41px;background:linear-gradient(blue,blue)}.action{display:inline-block;font:14px/60px Arial}.action i{float:right;width:10px;height:60px;background:linear-gradient(red,red) center/4px 8px no-repeat}</style><main><div class="row"><a class="graphic" href="#graphic"></a><a class="action" href="#submit">内容投稿入口<i></i></a></div></main>`,
        { 内容投稿入口: translated },
      );
      const source = await f.page.locator('main').evaluate((el) => el.outerHTML);
      const graphic = await f.page.locator('.graphic').boundingBox();
      const action = await f.page.locator('.action').boundingBox();
      if (!graphic || !action) throw new Error('Missing source label or graphic');
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', 'ready');
      const [text] = await f.read();
      if (!text) throw new Error('Missing translated action');
      expect(text.text).toBe(translated);
      expect(text.font).toBe(14);
      expect(text.paintedBox.right - text.paintedBox.left).toBeGreaterThan(30);
      if (side === 'left')
        expect(text.paintedBox.left).toBeGreaterThanOrEqual(graphic.x + graphic.width + 1);
      else expect(text.paintedBox.right).toBeLessThanOrEqual(graphic.x - 1);
      expect(text.paintedBox.bottom).toBeLessThanOrEqual(action.y + action.height + 0.5);
      expect(await f.page.locator('main').evaluate((el) => el.outerHTML)).toBe(source);
      await f.page.screenshot({ path: info.outputPath(`positioned-${side}-graphic.png`) });
    },
  );

extensionTest(
  'shares a compact cell between inline and padded inline-block links',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<style>.cell{width:106px;height:20px;display:inline-block;white-space:nowrap;text-overflow:ellipsis;font:14px/20px Arial}.labels{display:inline-block;position:relative;white-space:nowrap}.icon{display:inline-block;width:28px;padding:0 4px 0 25px;height:18px;overflow:hidden;text-overflow:ellipsis;background:linear-gradient(blue,blue) left center/20px 18px no-repeat}.other{padding-left:4px}</style><main><div class="cell"><div class="labels"><a class="icon" href="#a">新闻</a><a class="other" href="#b">地图</a></div></div></main>',
      { 新闻: 'News', 地图: 'Maps' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.font).toBe(14);
      expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThanOrEqual(
        row.box.width - 0.5,
      );
    }
    expect(rows[1]?.paintedBox.left).toBeGreaterThanOrEqual(
      (rows[0]?.paintedBox.right ?? Infinity) + 2,
    );
  },
);

extensionTest(
  'keeps a compact inline-block link grid ellipsized without growing its cells',
  async ({ extensionSession }) => {
    const labels = ['资讯', '学习', '邮箱', '科技', '国内', '国际', '金融', '体育'];
    const f = await setup(
      extensionSession,
      `<style>.grid{width:550px;margin:0;padding:0;font:14px/20px Arial}.grid>li{display:inline-block;position:relative;width:106px;height:20px;padding-top:6px;padding-bottom:3px;margin-left:23px;white-space:nowrap;text-overflow:ellipsis}.label{display:inline-block;position:relative}.label>a{display:inline-block;width:28px;height:18px;overflow:hidden;text-overflow:ellipsis;padding-left:20px;background:linear-gradient(blue,blue) left center/16px 16px no-repeat}</style><main><ul class="grid">${labels.map((s, i) => `<li><div class="label"><a href="#${i}">${s}</a></div></li>`).join('')}</ul></main>`,
      Object.fromEntries(
        labels.map((s, i) => [s, i ? `An expanded translated service label ${i}` : 'News']),
      ),
    );
    const original = await f.page.locator('.grid').evaluate((el) => el.outerHTML);
    const cells = await f.page
      .locator('.grid>li')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(labels.length);
    rows.forEach((row, i) => {
      const cell = cells[i];
      if (!cell) throw new Error('Missing source grid cell');
      expect(row.font).toBe(14);
      expect(row.paintedBox.left).toBeGreaterThanOrEqual(cell.left + 20);
      expect(row.paintedBox.right).toBeLessThanOrEqual(cell.right + 0.5);
      expect(row.paintedBox.bottom - row.paintedBox.top).toBeGreaterThan(12);
      if (row.text === 'News')
        expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThanOrEqual(
          row.box.width - 0.5,
        );
    });
    const ellipsis = await f.panel.evaluate(async (tabId) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll('.text') ?? [])].every((text) => {
            const parent = text.parentElement;
            if (!parent) return false;
            const s = getComputedStyle(parent);
            return s.textOverflow === 'ellipsis' && s.overflowX === 'hidden';
          });
        },
      });
      return r?.result;
    }, f.tabId);
    expect(ellipsis).toBe(true);
    await expect(f.page.locator('.grid')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'keeps every originally single-line inline-block menu label visible after translation',
  async ({ extensionSession }) => {
    const labels = ['导航推荐', '日报', '通讯社', '电视台', '国际在线', '财经', '教育', '科技'];
    const f = await setup(
      extensionSession,
      `<style>.links{width:700px;height:28px;border:1px solid #ddd;overflow:hidden;font:14px/16.1px Arial;white-space:normal}.links a{display:inline-block;line-height:20px;margin:4px 32px 4px 0}.links a:first-child{margin-left:10px}.links a:last-child{margin-right:0}</style><main><div class="links">${labels.map((s, i) => `<a href="#${i}">${s}</a>`).join('')}</div><p>后续正文</p></main>`,
      Object.fromEntries([
        ...labels.map((s, i) => [s, `Translated navigation category ${i}`]),
        ['后续正文', 'Following prose'],
      ]),
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    const source = await f.page.locator('.links').boundingBox();
    if (!source) throw new Error('Expected the source navigation row');
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = (await f.read()).filter((r) => r.text?.startsWith('Translated navigation'));
    expect(rows).toHaveLength(labels.length);
    for (const row of rows) {
      expect(row.font).toBe(14);
      expect(row.paintedBox.top).toBeGreaterThanOrEqual(source.y);
      expect(row.paintedBox.bottom).toBeLessThanOrEqual(source.y + source.height);
      expect(row.paintedBox.bottom - row.paintedBox.top).toBeGreaterThan(12);
      expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThan(20);
    }
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'does not collapse an originally multi-row collection of inline-block links',
  async ({ extensionSession }) => {
    const labels = ['新闻目录', '体育目录', '财经目录', '科技目录'];
    const f = await setup(
      extensionSession,
      `<style>.links{width:260px;font:16px/24px Arial}.links a{display:inline-block;width:110px;margin:4px 10px 4px 0}</style><main><div class="links">${labels.map((s, i) => `<a href="#${i}">${s}</a>`).join('')}</div></main>`,
      Object.fromEntries(labels.map((s, i) => [s, `Category ${i}`])),
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(4);
    expect(rows[2]?.paintedBox.top).toBeGreaterThan(rows[0]?.paintedBox.bottom ?? Infinity);
    for (const row of rows) expect(row.font).toBe(16);
  },
);

for (const fixed of [false, true])
  extensionTest(
    `keeps bordered tab labels inside their ${fixed ? 'fixed' : 'intrinsic'} cell`,
    async ({ extensionSession }) => {
      const f = await setup(
        extensionSession,
        `<style>.tabs{width:360px;height:34px;border:1px solid #ddd;line-height:34px}.row{float:left}.tab{float:left;height:35px;line-height:35px;font-size:16px;padding:0 7px;margin-top:-1px}.tab.selected{${fixed ? 'width:46px;box-sizing:border-box;' : ''}height:33px;line-height:29px;border-top:3px solid orange;border-left:1px solid #ddd;border-right:1px solid #ddd;padding:0 6px}.tab em{float:left;font-style:normal}.following{clear:both}</style><main><div class="tabs"><div class="row"><span class="tab selected"><em>推荐</em><span style="display:none">隐藏控件</span></span><span class="tab"><a href="#feed">滚动</a></span></div></div><p class="following">后续正文</p></main>`,
        { 推荐: 'Recommendations', 滚动: 'Scrolling headlines', 后续正文: 'Following prose' },
      );
      const source = await f.page.locator('.tab.selected').boundingBox();
      if (!source) throw new Error('Expected the bordered tab');
      const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', fixed ? 'unsupported' : 'ready');
      const first = (await f.read()).find((r) => r.text === 'Recommendations');
      const [border] = await f.panel.evaluate(
        async (id) =>
          chrome.scripting.executeScript({
            target: { tabId: id },
            func: () => {
              const host = document.querySelector<HTMLElement>(
                '[data-chatbrowserx-overlay=translation]',
              );
              const root = host && chrome.dom.openOrClosedShadowRoot(host);
              const cell = [...(root?.querySelectorAll<HTMLElement>('*') ?? [])].find(
                (el) => getComputedStyle(el).borderTopWidth === '3px',
              );
              if (!cell) return null;
              const range = document.createRange();
              range.selectNodeContents(cell);
              return {
                box: cell.getBoundingClientRect().toJSON(),
                ink: range.getBoundingClientRect().toJSON(),
                text: cell.textContent,
                font: getComputedStyle(cell).fontSize,
              };
            },
          }),
        f.tabId,
      );
      const result = border?.result;
      const cell = result?.box;
      expect(cell).toBeDefined();
      if (fixed) {
        expect(first).toBeUndefined();
        expect(result?.text).toBe('推荐');
        expect(result?.font).toBe('16px');
        expect(cell?.width).toBeCloseTo(source.width, 0);
        expect(result?.ink.left).toBeGreaterThanOrEqual((cell?.left ?? Infinity) + 7);
        expect(result?.ink.right).toBeLessThanOrEqual((cell?.right ?? 0) - 7);
      } else {
        if (!first) throw new Error('Expected the translated tab');
        expect(first.font).toBe(16);
        expect(first.paintedBox.left).toBeGreaterThanOrEqual(cell?.left ?? Infinity);
        expect(first.paintedBox.right).toBeLessThanOrEqual(cell?.right ?? 0);
        // No declared width: the border follows the intrinsic translated label.
        // Pinning it to the shorter Chinese used width would create needless ellipsis.
        expect(first.paintedBox.right - first.paintedBox.left).toBeGreaterThanOrEqual(
          first.box.width - 0.5,
        );
      }
      const rows = await f.read();
      expect(
        rows.find((row) => row.text === 'Scrolling headlines')?.paintedBox.left,
      ).toBeGreaterThanOrEqual(cell?.right ?? Infinity);
      expect(rows.find((row) => row.text === 'Following prose')?.box.top).toBeGreaterThanOrEqual(
        cell?.bottom ?? Infinity,
      );
      await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
    },
  );

extensionTest(
  'retains an auto-height floated menu when translated items wrap inside its padding',
  async ({ extensionSession }) => {
    const labels = ['设为首页', '手机网站入口', '移动客户端'];
    const f = await setup(
      extensionSession,
      `<style>.bar{float:left;width:280px;font:12px/20px Arial}.item{float:left;position:relative}.item a{display:inline-block;position:relative;line-height:16px;padding:0 2px}.item i{display:inline-block;height:17px;padding:12px 9px 12px 16px;vertical-align:bottom;font-style:normal}.arrow{display:inline-block;width:8px;height:5px;margin-left:5px;background:orange}.dropdown{display:none}.following{clear:both}</style><main><div class="bar">${labels.map((s, i) => `<div class="item"><a href="#${i}"><i>${s}${i === 2 ? '<span class="arrow"> </span>' : ''}</i></a>${i === 2 ? '<div class="dropdown">隐藏下拉内容</div>' : ''}</div>`).join('')}</div><p class="following">后续正文</p></main>`,
      {
        设为首页: 'Set as homepage',
        手机网站入口: 'Mobile portal',
        移动客户端: 'Mobile app',
        后续正文: 'Following prose',
      },
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const result = await f.read();
    const rows = result.filter((r) => r.text !== 'Following prose');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.font).toBe(12);
      expect(row.box.height).toBeLessThanOrEqual(16);
      expect(row.paintedBox.right - row.paintedBox.left).toBeGreaterThanOrEqual(
        row.box.width - 0.5,
      );
    }
    // This menu has auto height, no clipping and a clearing following paragraph.
    // Its translated labels may occupy another row, but must remain fully visible
    // and move the paragraph down instead of inventing ellipsis or an overlap.
    expect(new Set(rows.map((row) => row.box.top)).size).toBe(2);
    expect(result.find((row) => row.text === 'Following prose')?.box.top).toBeGreaterThan(
      Math.max(...rows.map((row) => row.paintedBox.bottom)),
    );
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'retains a padded single-line menu with closed dropdowns and non-rendered comments',
  async ({ extensionSession }) => {
    const labels = ['设为首页', '手机入口', '移动应用'];
    const f = await setup(
      extensionSession,
      `<style>.bar{height:43px;width:280px;font:12px/20px Arial}.item{float:left;position:relative;height:43px}.item a{display:inline-block;position:relative;height:41px;padding:0 12px}.item i{display:inline-block;height:41px;line-height:41px;font-style:normal}.dropdown{display:none}</style><main><div class="bar">${labels.map((s, i) => `<div class="item"><a href="#${i}"><i>${s}</i></a><!-- discarded login markup --><div class="dropdown">隐藏下拉内容</div></div>`).join('')}</div><p>后续正文</p></main>`,
      {
        设为首页: 'Set as homepage',
        手机入口: 'Mobile portal',
        移动应用: 'Mobile applications',
        后续正文: 'Following prose',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = (await f.read()).filter((r) => r.text !== 'Following prose');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.box.height).toBeLessThanOrEqual(16);
      expect(row.paintedBox.bottom).toBeLessThanOrEqual(163);
    }
    expect(f.requests.flatMap((r) => r.texts)).not.toContain('隐藏下拉内容');
  },
);

extensionTest(
  'keeps composite inline utility cells together without overflowing a neighboring control',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>.shell{position:relative;white-space:nowrap;font:12px/16px Arial;width:700px}.utilities{display:inline-block;width:450px;height:18px;white-space:nowrap}.cell{display:inline-block;width:129px;height:16px;margin-right:16px;white-space:nowrap}.cell span{display:inline-block;width:24px;height:16px;margin-right:4px}.cell i{display:inline-block;width:15px;height:15px;background:blue;margin-right:4px}.date{display:inline-block;width:160px;height:16px}.date a{display:inline-block;width:50px;margin-right:10px}.login{display:inline-block;width:60px;margin-left:8px}iframe{display:block;width:600px;height:60px}</style><main><div class="shell"><div class="utilities"><a class="cell" href="#a"><span>今日</span><i></i><span>多云</span><span>适宜</span></a><a class="cell" href="#b"><span>明日</span><i></i><span>晴天</span><span>良好</span></a><div class="date"><a href="#date">九月</a><a href="#day">星期一</a></div></div><a class="login" href="#login">登录</a><iframe title="Native embed"></iframe></div></main>`,
      {
        今日: 'Today',
        多云: 'Cloudy',
        适宜: 'Suitable',
        明日: 'Tomorrow',
        晴天: 'Sunny',
        良好: 'Excellent',
        九月: 'September',
        星期一: 'Monday',
        登录: 'Log in',
      },
    );
    const original = await f.page.locator('.shell').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = (await f.read()).filter((r) => r.text !== 'Log in');
    expect(rows).toHaveLength(8);
    rows.forEach((row, i) => {
      expect(row.font).toBe(12);
      expect(row.paintedBox.right).toBeLessThanOrEqual(510);
      expect(row.paintedBox.bottom).toBeLessThanOrEqual(140);
      const previous = rows[i - 1];
      if (previous)
        expect(row.paintedBox.left).toBeGreaterThanOrEqual(previous.paintedBox.right + 0.5);
    });
    await expect(f.page.locator('.shell')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'preserves shrink-to-fit navigation columns and the visible row of clipped utility links',
  async ({ extensionSession }) => {
    const labels = [
      '新闻',
      '体育',
      '科技',
      '财经',
      '娱乐',
      '汽车',
      '房产',
      '教育',
      '旅游',
      '健康',
      '历史',
      '军事',
      '游戏',
      '家居',
      '艺术',
      '公开课',
    ];
    const utilities = ['邮件服务', '音乐服务', '应用中心', '亲子课堂', '在线学习', '隐藏服务'];
    const f = await setup(
      extensionSession,
      `<style>.shell{width:1200px;margin:45px 120px;font:14px/20px Arial}.brand{height:66px}.row{height:39px;border:1px solid transparent}.primary{float:left;margin-top:7px}.primary a{float:left;margin-right:14px}.tools{float:right;position:relative;width:390px;margin-top:7px;font:12px/20px Arial}.tools ul{float:left;overflow:hidden;width:315px;height:20px;margin:0;padding:0;list-style:none}.tools li{float:right;margin-left:10px}.more{float:right;width:74px;height:20px}.shell iframe{width:1200px;height:125px;border:0;display:block}</style>
      <div class="shell"><header><div class="brand"></div><div class="row"><div class="primary">${labels.map((s, i) => `<a href="#${i}">${s}</a>`).join('')}</div><div class="tools"><ul>${utilities.map((s, i) => `<li><a href="#u${i}">${s}</a></li>`).join('')}</ul><div class="more"><span>全部产品</span></div></div></div></header><iframe title="Native content"></iframe></div>`,
      Object.fromEntries([
        ...labels.map((s, i) => [s, i ? `Category ${i}` : 'News']),
        ...utilities.map((s, i) => [s, `Utility service ${i}`]),
        ['<m0>全部产品</m0>', '<m0>All products</m0>'],
      ]),
    );
    await f.page.setViewportSize({ width: 1440, height: 1000 });
    const original = await f.page.locator('.shell').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.filter((r) => r.text === 'News' || r.text?.startsWith('Category '))).toHaveLength(
      16,
    );
    const shortLabel = rows.find((r) => r.text === 'News');
    if (!shortLabel) throw new Error('Expected the short navigation label');
    expect(shortLabel.paintedBox.right - shortLabel.paintedBox.left).toBeGreaterThanOrEqual(
      shortLabel.box.width - 0.5,
    );
    expect(rows.filter((r) => r.text?.startsWith('Utility service '))).toHaveLength(5);
    for (const row of rows) {
      expect(row.paintedBox.bottom).toBeLessThanOrEqual(151);
      expect(row.paintedBox.right).toBeGreaterThan(row.paintedBox.left + 5);
    }
    await expect(f.page.locator('.shell')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'does not discard a safe menu because its single text-bearing wrapper has a crowded sibling',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>.shell{width:900px;margin:60px}.brand{height:50px;background:#ddd}.row{position:relative;height:28px}.menu{float:left;width:300px;height:28px}.menu>a{float:left;margin-right:14px}.ticker{position:absolute;left:500px;width:140px;height:28px}.shell iframe{display:block;width:900px;height:200px;border:0}</style><div class="shell"><div><div class="brand"></div><div class="row"><div class="menu"><a href="#1">新闻</a><a href="#2">体育</a><a href="#3">科技</a></div><div class="ticker">滚动新闻</div></div></div><iframe title="Native media"></iframe></div>`,
      {
        新闻: 'News',
        体育: 'Sports',
        科技: 'Technology',
        滚动新闻:
          'A long translated news headline occupies more space than the compact original ticker',
      },
    );
    const original = await f.page.locator('.shell').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', /^(ready|unsupported)$/);
    await expect
      .poll(
        async () =>
          (await f.read()).filter((r) => ['News', 'Sports', 'Technology'].includes(r.text ?? ''))
            .length,
      )
      .toBe(3);
    await expect(f.page.locator('.shell')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'keeps growing prose in flow with a following offscreen sticky table',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>#port{height:800px;overflow:auto;margin:40px;width:900px}article{width:850px}section{position:relative}table{width:100%;table-layout:fixed;border-collapse:collapse}td{border:1px solid #aaa;padding:8px}.pinned{position:sticky;top:0;background:white;height:40px}#details{padding-top:200px}</style>
    <div id="port"><article><section style="padding-bottom:620px"><table><tbody><tr><td>需求说明</td><td>完整正文</td></tr></tbody></table><p>接下来的段落</p></section><section><table class="pinned"><tbody><tr><td>下一张表格</td></tr></tbody></table><div id="details">后续内容</div></section><canvas width="850" height="200"></canvas></article></div>`,
      {
        需求说明: 'Requirements',
        完整正文: 'Preserve all metadata and audit records while forwarding requests. '
          .repeat(25)
          .trim(),
        接下来的段落: 'The following paragraph',
        下一张表格: 'The following table',
        后续内容: 'Later content',
      },
    );
    const original = await f.page.locator('article').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.some((r) => r.text === 'The following table')).toBe(true);
    expect(rows.find((r) => r.text === 'The following table')?.box.top).toBeGreaterThan(
      rows.find((r) => r.text === 'The following paragraph')?.box.bottom ?? Infinity,
    );
    expect(rows.some((r) => r.text?.startsWith('Preserve all metadata'))).toBe(true);
    expect(rows.some((r) => r.text === 'The following paragraph')).toBe(true);
    await f.page.locator('#port').evaluate((el) => {
      el.scrollTop = 100;
    });
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).some((r) => r.text?.startsWith('Preserve all metadata'))).toBe(true);
    await expect(f.page.locator('article')).toHaveJSProperty('outerHTML', original);
  },
);

extensionTest(
  'keeps a right-floated utility link row on its original single line',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>.links{float:right;width:315px;height:20px;margin:0;padding:0;list-style:none;font:12px/20px Arial}.links li{float:right;margin-left:10px}aside{height:20px;width:390px;float:right}.more{float:right;width:64px;height:20px;font:12px/20px Arial}.shell{margin:60px;width:900px}.shell iframe{display:block;width:900px;height:150px;border:0}</style><div class="shell"><div style="height:20px"><aside><div class="more">全部产品</div><ul class="links">${['公开课', '音乐', '邮箱', '加速器', '彩票'].map((s, i) => `<li><a href="#${i}">${s}</a></li>`).join('')}</ul></aside></div><iframe title="Native media"></iframe></div>`,
      {
        公开课: 'Open courses',
        音乐: 'Music streaming',
        邮箱: 'Corporate email',
        加速器: 'Game accelerator',
        彩票: 'Lottery results',
        全部产品: 'All products',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.font).toBe(12);
      expect(row.paintedBox.bottom).toBeLessThanOrEqual(80);
    }
  },
);

extensionTest(
  'reserves icon and separator space in fixed-width flex link cells',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<style>.links{display:flex;width:416px;height:20px;overflow:hidden;font:16px/18.4px Arial}.item{display:flex;justify-content:space-between;align-items:center;width:95px;height:20px;margin-right:12px}.item:last-child{margin:0}.item i{display:block;width:20px;height:20px;background:blue}.item a{font:14px/16.1px Arial;white-space:nowrap}.item span{width:1px;height:10px;background:#aaa}</style><main><div class="links">${['新闻', '视频', '体育', '公益'].map((label, i) => `<div class="item"><i></i><a href="#${i}">${label}</a><span></span></div>`).join('')}</div></main>`,
      {
        新闻: 'News and information',
        视频: 'Video streaming',
        体育: 'Sport competitions',
        公益: 'Public welfare',
      },
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows).toHaveLength(4);
    const cells = await f.panel.evaluate(async (tabId) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll('.translation-group i') ?? [])].map((icon) => ({
            icon: icon.getBoundingClientRect().toJSON(),
            separator: icon.parentElement?.lastElementChild?.getBoundingClientRect().toJSON(),
            box: icon.parentElement?.getBoundingClientRect().toJSON(),
          }));
        },
      });
      return r?.result;
    }, f.tabId);
    expect(cells).toHaveLength(4);
    rows.forEach((row, i) => {
      expect(row.font).toBe(14);
      expect(cells?.[i]?.icon.width).toBe(20);
      expect(row.paintedBox.left).toBeGreaterThanOrEqual(
        (cells?.[i]?.icon.right ?? Infinity) + 6.5,
      );
      expect(row.paintedBox.right).toBeLessThanOrEqual(
        (cells?.[i]?.separator?.left ?? -Infinity) - 6.5,
      );
      expect(cells?.[i]?.separator?.width).toBeGreaterThanOrEqual(0.9);
    });
    await expect(f.page.locator('main')).toHaveJSProperty('outerHTML', original);
  },
);
