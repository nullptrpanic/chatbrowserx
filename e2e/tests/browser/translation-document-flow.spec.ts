import { expect, extensionTest } from './fixtures/extension-test';
import { setupTranslationFixture } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'remeasures a native toolbar that finishes entering while refreshed translations are pending',
  async ({ extensionSession }, info) => {
    const f = await setupTranslationFixture(
      extensionSession,
      `<style>
        main{font:16px/24px Arial;width:600px!important}p{margin:20px 0}
        h2{font:24px/32px Arial}td{padding:12px;border:1px solid #aaa}
        .toolbar{position:fixed;left:80px;top:185px;z-index:100;background:white;padding:8px;box-shadow:0 1px 5px #888}
        .toolbar:not([hidden]){animation:enter 60s both}
        .toolbar iframe{width:300px;height:32px;border:0}
        @keyframes enter{from{transform:translateY(16px)}to{transform:translateY(0)}}
      </style><main><p>前面的正文</p><h2>模块划分</h2><p>模块职责说明</p>
      <table><tr><td>网络模块</td><td>请求上下文</td></tr></table><p>后续正文</p></main>
      <div class="toolbar" hidden><iframe title="Editing controls" srcdoc="toolbar"></iframe></div>`,
      {
        前面的正文: 'Preceding prose.',
        模块划分: 'Module breakdown',
        模块职责说明: 'Responsibilities of the document modules.',
        网络模块: 'Network module',
        请求上下文: 'Preserve the complete tracing, identity and audit context.',
        后续正文: 'Following document prose.',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const original = await f.page.locator('main').innerHTML();
    let pending = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await extensionSession.context.route(
      'https://chatgpt.com/backend-api/codex/responses',
      async (route) => {
        pending = true;
        await gate;
        await route.fallback();
      },
    );
    try {
      await f.page.locator('.toolbar').evaluate((el) => {
        (el as HTMLElement).hidden = false;
      });
      await f.page.keyboard.press('Alt+KeyR');
      await expect.poll(() => pending).toBe(true);
      const moved = await f.page.locator('.toolbar').evaluate((el) => {
        const before = el.getBoundingClientRect().top;
        for (const animation of el.getAnimations()) animation.finish();
        return before - el.getBoundingClientRect().top;
      });
      expect(moved).toBeGreaterThan(10);
    } finally {
      release();
    }
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Network module');
    expect((await f.read()).map((r) => r.text)).toContain('Following document prose.');
    expect(await f.page.locator('main').innerHTML()).toBe(original);
    await f.page.screenshot({ path: info.outputPath('settled-toolbar-refresh.png') });
  },
);

extensionTest(
  'keeps document text outside a foreground fixed native toolbar translated after refresh',
  async ({ extensionSession }) => {
    const f = await setupTranslationFixture(
      extensionSession,
      '<style>main{font:16px/24px Arial;width:600px!important}p{margin:20px 0}h2{font:24px/32px Arial}td{padding:12px;border:1px solid #aaa}.toolbar{position:fixed;left:20px;top:185px;z-index:100;background:white;padding:8px;box-shadow:0 1px 5px #888}.toolbar iframe{width:300px;height:32px;border:0}</style><main><p>前面的正文</p><h2>模块划分</h2><p>模块职责说明</p><table><tr><td>网络模块</td><td>请求上下文</td></tr></table><p>后续正文</p></main><div class="toolbar" hidden><iframe title="Editing controls" srcdoc="toolbar"></iframe></div>',
      {
        前面的正文: 'Preceding prose.',
        模块划分: 'Module breakdown',
        模块职责说明: 'Responsibilities of the document modules.',
        网络模块: 'Network module',
        请求上下文:
          'Preserve every connection and its complete tracing, identity and audit context.',
        后续正文: 'Following document prose.',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.locator('.toolbar').evaluate((el) => {
      (el as HTMLElement).hidden = false;
    });
    await f.page.keyboard.press('Alt+KeyR');
    await expect.poll(async () => (await f.read()).map((r) => r.text)).toContain('Network module');
    expect((await f.read()).map((r) => r.text)).toContain('Following document prose.');
  },
);

extensionTest(
  'keeps document prose and table translated when a floating editing toolbar opens before refresh',
  async ({ extensionSession }, info) => {
    const description =
      'Keep each connection associated with its sandbox, user, tracing identifiers and security audit context without modifying the original document.';
    const f = await setupTranslationFixture(
      extensionSession,
      `<style>
        main{position:relative;width:600px!important;font:16px/24px Arial}
        h2{font:700 24px/32px Arial;margin:24px 0 16px}p{margin:0 0 20px}
        table{width:100%;table-layout:fixed;border-collapse:collapse}td{border:1px solid #aaa;padding:8px}
        .toolbar{position:absolute;left:10px;top:36px;z-index:20;background:white;box-shadow:0 2px 5px #aaa;padding:8px}
      </style><main><p>前面的正文</p><div class="toolbar" role="toolbar" hidden><button>格式</button><input aria-label="font size" value="16"></div>
      <h2>模块划分</h2><p>模块职责说明</p><table><tbody><tr><td>网络模块</td><td>请求上下文</td></tr></tbody></table><h2>后续标题</h2><p>后续正文</p></main>`,
      {
        前面的正文: 'Preceding prose with a complete explanation of the security architecture.',
        格式: 'Format',
        模块划分: 'Module breakdown',
        模块职责说明: 'Responsibilities of the individual modules in this document.',
        网络模块: 'Network module',
        请求上下文: description,
        后续标题: 'Following section',
        后续正文: 'Following document prose.',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    await f.page.locator('.toolbar').evaluate((el) => {
      (el as HTMLElement).hidden = false;
      const heading = document.querySelector('h2');
      if (!heading) throw new Error('Heading missing');
      const range = document.createRange();
      range.selectNodeContents(heading);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    });
    const original = await f.page.locator('main').innerHTML();
    for (let i = 0; i < 2; i++) {
      await f.page.keyboard.press('Alt+KeyR');
      await expect(f.lens).toHaveAttribute('data-status', /ready|unsupported/);
      await expect.poll(async () => (await f.read()).map((row) => row.text)).toContain(description);
      const rows = await f.read();
      expect(rows.map((row) => row.text)).toContain('Module breakdown');
      expect(rows.map((row) => row.text)).toContain('Following document prose.');
      const cell = rows.find((row) => row.text === description);
      const heading = rows.find((row) => row.text === 'Following section');
      expect(heading?.box.top).toBeGreaterThan(cell?.box.bottom ?? Infinity);
      expect(await f.page.locator('main').innerHTML()).toBe(original);
    }
    await f.page.screenshot({ path: info.outputPath('floating-toolbar-refresh.png') });
  },
);

extensionTest(
  'keeps a growing table in its document flow when clipped resize handles appear',
  async ({ extensionSession }, info) => {
    const long =
      'Associate every request with the sandbox creator and the complete connection, identity, tracing and security audit context without changing the original document.';
    const f = await setupTranslationFixture(
      extensionSession,
      '<style>main{width:540px!important;font:16px/24px Arial}section{position:relative;margin-bottom:24px}table{width:100%;table-layout:fixed;border-collapse:collapse}td{border:1px solid #aaa;padding:8px}.handles{position:absolute;left:-7px;top:-24px;width:554px;height:16px;overflow:hidden}.handles>div{position:absolute;inset:6px 4px;border-top:1px dotted #aaa}h2{font:24px/32px Arial}canvas{margin-top:1200px}</style><main><section><div class="handles" hidden><div></div></div><table><tbody><tr><td>用户</td><td>请求上下文</td></tr></tbody></table></section><h2>下一节</h2><p>后续内容</p><canvas width="540" height="100"></canvas></main>',
      { 用户: 'User', 请求上下文: long, 下一节: 'Next section', 后续内容: 'Following prose' },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    for (const hidden of [false, true, false]) {
      await f.page.locator('.handles').evaluate((el, hidden) => {
        (el as HTMLElement).hidden = hidden;
      }, hidden);
      await f.page.waitForTimeout(350);
      await expect(f.lens).toHaveAttribute('data-status', 'ready');
      const rows = await f.read();
      const translated = rows.find((r) => r.text === long);
      const heading = rows.find((r) => r.text === 'Next section');
      expect(translated).toBeDefined();
      expect(translated?.font).toBe(16);
      expect(heading?.box.top).toBeGreaterThan(translated?.box.bottom ?? Infinity);
      expect(await f.page.locator('td').last().textContent()).toBe('请求上下文');
    }
    await f.page.screenshot({ path: info.outputPath('table-hover-handles.png') });
  },
);

for (const decoration of [false, true])
  extensionTest(
    `keeps a growing table and following sections in one flow${decoration ? ' beside gutter annotations' : ''}`,
    async ({ extensionSession }, info) => {
      const f = await setupTranslationFixture(
        extensionSession,
        `<main><style>
      main{width:600.5px!important;font:16px/24px Arial}
      section{position:relative;margin:0 0 24px}table{width:100%;table-layout:fixed;border-collapse:collapse}
      td,th{border:1px solid #aaa;padding:8px;vertical-align:top}
      h2{font:700 24px/32px Arial;margin:24px 0 16px}
      canvas{display:block;margin-top:1600px}
      .decoration{position:absolute;left:100%;top:0;width:80px;height:8px;background:#ccc}
      aside{position:absolute;left:690px;top:420px;width:90px;font:16px/24px Arial;background:#ff0}
    </style><section>${decoration ? '<div class="decoration"></div>' : ''}<table><colgroup><col style="width:32%"><col style="width:68%"></colgroup>
    <tbody><tr><th colspan="2">模块说明</th></tr>
    <tr><td rowspan="2">网络模块</td><td>审计上下文</td></tr>
    <tr><td>流量转发</td></tr></tbody></table></section>
    <h2>后续标题</h2><section><p>下一段正文</p></section>
    <section><table><tbody><tr><td>下一张表格</td><td>模块职责</td></tr></tbody></table></section>
    <canvas width="600" height="200" aria-label="Untranslated live surface"></canvas></main>${decoration ? '<aside>批注</aside>' : ''}`,
        {
          模块说明: 'Module descriptions',
          网络模块: 'Network module',
          审计上下文:
            'Identify the sandbox creator and associate every request with its user, trace, and audit context without changing any source document content or losing the existing column structure.',
          流量转发:
            'Forward intercepted traffic to the intended destination or downstream proxy while preserving the complete connection metadata and applying the required security decisions.',
          后续标题: 'Following heading',
          下一段正文: 'The next paragraph follows the expanded table without overlapping it.',
          下一张表格: 'The next table',
          模块职责: 'Module responsibilities',
          批注: 'Comments',
        },
      );
      const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
      await f.toggle();
      await expect(f.lens).toHaveAttribute('data-status', /ready|unsupported/);
      const check = async () => {
        const rows = await f.read();
        expect(rows.map((r) => r.text)).toContain('Module descriptions');
        expect(rows.map((r) => r.text)).toContain('Following heading');
        expect(rows.map((r) => r.text)).toContain('The next table');
        const measured = await f.panel.evaluate(async (tabId) => {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
              const host = document.querySelector<HTMLElement>(
                '[data-chatbrowserx-overlay=translation]',
              );
              const root = host && chrome.dom.openOrClosedShadowRoot(host);
              const tables = [...(root?.querySelectorAll('table') ?? [])];
              const heading = [...(root?.querySelectorAll('h2') ?? [])][0];
              return {
                tables: tables.map((el) => el.getBoundingClientRect().toJSON()),
                heading: heading?.getBoundingClientRect().toJSON(),
                cells: tables[0]?.querySelectorAll('td,th').length,
                nativeCopies: root?.querySelectorAll('canvas,video,iframe,input,[contenteditable]')
                  .length,
              };
            },
          });
          return result?.result;
        }, f.tabId);
        expect(measured?.tables).toHaveLength(2);
        expect(measured?.cells).toBe(4);
        expect(measured?.heading?.top).toBeGreaterThan(measured?.tables[0]?.bottom ?? Infinity);
        expect(measured?.tables[1]?.top).toBeGreaterThan(measured?.heading?.bottom ?? Infinity);
        expect(measured?.nativeCopies).toBe(0);
        expect(rows.filter((r) => r.text !== 'Following heading').every((r) => r.font === 16)).toBe(
          true,
        );
        expect(await f.page.locator('main').evaluate((el) => el.outerHTML)).toBe(original);
      };
      await check();
      await f.page.screenshot({ path: info.outputPath('document-flow-initial.png') });
      await f.page.mouse.wheel(0, 160);
      await expect
        .poll(async () => (await f.read()).some((r) => r.text === 'The next table'))
        .toBe(true);
      await check();
      await f.page.screenshot({ path: info.outputPath('document-flow-scrolled.png') });
    },
  );

extensionTest(
  'preserves one complete table beyond the old per-island node limit',
  async ({ extensionSession }, info) => {
    const translations: Record<string, string> = {};
    const rows = Array.from({ length: 24 }, (_, i) => {
      translations[`模块${i}`] = `Module ${i}`;
      translations[`职责${i}`] = `Keep the complete connection and audit context for module ${i}.`;
      // Empty inline editor decorations still consume clone nodes, but are not text targets.
      const decorations = '<span></span>'.repeat(40);
      return `<tr><td>${decorations}模块${i}</td><td>${decorations}职责${i}</td></tr>`;
    }).join('');
    const f = await setupTranslationFixture(
      extensionSession,
      `<main><style>
    main{width:640.5px!important;font:16px/24px Arial}
    table{width:100%;table-layout:fixed;border-collapse:collapse}td{border:1px solid #aaa;padding:4px}
    </style><table><colgroup><col style="width:30%"><col style="width:70%"></colgroup><tbody>${rows}</tbody></table></main>`,
      translations,
    );
    const original = await f.page.locator('main').evaluate((el) => el.outerHTML);
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const result = await f.panel.evaluate(async (tabId) => {
      const [reply] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return {
            tables: root?.querySelectorAll('table').length,
            cells: [...(root?.querySelectorAll('td') ?? [])].map((el) => ({
              width: el.getBoundingClientRect().width,
              font: getComputedStyle(el).fontSize,
            })),
            orphans: root?.querySelectorAll('td:not(table td),tr:not(table tr)').length,
          };
        },
      });
      return reply?.result;
    }, f.tabId);
    expect(result?.tables).toBe(1);
    expect(result?.cells).toHaveLength(48);
    expect(result?.orphans).toBe(0);
    expect(
      result?.cells.every(
        (cell, i) => cell.font === '16px' && Math.abs(cell.width - (i % 2 ? 447.65 : 191.85)) < 1,
      ),
    ).toBe(true);
    expect((await f.read()).some((row) => row.text === 'Module 0')).toBe(true);
    expect(await f.page.locator('main').evaluate((el) => el.outerHTML)).toBe(original);
    await f.page.screenshot({ path: info.outputPath('complete-large-table.png') });
  },
);

extensionTest(
  'does not paint transparent editor gutters across neighboring navigation',
  async ({ extensionSession }, info) => {
    const f = await setupTranslationFixture(
      extensionSession,
      `<main style="margin-left:300px;width:500px">
    <style>.gutter{margin-left:-180px;padding-left:180px;width:500px}table{width:100%;border-collapse:collapse}td{border:1px solid #aaa;padding:8px}canvas{margin-top:1200px;display:block}</style>
    <section class="gutter"><table><tbody><tr><td>模块</td><td>模块职责</td></tr></tbody></table></section>
    <p>后续正文</p><canvas width="500" height="100"></canvas></main>`,
      {
        模块: 'Module',
        模块职责: 'Module responsibilities',
        后续正文: 'Following prose',
      },
    );
    await f.toggle();
    await expect(f.lens).toHaveAttribute('data-status', 'ready');
    const gutters = await f.panel.evaluate(async (tabId) => {
      const [reply] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          return [...(root?.querySelectorAll('.translation-overflow-background') ?? [])].map((el) =>
            el.getBoundingClientRect().toJSON(),
          );
        },
      });
      return reply?.result ?? [];
    }, f.tabId);
    expect(
      gutters.some((r) => r.left < 299 && r.right > 120 && r.bottom > 120),
      `Empty gutter must not become an opaque translation background: ${JSON.stringify(gutters)}`,
    ).toBe(false);
    expect((await f.read()).map((r) => r.text)).toEqual([
      'Module',
      'Module responsibilities',
      'Following prose',
    ]);
    await f.page.screenshot({ path: info.outputPath('transparent-editor-gutter.png') });
  },
);
