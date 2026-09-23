import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'translates a read-only document island with context but never sends editable drafts',
  { tag: '@smoke' },
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main contenteditable="true">
    <p>Private draft before</p>
    <article contenteditable="false"><p>PB means paired boundary samples.</p>
    <p>这些样本降低了过度拒绝率。</p><p>FH means factual harm.</p>
    <p contenteditable="plaintext-only">Private draft inside</p></article>
    <p>Private draft after</p>
    </main><div aria-hidden="true" style="position:absolute;top:130px;left:100px;opacity:.1;transform:rotate(-20deg)">Decorative watermark</div>`,
      {
        'PB means paired boundary samples.': 'PB means paired boundary samples.',
        '这些样本降低了过度拒绝率。': 'These samples reduce over-refusal.',
        'FH means factual harm.': 'FH means factual harm.',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toContain('These samples reduce over-refusal.');
    expect(f.requests.length).toBeGreaterThan(0);
    expect(f.requests.some((r) => r.context?.includes('PB means paired boundary samples.'))).toBe(
      true,
    );
    expect(JSON.stringify(f.requests)).not.toContain('Private draft');
    expect(JSON.stringify(f.requests)).not.toContain('Decorative watermark');
  },
);

for (const route of ['docx', 'wiki'])
  extensionTest(
    `translates Feishu ${route} body without sending unrelated drafts or removing watermarks`,
    async ({ extensionSession }, info) => {
      const watermark = `url("data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="50"><path d="M0 30L70 0" stroke="#dde6ed" stroke-width="3"/></svg>').toString('base64')}")`;
      const f = await setup(
        extensionSession,
        `<main class="page-block root-block" contenteditable="true"><p class="zone-container text-editor">PB means paired boundary samples.<span contenteditable="plaintext-only">Private nested draft</span></p>
      <p class="zone-container text-editor">这些样本降低了过度拒绝率。</p><p class="zone-container text-editor">FH means factual healing.</p></main>
      <div contenteditable="true">Private comment draft</div><textarea>Private search</textarea>
      <div class="ssrWaterMark" style='position:fixed;inset:0;pointer-events:none;z-index:100;background-image:${watermark};background-position:7px 11px'></div>`,
        {
          'PB means paired boundary samples.': 'PB means paired boundary samples.',
          '这些样本降低了过度拒绝率。': 'These samples reduce over-refusal.',
          'FH means factual healing.': 'FH means factual healing.',
        },
        `https://fixture.larkoffice.com/${route}/readable`,
      );
      const native = await f.page.locator('.ssrWaterMark').getAttribute('style');
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', 'ready');
      expect((await f.read()).map((r) => r.text)).toContain('These samples reduce over-refusal.');
      expect(f.requests.some((r) => r.context?.includes('PB means paired boundary samples.'))).toBe(
        true,
      );
      expect(JSON.stringify(f.requests)).not.toContain('Private');
      expect(await f.page.locator('.ssrWaterMark').getAttribute('style')).toBe(native);
      const preserved = await f.panel.evaluate(async (id) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay=translation]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll<HTMLElement>('.translation-watermark') ?? [])].map(
              (el) => ({
                image: el.style.backgroundImage,
                position: el.style.backgroundPosition,
              }),
            );
          },
        });
        return r?.result ?? [];
      }, f.tabId);
      expect(preserved.length).toBeGreaterThan(0);
      expect(
        preserved.every(
          (r) => r.image.includes('data:image/svg+xml;base64,') && r.position === '7px 11px',
        ),
      ).toBe(true);
      // Feishu replaces SSR watermarks during hydration; the translated layer must survive it.
      const count = f.requests.length;
      await f.page.locator('.ssrWaterMark').evaluate((el) => {
        el.setAttribute('class', 'generated-id_clear suite-clear');
      });
      await expect
        .poll(async () => {
          const rows = await f.read();
          return (
            rows.some((r) => r.text === 'These samples reduce over-refusal.') &&
            (await f.lens.getAttribute('data-status')) === 'ready'
          );
        })
        .toBe(true);
      expect(f.requests.length).toBe(count);
      await f.page.screenshot({
        path: info.outputPath('document-watermark.png'),
      });
    },
  );

extensionTest(
  'omits invisible Docx editor placeholders from translation and context without modifying them',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      '<main class="page-block root-block" contenteditable="true"><p class="zone-container text-editor">这些样本<span data-string="true" data-enter="true" data-leaf="true">\u200b</span>降低了过度拒绝率。</p></main>',
      { '这些样本降低了过度拒绝率。': 'These samples reduce over-refusal.' },
      'https://fixture.larkoffice.com/docx/readable',
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toContain('These samples reduce over-refusal.');
    expect(f.requests.flatMap((r) => r.texts)).toEqual(['这些样本降低了过度拒绝率。']);
    expect(JSON.stringify(f.requests)).not.toContain('\u200b');
    expect(await f.page.locator('[data-enter]').textContent()).toBe('\u200b');
  },
);

extensionTest(
  'does not invent style identities for equivalent Docx runs while preserving real styles and links',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main class="page-block root-block" contenteditable="true">
      <p class="zone-container text-editor"><span>这些样本</span><span>降低了</span><span>过度拒绝率。</span></p>
      <p class="zone-container text-editor"><span>保留</span><strong>重点</strong><a href="#source">链接</a><em>斜体</em></p></main>`,
      {
        '这些样本降低了过度拒绝率。': 'These samples reduce over-refusal.',
        '保留<m0>重点</m0><m1>链接</m1><m2>斜体</m2>':
          'Keep <m0>emphasis</m0>, <m1>links</m1> and <m2>italics</m2>.',
      },
      'https://fixture.larkoffice.com/docx/readable',
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect(f.requests.flatMap((r) => r.texts)).toEqual([
      '这些样本降低了过度拒绝率。',
      '保留<m0>重点</m0><m1>链接</m1><m2>斜体</m2>',
    ]);
    expect((await f.read()).map((r) => r.text)).toEqual([
      'These samples reduce over-refusal.',
      'Keep emphasis, links and italics.',
    ]);
    const styles = await f.panel.evaluate(async (tabId) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll('.text > *') ?? [])].map((el) => ({
            tag: el.tagName,
            weight: getComputedStyle(el).fontWeight,
            style: getComputedStyle(el).fontStyle,
            href: el.getAttribute('href'),
          }));
        },
      });
      return result?.result;
    }, f.tabId);
    expect(styles).toEqual([
      { tag: 'STRONG', weight: '700', style: 'normal', href: null },
      { tag: 'A', weight: '400', style: 'normal', href: '#source' },
      { tag: 'EM', weight: '400', style: 'italic', href: null },
    ]);
    expect(await f.page.locator('.text-editor').first().textContent()).toBe(
      '这些样本降低了过度拒绝率。',
    );
    const requestCount = f.requests.length;
    await f.page
      .locator('.text-editor')
      .first()
      .evaluate((paragraph) => {
        const first = paragraph.firstElementChild?.firstChild;
        if (!first) throw new Error('Missing first editor run');
        first.textContent = '这些样本降低';
        const rest = document.createElement('span');
        rest.textContent = '了过度拒绝率。';
        paragraph.replaceChildren(first, rest);
      });
    // Allow the DOM observer, frame and 150ms request scheduler to process a changed run split.
    await f.page.waitForTimeout(500);
    expect(f.requests.length).toBe(requestCount);
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toContain('These samples reduce over-refusal.');
  },
);

extensionTest(
  'keeps expanded Chinese-to-English labels readable without splitting navigation words',
  async ({ extensionSession }, info) => {
    const titles = ['新闻', '地图', '贴吧', '视频', '图片', '网盘', '更多'];
    const english = ['News', 'Maps', 'Tieba', 'Videos', 'Images', 'Cloud Drive', 'More'];
    const headline = 'Undergraduates retrain at vocational colleges';
    const f = await setup(
      extensionSession,
      `<main><style>
    nav{font:16px/24px Arial;white-space:nowrap}nav a{display:inline-block;width:40px;margin-right:40px;color:#222}
    .row{display:flex;align-items:center;gap:12px;width:620px;margin-top:80px;height:60px}
    .title{display:flex;flex:1;min-width:0;white-space:nowrap;color:#222}.badge{width:32px;background:orange;color:white;font:12px/20px Arial}
    </style><nav>${titles.map((t) => `<a href="#${t}">${t}</a>`).join('')}</nav>
    <div class="row"><span aria-hidden="true">1</span><a class="title" href="#headline">大学生回炉读职校</a><span class="badge">热</span></div></main>`,
      {
        ...Object.fromEntries(
          titles.map((t, i) => {
            const translation = english[i];
            if (!translation) throw new Error(`Missing fixture translation for ${t}`);
            return [t, translation];
          }),
        ),
        大学生回炉读职校: headline,
        热: 'Hot',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    await info.attach('geometry', {
      body: JSON.stringify(rows),
      contentType: 'application/json',
    });
    for (let i = 0; i < english.length; i++) {
      const row = rows.find((r) => r.text === english[i]);
      expect(row, english[i]).toBeDefined();
      if (!row) throw new Error(`Missing translated label: ${english[i]}`);
      expect(row.font).toBeGreaterThanOrEqual(13.6 - 0.01);
      expect(row.box.height).toBeLessThan(25);
      if (i + 1 < english.length) {
        const next = rows.find((r) => r.text === english[i + 1])?.box;
        if (!next) throw new Error('Missing next navigation label');
        expect(row.paintedBox.right).toBeLessThanOrEqual(next.left - 2);
      }
    }
    const headlineRow = rows.find((r) => r.text === headline);
    expect(headlineRow).toBeDefined();
    if (!headlineRow) throw new Error('Missing translated headline');
    expect(headlineRow.font).toBeGreaterThanOrEqual(17);
    const badge = await f.page.locator('.badge').boundingBox();
    if (!badge) throw new Error('Missing badge');
    expect(headlineRow.box.right).toBeLessThanOrEqual(badge.x - 2);
    await f.page.screenshot({ path: info.outputPath('readable-english.png') });
    const count = f.requests.length;
    await f.page.keyboard.press('Escape');
    await expect(f.lens).toHaveCount(0);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(rows.map((r) => r.text));
    expect(f.requests.length).toBe(count);
    const expandedLink = rows.find((r) => r.text === 'Cloud Drive');
    const originalLink = await f.page.locator('nav a').nth(5).boundingBox();
    if (!expandedLink || !originalLink) throw new Error('Expanded link missing');
    const x = expandedLink.box.right - 2;
    expect(x).toBeGreaterThan(originalLink.x + originalLink.width);
    await f.page.mouse.click(x, expandedLink.box.top + expandedLink.box.height / 2);
    await expect(f.page).toHaveURL(
      `https://translation-readable.test/#${encodeURIComponent('网盘')}`,
    );
  },
);

extensionTest(
  'uses safe spacing for blockified flex navigation without splitting words',
  async ({ extensionSession }) => {
    // Baidu computes its flex children as block, not inline/inline-block.
    const f = await setup(
      extensionSession,
      `<main><nav style="display:flex;width:330px;height:60px;overflow:hidden;font:13px/23px Arial">
      <a href="#news" style="margin:19px 21px 0 0;white-space:nowrap">新闻</a>
      <a href="#maps" style="margin:19px 21px 0 0;white-space:nowrap">地图</a>
      <a href="#drive" style="margin:19px 21px 0 0;white-space:nowrap">网盘</a>
      <a href="#more" style="margin:19px 21px 0 0;white-space:nowrap">更多</a>
      </nav></main>`,
      { 新闻: 'News', 地图: 'Maps', 网盘: 'Cloud Drive', 更多: 'More' },
    );
    const original = await f.page.locator('nav a').evaluateAll((nodes) =>
      nodes.map((n) => ({
        text: n.textContent,
        box: n.getBoundingClientRect().toJSON(),
      })),
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    const nav = await f.page.locator('nav').boundingBox();
    if (!nav) throw new Error('Navigation missing');
    for (const [i, text] of ['News', 'Maps', 'Cloud Drive', 'More'].entries()) {
      const row = rows.find((r) => r.text === text);
      expect(row, text).toBeDefined();
      if (!row) throw new Error(`Translation missing: ${text}`);
      expect(row.font).toBeGreaterThanOrEqual(12);
      expect(row.box.bottom).toBeLessThanOrEqual(nav.y + nav.height);
      const next = rows.find((r) => r.text === ['News', 'Maps', 'Cloud Drive', 'More'][i + 1])?.box;
      if (next) expect(row.paintedBox.right).toBeLessThanOrEqual(next.left - 2);
    }
    expect(
      await f.page.locator('nav a').evaluateAll((nodes) =>
        nodes.map((n) => ({
          text: n.textContent,
          box: n.getBoundingClientRect().toJSON(),
        })),
      ),
    ).toEqual(original);
  },
);

extensionTest(
  'retains single-line headline ellipsis and badge reservation without shrinking',
  async ({ extensionSession }, info) => {
    const title = 'The number of newborns remains at around 8 million';
    const f = await setup(
      extensionSession,
      `<main><style>
      .row{width:367px;height:36px;line-height:36px;white-space:nowrap}
      .headline{display:inline-block;vertical-align:top;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:14px/36px Arial}
      .rank{display:inline-block;width:22px;font:18px/18px Arial}
      .headline .title{font-size:16px}.badge{display:inline-block;background:orange;width:16px;height:16px;margin-left:6px;vertical-align:middle}
      </style><div class="row"><a class="headline" href="#headline"><span class="rank" aria-hidden="true">1</span> <span class="title">新出生人口维持在800万左右</span></a><span aria-hidden="true" class="badge"></span></div>
      <div class="row"><a class="headline" href="#second"><span class="rank" aria-hidden="true">2</span> <span class="title">第二条新闻</span></a></div></main>`,
      {
        '<m0>新出生人口维持在800万左右</m0>': `<m0>${title}</m0>`,
        '<m0>第二条新闻</m0>': '<m0>Second headline</m0>',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const translated = (await f.read()).find((r) => r.text === title);
    expect(translated).toBeDefined();
    if (!translated) throw new Error('Missing expanded headline');
    const [row, rank, badge] = await Promise.all([
      f.page.locator('.row').first().boundingBox(),
      f.page.locator('.rank').first().boundingBox(),
      f.page.locator('.badge').boundingBox(),
    ]);
    if (!row || !rank || !badge) throw new Error('Source geometry missing');
    expect(translated.font).toBe(14);
    expect(translated.box.height).toBe(17);
    expect(translated.box.top).toBeGreaterThanOrEqual(row.y);
    expect(translated.box.bottom).toBeLessThanOrEqual(row.y + row.height + 0.5);
    expect(translated.box.left).toBeGreaterThanOrEqual(rank.x + rank.width);
    expect(translated.paintedBox.right).toBeLessThanOrEqual(row.x + 340);
    expect(translated.ownerBox?.width).toBeLessThanOrEqual(340);
    await f.page.screenshot({ path: info.outputPath('headlines.png') });
  },
);

extensionTest(
  'translates an ellipsized headline without exposing an ordinarily clipped menu',
  async ({ extensionSession }) => {
    const original = '这里是一条比较长的新闻标题，原页面使用省略号显示。';
    const f = await setup(
      extensionSession,
      `<main><a href="#headline" style="display:block;width:240px;height:36px;font:16px/36px Arial;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${original}</a>
      <div style="overflow:hidden;width:1px;height:1px"><p>Hidden menu entry</p></div></main>`,
      { [original]: 'A long headline with an ellipsis' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toContain('A long headline with an ellipsis');
    expect(f.requests.flatMap((r) => r.texts)).toContain(original);
    expect(f.requests.flatMap((r) => r.texts)).not.toContain('Hidden menu entry');
  },
);

extensionTest(
  'keeps a long translated headline readable with native ellipsis and full hover text',
  async ({ extensionSession }) => {
    const translation =
      'A deliberately long news headline with several important details that cannot all fit in this narrow row, but remain available without making the text microscopic';
    const f = await setup(
      extensionSession,
      '<main><a href="#headline" style="display:block;width:210px;height:36px;font:16px/36px Arial;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">这是一条新闻标题</a></main>',
      { 这是一条新闻标题: translation },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.map((r) => r.text)).toContain(translation);
    const clipped = await f.panel.evaluate(async (id) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const flow =
            host && chrome.dom.openOrClosedShadowRoot(host)?.querySelector<HTMLElement>('.text');
          if (!flow) return null;
          return {
            title: flow.title,
            font: parseFloat(getComputedStyle(flow).fontSize),
            height: flow.getBoundingClientRect().height,
            overflow: flow.parentElement && getComputedStyle(flow.parentElement).overflow,
            nowrap: flow.parentElement && getComputedStyle(flow.parentElement).whiteSpace,
          };
        },
      });
      return result?.result;
    }, f.tabId);
    expect(clipped?.title).toBe(translation);
    expect(clipped?.font).toBe(16);
    expect(clipped?.height).toBeLessThanOrEqual(36);
    expect(clipped?.overflow).toBe('hidden');
    expect(clipped?.nowrap).toBe('nowrap');
  },
);

extensionTest(
  'lets a Chinese paragraph grow in English without compressing font or leading',
  async ({ extensionSession }) => {
    const source = '遵循约定的协议分流。'.repeat(14);
    const english =
      'Use the agreed protocol routing. HTTP requests go through the application layer, while other TCP traffic goes through the transport layer. HTTP does not need to trigger both decisions again, but both types of traffic must carry context and produce logs. Using an HTTP endpoint for a decision does not mean that managed business traffic only supports HTTP.';
    const f = await setup(
      extensionSession,
      `<main><p style="width:820px;font:16px/26px Arial;white-space:break-spaces">${source}</p></main>`,
      { [source]: english },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const flow = (await f.read()).find((r) => r.text === english);
    expect(flow).toBeDefined();
    expect(flow?.font).toBe(16);
    const sourceBox = await f.page.locator('main p').boundingBox();
    if (!sourceBox) throw new Error('Source paragraph missing');
    expect(flow?.box.bottom).toBeGreaterThan(sourceBox.y + sourceBox.height);
    expect(flow?.leading).toBe('26px');
    expect(await f.page.locator('main p').textContent()).toBe(source);
  },
);

extensionTest(
  'keeps a tight button original and reuses its translation when the source gains enough width',
  async ({ extensionSession }) => {
    const translation =
      'A deliberately very long complete English translation which cannot fit into this tiny button';
    const f = await setup(
      extensionSession,
      '<main><button style="width:44px;height:28px;padding:0;font:16px/24px Arial;white-space:nowrap">按钮</button></main>',
      { 按钮: translation },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect(await f.read()).toEqual([]);
    await expect(f.page.locator('button')).toHaveText('按钮');
    const count = f.requests.length;
    await f.page.mouse.move(600, 300);
    await f.page.keyboard.press('Escape');
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect(await f.read()).toEqual([]);
    expect(f.requests.length).toBe(count);
    await f.page.locator('button').evaluate((el) => {
      el.style.width = '800px';
    });
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => [r.text, r.font])).toEqual([[translation, 16]]);
    expect(f.requests.length).toBe(count);
  },
);

extensionTest(
  'retains text over an unsupported surface and can reuse its translation after the surface disappears',
  async ({ extensionSession }) => {
    const f = await setup(
      extensionSession,
      `<main><article style="position:relative;width:600px;height:140px;background:#003366;color:white">
    <canvas style="position:absolute;inset:0;width:600px;height:140px"></canvas>
    <p style="position:absolute;top:30px;left:20px">这是画布上面的文字。</p>
    </article></main>`,
      { '这是画布上面的文字。': 'Text over a canvas.' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'unsupported');
    expect(await f.read()).toEqual([]);
    const count = f.requests.length;
    await f.page.locator('canvas').evaluate((el) => el.remove());
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    expect((await f.read()).map((r) => r.text)).toEqual(['Text over a canvas.']);
    expect(f.requests.length).toBe(count);
  },
);

extensionTest(
  'restores the actual photo under white DOM text instead of painting a white rectangle',
  async ({ extensionSession }, info) => {
    const png = await extensionSession.sidePanelPage.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 800;
      c.height = 400;
      const x = c.getContext('2d');
      if (!x) throw new Error('Canvas context missing');
      x.fillStyle = '#003366';
      x.fillRect(0, 0, 800, 400);
      x.fillStyle = '#663300';
      x.fillRect(400, 0, 400, 400);
      return c.toDataURL();
    });
    const f = await setup(
      extensionSession,
      `<main><style>
    article{position:relative;width:600px;height:240px;overflow:hidden;border-radius:16px}
    img{position:absolute;width:100%;height:100%;object-fit:cover;object-position:25% 75%}
    .caption{position:absolute;bottom:0;left:0;right:0;padding:20px;background:linear-gradient(to bottom,transparent,rgba(0,0,0,.5));color:white}
    </style><article><img src="${png}"><div class="caption"><p>在原来的图片上正确翻译这段很长的白色标题</p></div></article></main>`,
      { 在原来的图片上正确翻译这段很长的白色标题: 'Photo headline' },
    );
    const original = await f.page.screenshot();
    const sample = await f.page.locator('.caption p').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const box = range.getBoundingClientRect();
      return { x: Math.floor(box.right - 5), y: Math.floor(box.top) - 1 };
    });
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const rows = await f.read();
    expect(rows.some((r) => r.text === 'Photo headline')).toBe(true);
    const screenshot = await f.page.screenshot({
      path: info.outputPath('photo-headline.png'),
    });
    const comparison = await f.panel.evaluate(
      async ({ before, after, x, y }) => {
        const pixel = async (png: string) => {
          const bitmap = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${png}`)).blob(),
          );
          const c = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = c.getContext('2d');
          if (!ctx) throw new Error('Canvas context missing');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          return [...ctx.getImageData(x, y, 1, 1).data];
        };
        return { before: await pixel(before), after: await pixel(after) };
      },
      {
        before: original.toString('base64'),
        after: screenshot.toString('base64'),
        ...sample,
      },
    );
    // Inside the original title mask, beyond the shorter translation, above original glyph ink.
    expect(comparison.after).toEqual(comparison.before);
    expect(comparison.after.slice(0, 3).every((v) => v > 240)).toBe(false);
  },
);
