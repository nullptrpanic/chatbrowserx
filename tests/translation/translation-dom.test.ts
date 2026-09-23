import { afterEach, expect, it, vi } from 'vitest';
import { TranslationDom } from '../../src/page/translation/translation-dom';
import { TranslationStructureLayout } from '../../src/page/translation/translation-structure-layout';
import * as textConstraints from '../../src/page/translation/translation-text-constraints';
import {
  closeTranslationLens,
  toggleTranslationLens,
} from '../../src/page/translation/mount-translation-lens';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import type { ExtensionResponse } from '../../src/shared/protocol/message-types';
import { mockAbsentPseudoStyles, mockTranslationGroupBox } from './dom-fixture';

function setup() {
  mockAbsentPseudoStyles();
  document.body.innerHTML =
    '<p>Full <a href="#">linked</a> paragraph.</p><p hidden>Private</p><textarea>Secret</textarea>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return mockTranslationGroupBox(this, 40) ?? new DOMRect(100, 100, 900, 40);
  });
  const create = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() =>
    Object.assign(create(), {
      getClientRects: () => [new DOMRect(100, 100, 900, 20)],
    }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
  const layer = document.createElement('div');
  const dom = new TranslationDom(document, window, layer);
  const area = { x: 200, y: 80, width: 300, height: 100 };
  dom.update(area);
  return { dom, layer, area };
}
afterEach(() => {
  closeTranslationLens();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('contains a constraint read failure within one island and renders its independent sibling', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML = '<p>First paragraph.</p><p>Second paragraph.</p>';
  dom.invalidate();
  dom.update(area);
  const [first, second] = dom.missing();
  if (!first || !second) throw new Error('Missing independent source paragraphs');
  vi.spyOn(textConstraints, 'readTranslationTextConstraints').mockImplementationOnce(() => {
    throw new Error('Constraint read failed');
  });
  expect(
    dom.accept({
      blocks: [
        { id: first.id, translation: '第一段。' },
        { id: second.id, translation: '第二段。' },
      ],
    }),
  ).toEqual([first.id]);
  expect(layer.textContent).toContain('第二段。');
  expect(layer.textContent).not.toContain('第一段。');
  expect(document.body.textContent).toBe('First paragraph.Second paragraph.');
  dom.invalidate();
  dom.update(area);
  expect(dom.layoutErrors.size).toBe(0);
  expect(layer.textContent).toContain('第一段。');
  expect(layer.textContent).toContain('第二段。');
});

it('keeps preformatted code out of translation while collecting its explanation', () => {
  const { dom, area, layer } = setup();
  document.body.innerHTML =
    '<article><p>示例说明</p><pre><code>const user = {\n  name: "原文",\n};</code></pre></article>';
  const source = document.querySelector('pre')?.textContent;
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['示例说明']);
  dom.accept({
    blocks: dom.missing().map((t) => ({ id: t.id, translation: 'Example explanation' })),
  });
  expect(layer.querySelector('pre')?.textContent).toBe(source);
});

it('does not let cached offscreen owners consume the discovery budget for later paragraphs', () => {
  const { dom } = setup();
  document.body.innerHTML = Array.from(
    { length: 160 },
    (_, i) => `<p data-row="${i}">Section ${i}</p>`,
  ).join('');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.hasAttribute('data-row')
      ? new DOMRect(0, Number(this.getAttribute('data-row')) * 20, 900, 20)
      : new DOMRect(0, 0, 900, 3200);
  });
  const create = Document.prototype.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = create();
    return Object.assign(range, {
      getClientRects: () => {
        const el =
          range.startContainer instanceof Element
            ? range.startContainer
            : range.startContainer.parentElement;
        return [el?.getBoundingClientRect() ?? new DOMRect()];
      },
    });
  });
  dom.invalidate();
  dom.update({ x: 0, y: 0, width: 900, height: 2560 });
  expect(dom.visible).toHaveLength(128);
  dom.invalidate(false);
  dom.update({ x: 0, y: 2800, width: 900, height: 180 });
  expect(dom.missing().map((t) => t.text)).toContain('Section 145');
});

it.each([
  'javascript:alert(1)',
  ' \njavascript:alert(1)',
  'java\tscript:alert(1)',
  'data:text/html,test',
])('does not create an executable mirror link from a source URL: %s', (href) => {
  const { dom, area, layer } = setup();
  document.body.innerHTML = '<p><a>Unsafe</a> <a href="/safe">Safe</a></p>';
  document.querySelector('a')?.setAttribute('href', href);
  dom.invalidate();
  dom.update(area);
  dom.accept({
    blocks: dom.missing().map((text) => ({
      id: text.id,
      translation: `Translated ${text.text}`,
    })),
  });
  expect([...layer.querySelectorAll('a[href]')].map((link) => link.getAttribute('href'))).toEqual([
    '/safe',
  ]);
});

it('collects read-only document islands without collecting surrounding editable drafts', () => {
  const { dom, area } = setup();
  document.body.innerHTML = `<article contenteditable="true"><p>Draft before.</p>
    <section contenteditable="false"><p>Read-only document.</p><p contenteditable="invalid">Inherited read-only.</p>
    <p contenteditable="plaintext-only">Private draft.</p></section><p>Draft after.</p></article>`;
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Read-only document.', 'Inherited read-only.']);
});

it('counts rejected hidden nodes toward the source-discovery budget', () => {
  const { dom, area } = setup();
  document.body.innerHTML = '<div hidden></div>'.repeat(10020) + '<p>Past the discovery limit.</p>';
  const computed = window.getComputedStyle(document.body);
  const styles = vi.spyOn(window, 'getComputedStyle').mockReturnValue(computed);
  styles.mockClear();
  dom.invalidate();
  dom.update(area);
  expect(styles.mock.calls.length).toBeLessThanOrEqual(10001);
  expect(dom.missing()).toEqual([]);
  expect(dom.report().boundaries['node-budget']).toBe(1);
});

it('retains complete admitted text when later discovery exhausts the node budget', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<p>Visible <a href="#">linked</a> paragraph.</p>' +
    '<div hidden></div>'.repeat(10020) +
    '<p>Past the discovery limit.</p>';
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((block) => block.text)).toEqual(['Visible <m0>linked</m0> paragraph.']);
  expect(dom.report().boundaries['node-budget']).toBe(1);
});

it('does not send a truncated block when the source-discovery budget ends inside it', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<p><span>Beginning </span>' + '<i></i>'.repeat(10020) + '<span>ending.</span></p>';
  dom.invalidate();
  dom.update(area);
  expect(dom.missing()).toEqual([]);
  expect(dom.report().boundaries['node-budget']).toBe(1);
});

it('distinguishes pending, failed, unchanged and painted results without calling all of them translated', () => {
  const { dom } = setup();
  const source = dom.missing()[0];
  if (!source) throw new Error('Missing source entry');
  expect(dom.report().targets).toEqual([{ id: source.id, state: 'untranslated' }]);
  expect(dom.report(new Set([source.id])).targets).toEqual([{ id: source.id, state: 'pending' }]);
  expect(dom.report(new Set(), new Set([source.id])).targets).toEqual([
    { id: source.id, state: 'model-failed' },
  ]);
  dom.accept({ blocks: [{ id: source.id, translation: source.text }] });
  expect(dom.report().targets).toEqual([{ id: source.id, state: 'unchanged-result' }]);
  dom.accept({ blocks: [{ id: source.id, translation: '完整的<m0>链接</m0>段落。' }] });
  expect(dom.report().targets).toEqual([{ id: source.id, state: 'rendered' }]);
});

it('bounds the visible-text check inside an unsupported transformed subtree', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<div style="transform:rotate(1deg)">' +
    '<span></span>'.repeat(10020) +
    '<span>Past the limit</span></div>';
  const ordinary = window.getComputedStyle(document.body);
  const transformed = window.getComputedStyle(document.body.firstElementChild as Element);
  const styles = vi
    .spyOn(window, 'getComputedStyle')
    .mockImplementation((el) => (el.tagName === 'DIV' ? transformed : ordinary));
  styles.mockClear();
  dom.invalidate();
  dom.update(area);
  // One root visit leaves at most 9,999 descendants; repeated root-style reads are not visits.
  expect(styles.mock.calls.filter(([el]) => el.tagName === 'SPAN').length).toBeLessThanOrEqual(
    9999,
  );
  expect(dom.missing()).toEqual([]);
});

it('ignores explicitly hidden decorative watermarks without flagging the readable page', () => {
  const { dom, area } = setup();
  document.body.innerHTML = `<p>Readable document.</p>
    <div aria-hidden="true" style="transform:rotate(-20deg);opacity:.08">Watermark</div>`;
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Readable document.']);
  expect(dom.unsupported).toEqual([]);
});

it.each([
  'clip-path:inset(50%);overflow:hidden;width:1px;height:1px',
  'position:absolute;clip:rect(0px,0px,0px,0px)',
  'content-visibility:hidden',
])('does not expose clipped menu labels through the translation layer: %s', (css) => {
  const { dom, layer, area } = setup();
  document.body.innerHTML = `<p>Visible paragraph.</p><nav style="${css}"><div style="background:linear-gradient(to right,blue,white)">Website</div><div>Community</div><div>Solutions</div></nav>`;
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Visible paragraph.']);
  dom.accept({
    blocks: dom.missing().map((t) => ({ id: t.id, translation: '可见段落。' })),
  });
  expect(layer.querySelectorAll('.text')).toHaveLength(1);
});

it('keeps an unsupported body clipping shape native', () => {
  const { dom, area } = setup();
  const previous = document.body.style.clipPath;
  try {
    document.body.innerHTML = '<p>Do not translate outside this shape.</p>';
    document.body.style.clipPath = 'circle(30%)';
    dom.invalidate();
    dom.update(area);
    expect(dom.missing()).toEqual([]);
  } finally {
    document.body.style.clipPath = previous;
  }
});

it('keeps a closed disclosure body hidden while translating its visible summary', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<details><summary>Open menu</summary><p>Hidden menu item</p></details>';
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Open menu']);
  document.querySelector('details')?.setAttribute('open', '');
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Open menu', 'Hidden menu item']);
});

it('removes every translated label when a previously open menu becomes clipped', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML = '<nav><div>Website</div><div>Community</div><div>Solutions</div></nav>';
  dom.invalidate();
  dom.update(area);
  dom.accept({
    blocks: dom.missing().map((t, i) => ({
      id: t.id,
      translation: ['网站', '社区', '解决方案'][i] ?? '',
    })),
  });
  expect(layer.querySelectorAll('.text')).toHaveLength(3);
  document.querySelector('nav')?.setAttribute('style', 'clip-path:inset(50%)');
  dom.invalidate();
  dom.update(area);
  expect(layer.querySelectorAll('.text')).toHaveLength(0);
  expect(dom.missing()).toEqual([]);
});

it('does not collect anonymous hidden text when a disclosure summary is inline', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<details><summary style="display:inline">Open menu</summary>Hidden menu item</details>';
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Open menu']);
});

it('moves existing paragraph layers independently on scroll, but relayouts after wrapping changes', () => {
  const { dom, layer } = setup();
  document.body.innerHTML = '<p>Scrolling paragraph.</p><p>Sticky paragraph.</p>';
  const paragraphs = [...document.querySelectorAll('p')];
  let y = 180;
  let width = 300;
  paragraphs.forEach((p, index) => {
    p.style.cssText = 'padding:0;border:0';
    p.getBoundingClientRect = () => new DOMRect(100, index ? 100 : y, width, 40);
  });
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    let owner: Element | null = null;
    return {
      selectNodeContents(n: Node) {
        owner = n.parentElement;
      },
      getClientRects: () => [owner?.getBoundingClientRect() ?? new DOMRect()],
    } as unknown as Range;
  });
  const area = { x: 0, y: 0, width: 1200, height: 700 };
  dom.invalidate();
  dom.update(area);
  dom.accept({
    blocks: dom.missing().map((t, i) => ({
      id: t.id,
      translation: i ? '固定段落。' : '滚动段落。',
    })),
  });
  const before = [...layer.querySelectorAll<HTMLElement>('.text')];
  const groups = [...layer.querySelectorAll<HTMLElement>('.translation-group')];
  y = 120;
  dom.invalidate(false);
  dom.update(area);
  expect(layer.querySelectorAll('.text')[0]).toBe(before[0]);
  expect(layer.querySelectorAll('.text')[1]).toBe(before[1]);
  expect(layer.querySelectorAll('.translation-group')[0]).toBe(groups[0]);
  expect(groups[0]?.style.top).toBe('120px');
  expect(groups[1]?.style.top).toBe('100px');
  expect(dom.missing()).toEqual([]);
  width = 200;
  dom.invalidate();
  dom.update(area);
  expect(layer.querySelectorAll('.text')[0]).not.toBe(before[0]);
  expect((layer.querySelector('.translation-group') as HTMLElement).style.width).toBe('200px');
  expect(dom.missing()).toEqual([]);
});

it('anchors a flex navigation label after its icon instead of at the container padding', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML =
    '<a href="#models" style="display:flex;padding:0 8px;border:0"><svg style="display:block" width="16" height="16"><path d="M0 0h16v16z" /></svg>Models</a>';
  const link = document.querySelector('a');
  if (!link) throw new Error('Link missing');
  link.getBoundingClientRect = () => new DOMRect(100, 100, 100, 24);
  const svg = document.querySelector('svg');
  if (!svg) throw new Error('Icon missing');
  svg.getBoundingClientRect = () => new DOMRect(108, 104, 16, 16);
  vi.spyOn(document, 'createRange').mockImplementation(
    () =>
      ({
        selectNodeContents() {},
        getClientRects: () => [new DOMRect(130, 102, 54, 20)],
      }) as unknown as Range,
  );
  dom.invalidate();
  dom.update({ ...area, x: 80 });
  const source = dom.missing()[0];
  if (!source) throw new Error('Source missing');
  dom.accept({ blocks: [{ id: source.id, translation: '模型' }] });
  const mirror = layer.querySelector('a');
  expect(mirror?.style.display).toBe('flex');
  expect(mirror?.firstElementChild?.tagName).toBe('svg');
  expect(mirror?.lastElementChild?.textContent).toBe('模型');
  expect(layer.querySelector('.source-mask')).toBeNull();
  expect(link.textContent).toBe('Models');
});

it.each([0.75, 1, 2])(
  'preserves fractional layout coordinates without fitting or rounding at DPR %s',
  (dpr) => {
    const { dom, layer, area } = setup();
    vi.stubGlobal('devicePixelRatio', dpr);
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue(
      new DOMRect(100.6, 100.6, 900.6, 40.6),
    );
    vi.spyOn(document, 'createRange').mockImplementation(
      () =>
        ({
          selectNodeContents() {},
          getClientRects: () => [new DOMRect(100.6, 100.6, 900.6, 20.6)],
        }) as unknown as Range,
    );
    dom.invalidate();
    dom.update(area);
    const source = dom.missing()[0];
    if (!source) throw new Error('Source missing');
    dom.accept({
      blocks: [{ id: source.id, translation: '完整 <m0>链接</m0> 段落。' }],
    });
    const group = layer.querySelector<HTMLElement>('.translation-group');
    expect(group?.style.left).toBe('100.6px');
    expect(group?.style.top).toBe('100.6px');
    expect(group?.style.width).toBe('900.6px');
    expect(group?.style.minHeight).toBe('40.6px');
  },
);

it('does not stretch a text mask across an independently translated inline control', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<p>Before<button style="display:inline-block">Control</button>After</p>';
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    let text = '';
    return {
      selectNodeContents(node: Node) {
        text = node.textContent ?? '';
      },
      getClientRects: () => [
        new DOMRect(
          text === 'Before' ? 100 : text === 'Control' ? 150 : 250,
          100,
          text === 'Control' ? 100 : 50,
          20,
        ),
      ],
    } as unknown as Range;
  });
  dom.invalidate();
  dom.update({ ...area, x: 80, width: 400 });
  expect(dom.visible.filter((e) => e.owner.tagName === 'P').flatMap((e) => e.lines)).toEqual([
    { x: 100, y: 100, width: 50, height: 20 },
    { x: 250, y: 100, width: 50, height: 20 },
  ]);
});

it('keeps small text-free SVG icons native even when their wrapper animates or their paths are translucent', () => {
  const { dom, area } = setup();
  const icon = document.createElement('span');
  icon.innerHTML = '<svg width="32" height="32"><path opacity=".4" d="M0,0 L32,32" /></svg>';
  icon.style.transform = 'rotate(20deg)';
  icon.getBoundingClientRect = () => new DOMRect(200, 100, 32, 32);
  document.body.append(icon);
  dom.invalidate();
  dom.update(area);
  expect(dom.unsupported).toEqual([]);
  expect(dom.missing().map((t) => t.text)).toEqual(['Full <m0>linked</m0> paragraph.']);
  const svg = icon.querySelector('svg');
  if (!svg) throw new Error('SVG fixture missing');
  svg.innerHTML = '<text>Readable</text>';
  dom.invalidate();
  dom.update(area);
  expect(dom.unsupported).toEqual([{ x: 200, y: 100, width: 32, height: 32 }]);
  expect(dom.missing().map((t) => t.text)).toEqual(['Full <m0>linked</m0> paragraph.']);
  expect(svg.textContent).toBe('Readable');
});

it('does not cancel a pending HTML translation when neighbouring visual pixels are inspected', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('innerHeight', 400);
  setup();
  document.body.append(document.createElement('canvas'));
  let finish: ((response: ExtensionResponse) => void) | undefined;
  const send = vi.fn<RuntimePort['send']>(async (m) =>
    m.type === 'translation.read'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : {
          version: 1,
          requestId: m.requestId,
          ok: true,
          data: { active: true },
        },
  );
  toggleTranslationLens(
    {
      sessionId: 'dom',
      loadingText: '等待',
      errorText: '错误',
      unsupportedText: 'Share this tab',
      retryText: 'Retry',
    },
    document,
    window,
    { send },
  );
  await vi.advanceTimersByTimeAsync(300);
  expect(send.mock.calls.some(([m]) => m.type === 'translation.read' && 'texts' in m.payload)).toBe(
    true,
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(send.mock.calls.filter(([m]) => m.type === 'translation.cancel')).toHaveLength(0);
  closeTranslationLens();
  finish?.({ version: 1, requestId: 'late', ok: true, data: { blocks: [] } });
});

it('never reads an editable document root', () => {
  const { dom, area } = setup();
  document.body.setAttribute('contenteditable', 'true');
  try {
    dom.invalidate();
    dom.update(area);
    expect(dom.missing()).toEqual([]);
  } finally {
    document.body.removeAttribute('contenteditable');
  }
});

it('stops passive screenshots after a text failure without blocking the visible error', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('innerHeight', 400);
  setup();
  document.body.append(document.createElement('canvas'));
  const send = vi.fn<RuntimePort['send']>(async (m) =>
    m.type === 'translation.read'
      ? {
          version: 1,
          requestId: m.requestId,
          ok: false,
          error: {
            code: 'MODEL_AUTH',
            message: 'Private upstream credentials',
          },
        }
      : {
          version: 1,
          requestId: m.requestId,
          ok: true,
          data: { active: true },
        },
  );
  toggleTranslationLens(
    {
      sessionId: 'failed-text',
      loadingText: '等待',
      errorText: '错误',
      unsupportedText: 'Share this tab',
      retryText: 'Retry',
    },
    document,
    window,
    { send },
  );
  await vi.advanceTimersByTimeAsync(300);
  const count = send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4000);
  expect(send.mock.calls.slice(count).every(([m]) => m.type === 'translation.getState')).toBe(true);
  expect(
    document.querySelector<HTMLElement>('[data-chatbrowserx-overlay=translation]')?.dataset.status,
  ).toBe('error');
});

it('reads the complete inline paragraph crossing the lens, excluding hidden and editable content', () => {
  const { dom } = setup();
  expect(dom.missing().map((t) => t.text)).toEqual(['Full <m0>linked</m0> paragraph.']);
  expect(dom.unsupported).toEqual([]);
});

it.each(['fill', 'cover', 'contain'])(
  'leaves an image with %s layout outside translation requests',
  (fit) => {
    const { dom, area } = setup();
    const image = document.createElement('img');
    image.style.cssText = `object-fit:${fit};object-position:25% 75%;transform:none;filter:none;opacity:1;clip-path:none`;
    image.getAnimations = () => [];
    document.body.append(image);
    dom.invalidate();
    dom.update(area);
    expect(dom.missing().map((entry) => entry.text)).toEqual(['Full <m0>linked</m0> paragraph.']);
    expect(dom.unsupported).toEqual([]);
  },
);

it('translates text on a simple gradient using the original background coordinates', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML =
    '<div style="background-image:linear-gradient(to right, red, blue)"><p style="padding:0;border:0">Gradient card.</p></div>';
  dom.invalidate();
  dom.update(area);
  expect(dom.unsupported).toEqual([]);
  const text = dom.missing()[0];
  if (!text) throw new Error('Gradient text missing');
  dom.accept({ blocks: [{ id: text.id, translation: '渐变卡片。' }] });
  const group = layer.querySelector<HTMLElement>('.translation-group');
  expect(group?.querySelector('p')?.parentElement?.style.backgroundImage).toBe(
    'linear-gradient(to right, red, blue)',
  );
  expect(group?.style.left).toBe('100px');
  expect(group?.style.width).toBe('900px');
});

it.each([
  'background-image:radial-gradient(red,blue)',
  'background-image:linear-gradient(red,blue),url("/texture.png")',
  'background-image:linear-gradient(red,blue);background-attachment:fixed',
  'background-image:linear-gradient(red,blue);background-size:50% 50%',
])('preserves native static background composition in the structural copy: %s', (css) => {
  const { dom, area, layer } = setup();
  document.body.innerHTML = `<div style='${css}'><p>Complex card.</p></div>`;
  dom.invalidate();
  dom.update(area);
  const source = dom.missing()[0];
  expect(source?.text).toBe('Complex card.');
  if (!source) throw new Error('Missing source');
  dom.accept({ blocks: [{ id: source.id, translation: '复杂背景卡片。' }] });
  const native = document.body.firstElementChild as HTMLElement;
  const style = window.getComputedStyle(native);
  const mirror = layer.querySelector('.translation-group p')?.parentElement as HTMLElement;
  expect(mirror.style.backgroundImage).toBe(style.backgroundImage);
  expect(mirror.style.backgroundAttachment).toBe(style.backgroundAttachment);
  expect(mirror.style.backgroundSize).toBe(style.backgroundSize);
  expect(dom.layoutUnsupported.size).toBe(0);
});

it('does not invent a flat backdrop for an image over a gradient, while allowing its sibling text', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<div style="background-image:linear-gradient(red,blue)"><p>Readable card.</p><img style="object-fit:fill;transform:none;filter:none;opacity:1;clip-path:none"></div>';
  const image = document.querySelector('img');
  if (!image) throw new Error('Missing image');
  image.getAnimations = () => [];
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Readable card.']);
  expect(dom.unsupported).toHaveLength(0);
});

it('does not merge anonymous prose across a block child into one translated paragraph', () => {
  const { dom, area } = setup();
  document.body.innerHTML = '<div>First paragraph.<h2>A heading</h2>Second paragraph.</div>';
  dom.invalidate();
  dom.update(area);
  expect(dom.visible.map((e) => e.text).sort()).toEqual([
    'A heading',
    'First paragraph.',
    'Second paragraph.',
  ]);
});

it('preserves explicit source line breaks instead of joining them into one paragraph', () => {
  const { dom, area } = setup();
  document.body.innerHTML = '<p>First line.<br>Second line.</p>';
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['First line.', 'Second line.']);
});

it('renders marked translations with source-owned link styles without executing model HTML', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML =
    '<p>Read <a href="/source" style="color:blue;text-decoration:underline">the source</a>.</p>';
  dom.invalidate();
  dom.update(area);
  const source = dom.missing()[0];
  if (!source) throw new Error('Source missing');
  expect(source?.text).toBe('Read <m0>the source</m0>.');
  dom.accept({
    blocks: [
      {
        id: source.id,
        translation: '阅读 <m0>原始资料</m0> &lt;img onerror=alert(1)&gt;。',
      },
    ],
  });
  const link = layer.querySelector('a');
  expect(link?.textContent).toBe('原始资料');
  expect(link?.getAttribute('href')).toBe('/source');
  expect(link?.style.color).toBe('rgb(0, 0, 255)');
  expect(link?.style.textDecoration).toContain('underline');
  expect(layer.querySelector('img')).toBeNull();
  expect(layer.textContent).toBe('阅读 原始资料 <img onerror=alert(1)>。');
  expect(document.querySelector('p')?.textContent).toBe('Read the source.');
});

it('keeps standalone navigation links separate, with their own styles and source bounds', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML =
    '<div style="color:black"><a href="/home" style="color:blue;text-decoration:underline">Home</a> | <a href="/blog" style="color:red;text-decoration:underline">Blog</a></div>';
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Home', 'Blog']);
  dom.accept({
    blocks: dom.missing().map((t) => ({
      id: t.id,
      translation: t.text === 'Home' ? '首页' : '博客',
    })),
  });
  expect(
    [...layer.querySelectorAll<HTMLElement>('.text')].map((s) => ({
      text: s.textContent,
      color: s.style.color,
      decoration: s.style.textDecoration,
    })),
  ).toEqual([
    { text: '首页', color: 'rgb(0, 0, 255)', decoration: 'underline' },
    { text: '博客', color: 'rgb(255, 0, 0)', decoration: 'underline' },
  ]);
  expect(document.querySelectorAll('a[href]')).toHaveLength(2);
});

it('treats literal marker-like text and escaped model HTML only as text', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML = '<p>Use &lt;m0&gt; &amp; &lt;script&gt; literally.</p>';
  dom.invalidate();
  dom.update(area);
  const source = dom.missing()[0];
  if (!source) throw new Error('Source missing');
  expect(source.text).toBe('Use &lt;m0&gt; &amp; &lt;script&gt; literally.');
  expect(
    dom.accept({
      blocks: [
        {
          id: source.id,
          translation: '按字面使用 &lt;m0&gt; &amp; &lt;script&gt;。',
        },
      ],
    }),
  ).toEqual([]);
  expect(layer.textContent).toBe('按字面使用 <m0> & <script>。');
  expect(layer.querySelector('script')).toBeNull();
});

it('does not cache an invalid styled paragraph or lose a successful sibling', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML = '<p>First <a href="/source">link</a>.</p><p>Second.</p>';
  dom.invalidate();
  dom.update(area);
  const [first, second] = dom.missing();
  if (!first || !second) throw new Error('Source missing');
  const failed = dom.accept({
    blocks: [
      { id: first.id, translation: '丢失样式' },
      { id: second.id, translation: '第二段。' },
    ],
  });
  expect(failed).toEqual([first.id]);
  expect(dom.cache.size).toBe(1);
  expect(layer.textContent).toBe('第二段。');
  expect(dom.missing()).toEqual([first]);
});

it('does not cache a late translation when its source text node was replaced', () => {
  const { dom, layer, area } = setup();
  const original = dom.missing()[0];
  if (!original) throw new Error('Source missing');
  const p = document.querySelector('p');
  if (!p) throw new Error('Paragraph missing');
  p.textContent = 'New paragraph.';
  dom.accept({ blocks: [{ id: original.id, translation: '过时的译文' }] });
  expect(layer.querySelector('.text')).toBeNull();
  expect(dom.entries.get(p)?.translation).toBeUndefined();
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['New paragraph.']);
  expect(dom.missing()[0]?.id).not.toBe(original.id);
});

it('keeps every visible link available across bounded batches, beyond the offscreen cache size', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<nav>' +
    Array.from({ length: 160 }, (_, i) => `<a href="/${i}">Link ${i}</a>`).join(' | ') +
    '</nav>';
  dom.invalidate();
  dom.update(area);
  expect(dom.visible).toHaveLength(160);
  for (const entry of dom.visible) expect(dom.entries.get(entry.key)).toBe(entry);
  dom.scroll();
  for (let i = 0; i < 5; i++) {
    const batch = dom.missing();
    expect(batch).toHaveLength(32);
    dom.accept({ blocks: batch.map(({ id }) => ({ id, translation: '链接' })) });
    expect(dom.missing().every((t) => !batch.some((b) => b.id === t.id))).toBe(true);
  }
  expect(dom.missing()).toEqual([]);
  expect(dom.cache.size).toBe(160);
  const navigation = document.querySelector('nav');
  if (!navigation) throw new Error('Missing fixture navigation');
  navigation.hidden = true;
  const next = document.createElement('section');
  next.innerHTML = Array.from({ length: 200 }, (_, i) => `<p>Section ${i}</p>`).join('');
  document.body.append(next);
  dom.settle();
  dom.invalidate();
  dom.update(area);
  expect(dom.visible).toHaveLength(200);
  expect(dom.entries.size).toBe(200 + 128);
  expect(dom.cache.size).toBe(128);
  dom.scroll();
  for (let i = 0; i < 7; i++)
    dom.accept({ blocks: dom.missing().map(({ id }) => ({ id, translation: '章节' })) });
  expect(dom.missing()).toEqual([]);
  expect(dom.cache.size).toBe(200 + 128);
});

it('does not silently stop a dense visible grid at the old owner-cache limit', () => {
  const { dom, area } = setup();
  document.body.innerHTML = Array.from({ length: 200 }, (_, i) => `<p>栏目 ${i}</p>`).join('');
  dom.invalidate();
  dom.update(area);
  expect(dom.visible).toHaveLength(200);
  expect(dom.visible.at(-1)?.plain).toBe('栏目 199');
  expect(dom.missing()).toHaveLength(32);
});

it('retains text source IDs when an untranslated image is added beside them', () => {
  const { dom, area } = setup();
  const original = dom.missing();
  const image = document.createElement('img');
  image.getAnimations = () => [];
  document.body.append(image);
  dom.invalidate();
  dom.update(area);
  expect(dom.missing()).toEqual(original);
  expect(dom.unsupported).toEqual([]);
  expect(image.isConnected).toBe(true);
});

it('bounds collected source size and batches without losing later short text', () => {
  const { dom, area } = setup();
  document.body.innerHTML = [8000, 8000, 8001, 1].map((n) => `<p>${'x'.repeat(n)}</p>`).join('');
  dom.invalidate();
  dom.update(area);
  const batch = dom.missing();
  expect(batch.map((t) => t.text.length)).toEqual([8000, 8000]);
  expect(dom.visible.map((t) => t.text.length)).toEqual([8000, 8000, 1]);
  expect(dom.unsupported).toEqual([{ x: 100, y: 100, width: 900, height: 40 }]);
  expect(dom.missing(new Set(batch.map((t) => t.id))).map((t) => t.text)).toEqual(['x']);
});

it('does not rescan layout when the observation window moves within the collected buffer', () => {
  const { dom, area } = setup();
  vi.mocked(Element.prototype.getBoundingClientRect).mockClear();
  dom.update({ ...area, x: area.x + 10 }, { x: 250, y: 100, width: 200, height: 50 });
  expect(Element.prototype.getBoundingClientRect).not.toHaveBeenCalled();
  dom.invalidate();
  dom.update({ ...area, x: area.x + 10 }, { x: 250, y: 100, width: 200, height: 50 });
  expect(Element.prototype.getBoundingClientRect).toHaveBeenCalled();
});

it('defers source collection and arriving translations until scrolling settles', () => {
  const { dom, layer, area } = setup();
  const source = dom.missing()[0];
  if (!source) throw new Error('Source missing');
  dom.accept({ blocks: [{ id: source.id, translation: '<m0>临时译文</m0>' }] }, true);
  const group = layer.firstElementChild;
  const paragraph = document.querySelector('p');
  if (!paragraph) throw new Error('Paragraph missing');
  dom.scroll();
  const walk = vi.spyOn(document, 'createTreeWalker');
  dom.invalidate([paragraph]);
  dom.update(area);
  dom.accept({ blocks: [{ id: source.id, translation: '<m0>最终译文</m0>' }] });
  dom.clearPreview(new Set([source.id]));
  expect(walk).not.toHaveBeenCalled();
  expect(layer.firstElementChild).toBe(group);
  expect(layer.textContent).toBe('临时译文');
  expect(dom.cache.size).toBe(1);
  dom.settle();
  dom.update(area);
  expect(walk).toHaveBeenCalled();
  expect(layer.textContent).toBe('最终译文');
  expect(dom.missing()).toEqual([]);
});

it('paints text previews without caching completion and clears only their source IDs', () => {
  const { dom, layer, area } = setup();
  const source = dom.missing()[0];
  if (!source) throw new Error('Source missing');
  dom.accept({ blocks: [{ id: source.id, translation: '<m0>临时译文</m0>' }] }, true);
  expect(layer.textContent).toBe('临时译文');
  expect(dom.missing()).toEqual([source]);
  dom.invalidate();
  dom.update(area);
  expect(layer.textContent).toBe('临时译文');
  const render = vi.spyOn(TranslationStructureLayout.prototype, 'render');
  dom.clearPreview(new Set(['another-request']));
  expect(layer.textContent).toBe('临时译文');
  expect(render).not.toHaveBeenCalled();
  dom.clearPreview(new Set([source.id]));
  expect(layer.textContent).toBe('');
  expect(dom.missing()).toEqual([source]);
  expect(render).toHaveBeenCalledTimes(1);
  dom.clearPreview(new Set([source.id]));
  expect(render).toHaveBeenCalledTimes(1);
});

it('removes a preview on source changes and ignores late updates for the old source ID', () => {
  const { dom, layer, area } = setup();
  const source = dom.missing()[0];
  const paragraph = document.querySelector('p');
  if (!source || !paragraph) throw new Error('Source missing');
  const result = {
    blocks: [{ id: source.id, translation: '<m0>原段落的译文</m0>' }],
  };
  dom.accept(result, true);
  paragraph.textContent = 'Changed source.';
  dom.invalidate();
  dom.update(area);
  dom.accept(result, true);
  dom.accept(result);
  expect(layer.textContent).toBe('');
  expect(dom.missing().map((block) => block.text)).toEqual(['Changed source.']);
  expect(dom.missing()[0]?.id).not.toBe(source.id);
});

it('keeps final text when its preview is cleaned up, but removes a preview if the final text is unchanged', () => {
  const { dom, layer } = setup();
  const source = dom.missing()[0];
  if (!source) throw new Error('Source missing');
  dom.accept({ blocks: [{ id: source.id, translation: '<m0>临时译文</m0>' }] }, true);
  dom.accept({ blocks: [{ id: source.id, translation: '<m0>最终译文</m0>' }] });
  expect(layer.textContent).toBe('最终译文');
  expect(dom.missing()).toEqual([]);
  dom.accept({ blocks: [{ id: source.id, translation: source.text }] });
  expect(layer.textContent).toBe('');
  dom.clearPreview(new Set([source.id]));
  expect(layer.textContent).toBe('');
});
