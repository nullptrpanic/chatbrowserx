import { extensionTest, expect } from './fixtures/extension-test';
import { setupTranslationFixture as setup } from './helpers/translation-fixture';

extensionTest.use({ extensionHeadless: true });

extensionTest(
  'retains the original opaque popup envelope when translated text contracts',
  async ({ extensionSession }) => {
    const originalText =
      '这是一段用于说明弹层布局的文字，翻译以后可能变得很短，但不能因此在原有边框内再画一条边框。';
    const f = await setup(
      extensionSession,
      `<style>.popup{position:absolute;left:80px;top:90px;width:250px;padding:20px;border:2px solid purple;border-radius:12px;background:white;z-index:20}canvas{position:absolute;top:100px;left:60px;width:900px;height:400px;background:#e4a}.footer{position:absolute;top:650px;left:60px}</style><div class="popup"><p>${originalText}</p></div><canvas></canvas><p class="footer">正文</p>`,
      { [originalText]: 'Short translation', 正文: 'Article' },
    );
    const source = await f.page.locator('.popup').boundingBox();
    await f.toggle();
    await expect
      .poll(async () => (await f.read()).map((r) => r.text))
      .toContain('Short translation');
    const box = await f.panel.evaluate(async (id) => {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => {
          const host = document.querySelector<HTMLElement>(
            '[data-chatbrowserx-overlay=translation]',
          );
          const root = host && chrome.dom.openOrClosedShadowRoot(host);
          const flow = [...(root?.querySelectorAll('.text') ?? [])].find(
            (el) => el.textContent === 'Short translation',
          );
          let copy = flow;
          while (copy?.parentElement && !copy.parentElement.matches('.translation-group'))
            copy = copy.parentElement;
          return copy?.getBoundingClientRect().toJSON();
        },
      });
      return r?.result;
    }, f.tabId);
    expect(box?.height).toBeCloseTo(source?.height ?? 0, 1);
    expect(await f.page.locator('.popup').textContent()).toBe(originalText);
  },
);

for (const [background, css, translates] of [
  ['element', 'background:white', true],
  ['element beside control', 'background:white', true],
  [
    'gradient',
    'border:2px solid transparent;border-radius:16px;background:linear-gradient(white,white) padding-box,linear-gradient(90deg,blue,purple) border-box',
    true,
  ],
  ['transparent', 'background:transparent', false],
  ['alpha gradient', 'background:linear-gradient(white,rgba(255,255,255,.5))', false],
  ['partial gradient', 'background:linear-gradient(white,white) 0 0 / 30% 30% no-repeat', false],
  ['translucent owner', 'background:white;opacity:.5', false],
  ['below-media ancestor', 'background:transparent', false],
] as const)
  extensionTest(
    `${translates ? 'translates' : 'keeps native'} popup rows over media with ${background} backing`,
    async ({ extensionSession }, info) => {
      const f = await setup(
        extensionSession,
        `<style>
          header{position:relative;z-index:10;left:60px;top:40px;width:900px;height:60px}
          input{width:500px;height:40px}
          .popup{position:absolute;z-index:20;left:160px;top:50px;width:600px;height:220px}
          .popup{${css}}
          .popup ul{margin:0;padding:20px;list-style:none}
          .popup li{height:36px;line-height:36px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
          canvas{position:absolute;left:200px;top:145px;width:650px;height:90px;background:#e4a}
          ${background === 'below-media ancestor' ? 'header{z-index:auto;height:500px;background:white}canvas{z-index:10}' : ''}
          .footer{position:absolute;top:550px;left:60px}
        </style><header><input value="untouched draft"><div class="popup"><ul>
          <li>第一个搜索建议</li><li>第二个搜索建议</li><li>第三个搜索建议</li>
        </ul>${background.includes('control') ? '<input aria-label="Native popup control" style="margin-left:20px;width:200px;height:25px" value="popup draft">' : ''}</div></header><canvas width="650" height="90"></canvas><p class="footer">静态正文</p>`,
        {
          第一个搜索建议: 'First suggested query',
          第二个搜索建议: 'Second suggested query',
          第三个搜索建议: 'Third suggested query',
          静态正文: 'Ordinary article',
        },
      );
      const clip = { x: 810, y: 150, width: 35, height: 70 };
      const native = await f.page.screenshot({ clip });
      await info.attach('native-before', { body: native, contentType: 'image/png' });
      const beneath = { x: 500, y: 200, width: 100, height: 20 };
      const backing = await f.page.screenshot({ clip: beneath });
      await info.attach('native-backing-before', { body: backing, contentType: 'image/png' });
      const source = await f.page.locator('header').innerHTML();
      const popupBox = await f.page.locator('.popup').boundingBox();
      if (!popupBox) throw new Error('Popup missing');
      await f.toggle();
      await expect
        .poll(async () => (await f.read()).map((row) => row.text))
        .toEqual(
          translates
            ? expect.arrayContaining([
                'First suggested query',
                'Second suggested query',
                'Third suggested query',
                'Ordinary article',
              ])
            : ['Ordinary article'],
        );
      expect(await f.page.locator('input').first().inputValue()).toBe('untouched draft');
      if (background.includes('control'))
        expect(await f.page.locator('input').nth(1).inputValue()).toBe('popup draft');
      expect(await f.page.locator('header').innerHTML()).toBe(source);
      const nativeAfter = await f.page.screenshot({ clip });
      await info.attach('native-after', { body: nativeAfter, contentType: 'image/png' });
      const actualBacking = await f.page.screenshot({ clip: beneath });
      await info.attach('native-backing-after', { body: actualBacking, contentType: 'image/png' });
      for (const [before, after, area] of [
        [native, nativeAfter, clip],
        [backing, actualBacking, beneath],
      ] as const) {
        const diff = await f.panel.evaluate(
          async ({ expected, actual, area, edge }) => {
            const decode = async (data: string) => {
              const image = await createImageBitmap(await (await fetch(data)).blob());
              const canvas = new OffscreenCanvas(image.width, image.height),
                ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('No pixel context');
              ctx.drawImage(image, 0, 0);
              return ctx.getImageData(0, 0, image.width, image.height).data;
            };
            const a = await decode(expected),
              b = await decode(actual);
            let max = 0,
              uncovered = 0;
            for (let i = 0; i < a.length; i++) {
              const delta = Math.abs((a[i] ?? 0) - (b[i] ?? 0));
              max = Math.max(max, delta);
              if (area.x + (Math.floor(i / 4) % area.width) >= edge)
                uncovered = Math.max(uncovered, delta);
            }
            return { lengths: [a.length, b.length], max, uncovered };
          },
          {
            expected: 'data:image/png;base64,' + before.toString('base64'),
            actual: 'data:image/png;base64,' + after.toString('base64'),
            area,
            edge: popupBox.x + popupBox.width,
          },
        );
        expect(diff.lengths[0]).toBe(diff.lengths[1]);
        // A retained repeated failure contains only 1/255 gradient dithering.
        // Keep exact equality on the uncovered native canvas, and no geometric tolerance.
        expect(diff.max).toBeLessThanOrEqual(background.includes('gradient') ? 1 : 0);
        expect(diff.uncovered).toBe(0);
      }
      await f.page.screenshot({
        path: info.outputPath(`${background}-popup-text.png`),
      });
    },
  );
