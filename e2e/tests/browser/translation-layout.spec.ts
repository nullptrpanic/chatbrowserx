import { extensionTest, expect } from './fixtures/extension-test';
import { sendExtensionMessage } from './helpers/extension-runtime';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'keeps navigation glyphs beside icons in a complete opaque structural copy',
  { tag: '@smoke' },
  async ({ extensionSession }, info) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_navigation',
        },
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
    await context.route('https://translation-navigation.test/', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>body{margin:0;background:white;font:16px/24px Arial}nav{position:absolute;left:40px;top:220px;display:flex;gap:20px}ul{display:flex;gap:20px;list-style:none;margin:0;padding:0}.item{display:flex;align-items:center;padding:2px 8px}.item svg{display:block;width:16px;height:16px;margin-right:6px}.grid{display:grid;grid-template-columns:auto auto}.signup{display:inline;white-space:nowrap;border:1px solid transparent;border-radius:100px;background:#111827;color:white;padding:4px 12px;line-height:16px}</style><nav><ul>
    <li><a href="#models" class="item"><svg><path fill="red" d="M0 0h16v16H0z"/></svg>Models</a></li>
    <li><a href="#docs" class="item grid"><svg><path fill="blue" d="M0 0h16v16H0z"/></svg>Docs</a></li>
    <li><a href="#signup" class="signup">Sign Up</a></li></ul></nav>`,
      }),
    );
    let requests = 0;
    await context.route('https://chatgpt.com/backend-api/codex/responses', (r) => {
      requests++;
      const texts = JSON.parse(r.request().postDataJSON().input[0].content[0].text).texts as {
        id: string;
        text: string;
      }[];
      const translations: Record<string, string> = {
        Models: '模型',
        Docs: '文档',
        'Sign Up': '注册',
      };
      const blocks = texts.map((t) => {
        const translation = translations[t.text];
        if (!translation) throw new Error(`Unexpected text: ${t.text}`);
        return { id: t.id, translation };
      });
      const events = [
        { type: 'response.created', response: { id: 'navigation' } },
        {
          type: 'response.output_text.delta',
          delta: JSON.stringify({ blocks }),
        },
        { type: 'response.completed', response: { id: 'navigation' } },
      ];
      return r.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.goto('https://translation-navigation.test/');
    await page.bringToFront();
    await page.mouse.move(400, 260);
    const tabId = (
      await panel.evaluate(async () =>
        chrome.tabs.query({ url: 'https://translation-navigation.test/' }),
      )
    )[0]?.id;
    if (tabId === undefined) throw new Error('Target tab missing');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'toggle',
      type: 'translation.toggle',
      payload: { tabId },
    });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -2000);
    await page.keyboard.up('Control');
    const lens = page.locator('[data-chatbrowserx-overlay="translation"]');
    const metrics = await context.newCDPSession(page);
    for (const [width, dpr] of [
      [1000, 1],
      [800, 1],
      [1000, 2],
      [1000, 0.75],
    ] as const) {
      await page.setViewportSize({ width, height: 600 });
      await metrics.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 600,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await expect(lens).toHaveAttribute('data-status', 'ready');
      const rows = await panel.evaluate(async (id) => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay="translation"]',
            );
            if (!host) throw new Error('Lens missing');
            const root = chrome.dom.openOrClosedShadowRoot(host);
            if (!root) throw new Error('Lens root missing');
            const translations = ['模型', '文档', '注册'];
            return [...document.querySelectorAll('nav a')].map((a, i) => {
              const flow = [...root.querySelectorAll<HTMLElement>('.text')].find(
                (t) => t.textContent === translations[i],
              );
              if (!flow?.parentElement) throw new Error('Translated text missing');
              const range = document.createRange();
              const glyphs: DOMRect[] = [];
              const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
              let n;
              while ((n = walker.nextNode())) {
                if (!n.textContent?.trim()) continue;
                range.selectNodeContents(n);
                glyphs.push(...range.getClientRects());
              }
              range.selectNodeContents(flow);
              const group = flow.closest('.translation-group'),
                link = flow.closest('a');
              if (!group || !link) throw new Error('Missing structural navigation');
              return {
                original: glyphs.map((r) => r.toJSON()),
                translated: [...range.getClientRects()].map((r) => r.toJSON()),
                group: group.getBoundingClientRect().toJSON(),
                link: link.getBoundingClientRect().toJSON(),
                icon: flow.closest('a')?.querySelector('svg')?.getBoundingClientRect().toJSON(),
              };
            });
          },
        });
        if (!r?.result) throw new Error('Geometry missing');
        return r.result;
      }, tabId);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        for (const glyph of row.original)
          expect(
            row.group.left <= glyph.left + 0.5 &&
              row.group.right >= glyph.right - 0.5 &&
              row.group.top <= glyph.top + 0.5 &&
              row.group.bottom >= glyph.bottom - 0.5,
          ).toBe(true);
        if (row.icon)
          for (const r of row.translated) expect(r.left).toBeGreaterThanOrEqual(row.icon.right + 5);
      }
      const screenshot = await page.screenshot({
        path: info.outputPath(`navigation-${width}-dpr${dpr}.png`),
      });
      const signup = rows[2];
      if (!signup) throw new Error('Sign Up geometry missing');
      const residue = await panel.evaluate(
        async ({ png, source, link, width }) => {
          const bitmap = await createImageBitmap(await (await fetch(png)).blob());
          const scale = bitmap.width / width;
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Canvas missing');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          // Native reflow can move/shrink the button. Its former location must be a clean
          // page backdrop, with neither the dark source button nor its English ink leaking.
          const left = Math.floor(Math.min(...source.map((r) => r.left)) * scale);
          const right = Math.ceil(Math.max(...source.map((r) => r.right)) * scale);
          const top = Math.floor(Math.min(...source.map((r) => r.top)) * scale);
          const bottom = Math.ceil(Math.max(...source.map((r) => r.bottom)) * scale) + 1;
          const ink: number[][] = [];
          for (let y = top; y < bottom; y++)
            for (let x = left; x < right; x++) {
              if (
                x / scale >= link.left - 1 &&
                x / scale <= link.right + 1 &&
                y / scale >= link.top - 1 &&
                y / scale <= link.bottom + 1
              )
                continue;
              const [r = 0, g = 0, b = 0] = ctx.getImageData(x, y, 1, 1).data;
              if (Math.min(r, g, b) < 245) ink.push([x, y, r, g, b]);
            }
          return { ink, source };
        },
        {
          png: `data:image/png;base64,${screenshot.toString('base64')}`,
          width,
          source: signup.original,
          link: signup.link,
        },
      );
      expect(
        residue.ink,
        `original Sign Up ink must not remain: ${JSON.stringify(residue.source)}`,
      ).toEqual([]);
    }
    expect(requests).toBe(1);
  },
);

extensionTest(
  'keeps same-font paragraphs and inline styles under native wrapping',
  async ({ extensionSession }, testInfo) => {
    const { context, sidePanelPage: panel } = extensionSession;
    const token = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_layout' },
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
    const source =
      'Most safety alignment work treats harm as a property of a topic. A prompt is unsafe because it falls into a general category such as weapons, fraud, or self-harm, and guard models like LlamaGuard-3 encode exactly this kind of topic-level taxonomy. Benchmarks like XSTest and OR-Bench then probe the failure mode this creates, models that refuse safe prompts because they contain a dangerous-looking word, and refusal-calibration work tries to bring that over-refusal rate down.';
    const second =
      'Real deployments rarely fit a topic-level partition. The same base model may be adapted for general assistants, educational products, enterprise systems, or public-sector services, and each of those settings needs different boundaries inside the same topic. A civic-education tutor and a public-sector assistant can share a model while requiring opposite behavior on political requests. Both should answer factual questions about elections, but only one may need to refuse requests to write targeted political manipulation. Topic-level safety cannot express that distinction. For example, the model covers only factual errors about election systems and processes, excluding both persuasion and manipulation as well as factual questions the deployment must keep answering.';
    const translated =
      '大多数安全对齐工作将危害视为主题本身的一种属性。提示词之所以不安全，是因为它属于武器、欺诈或自残等某个宽泛类别，而 LlamaGuard-3 等防护模型所编码的正是这种主题级分类体系。随后，XSTest 和 OR-Bench 等基准测试会探查由此产生的失效模式：模型仅仅因为安全的提示词中带有看似危险的词语，就拒绝响应；而拒绝校准工作则试图将这种误拒的比例降下来。';
    const translatedSecond =
      '实际部署很少能用主题层面的划分来概括。同一个基础模型可能被适配为通用助手、教育产品、企业系统或公共部门服务，而每种场景都需要在同一主题内设定不同的边界。公民教育辅导助手和公共部门助手可以共用一个模型，却需要在政治话题上采取相反的行为：两者都应回答有关选举的事实性问题，但可能只有其中一个需要拒绝撰写定向政治操纵内容的请求。主题层面的防护机制无法表达这种区分。例如，LlamaGuard-3 对选举的覆盖仅限于有关选举制度和程序的事实性错误信息，这既排除了说服和操纵，也排除了部署必须继续回答的事实性问题。';
    await context.route('https://translation-layout.test/', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><style>body{margin:0;background:white;font:18px/32px Georgia}article{position:absolute;left:80px;top:160px;width:min(704px,calc(100vw - 160px))}p{margin:32px 0 0}a{color:#0066cc;text-decoration:underline}</style><article><div>${source.replace('LlamaGuard-3', '<a href="#model">LlamaGuard-3</a>').replace('XSTest', '<a href="#test">XSTest</a>').replace('OR-Bench', '<a href="#bench">OR-Bench</a>')}<p>${second}</p></div></article>`,
      }),
    );
    let requests = 0;
    await context.route('https://chatgpt.com/backend-api/codex/responses', (route) => {
      requests++;
      const { texts } = JSON.parse(route.request().postDataJSON().input[0].content[0].text) as {
        texts: { id: string; text: string }[];
      };
      const blocks = texts.map((t) => ({
        id: t.id,
        translation: t.text.startsWith('Most')
          ? t.text.includes('<m0>')
            ? translated
                .replace('LlamaGuard-3', '<m0>LlamaGuard-3</m0>')
                .replace('XSTest', '<m1>XSTest</m1>')
                .replace('OR-Bench', '<m2>OR-Bench</m2>')
            : translated
          : translatedSecond,
      }));
      const events = [
        { type: 'response.created', response: { id: 'layout' } },
        {
          type: 'response.output_text.delta',
          delta: JSON.stringify({ blocks }),
        },
        { type: 'response.completed', response: { id: 'layout' } },
      ];
      return route.fulfill({
        contentType: 'text/event-stream',
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('https://translation-layout.test/');
    await page.bringToFront();
    await page.mouse.move(640, 500);
    const tabId = await panel.evaluate(
      async () => (await chrome.tabs.query({ url: 'https://translation-layout.test/' }))[0]?.id,
    );
    if (tabId === undefined) throw Error('Missing target');
    await sendExtensionMessage(panel, {
      version: 1,
      requestId: 'toggle',
      type: 'translation.toggle',
      payload: { tabId },
    });
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -2000);
    await page.keyboard.up('Control');
    const lens = page.locator('[data-chatbrowserx-overlay="translation"]');
    const read = () =>
      panel.evaluate(async (id) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => {
            const host = document.querySelector<HTMLElement>(
              '[data-chatbrowserx-overlay="translation"]',
            );
            const root = host && chrome.dom.openOrClosedShadowRoot(host);
            return [...(root?.querySelectorAll<HTMLElement>('.text') ?? [])].map((t) => ({
              text: t.textContent,
              font: getComputedStyle(t).fontSize,
              rect: t.getBoundingClientRect().toJSON(),
              links: [...t.querySelectorAll('a')].map((a) => ({
                text: a.textContent,
                href: a.getAttribute('href'),
                color: getComputedStyle(a).color,
                decoration: getComputedStyle(a).textDecoration,
              })),
            }));
          },
        });
        return result?.result;
      }, tabId);
    for (const width of [1440, 1280, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(lens).toHaveAttribute('data-status', 'ready');
      const rows = await read();
      expect(rows?.map((r) => r.text).join('')).toBe(translated + translatedSecond);
      expect([...new Set(rows?.map((r) => r.font))]).toEqual(['18px']);
      expect(rows?.some((r) => r.text?.trim() === 'LlamaGuard-3')).toBe(false);
      const links = rows?.flatMap((r) => r.links);
      expect(links).toEqual([
        {
          text: 'LlamaGuard-3',
          href: '#model',
          color: 'rgb(0, 102, 204)',
          decoration: 'underline',
        },
        {
          text: 'XSTest',
          href: '#test',
          color: 'rgb(0, 102, 204)',
          decoration: 'underline',
        },
        {
          text: 'OR-Bench',
          href: '#bench',
          color: 'rgb(0, 102, 204)',
          decoration: 'underline',
        },
      ]);
      const secondTop = await page.locator('p').evaluate((el) => el.getBoundingClientRect().top);
      expect(rows?.[0]?.rect.bottom).toBeLessThanOrEqual(secondTop);
      await page.screenshot({
        path: testInfo.outputPath(`native-${width}.png`),
      });
    }
    expect(await page.locator('article').textContent()).toBe(source + second);
    expect(requests).toBeLessThanOrEqual(2);
    await page.keyboard.press('Escape');
    await expect(lens).toHaveCount(0);
  },
);
