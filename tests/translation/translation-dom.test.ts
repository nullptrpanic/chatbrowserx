import { afterEach, expect, it, vi } from 'vitest';
import { TranslationDom } from '../../src/page/translation/translation-dom';
import {
  closeTranslationLens,
  toggleTranslationLens,
} from '../../src/page/translation/mount-translation-lens';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import type { ExtensionResponse } from '../../src/shared/protocol/message-types';
import { inspectionFixture } from './inspection-fixture';

function setup() {
  document.body.innerHTML =
    '<p>Full <a href="#">linked</a> paragraph.</p><p hidden>Private</p><textarea>Secret</textarea>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(100, 100, 900, 40),
  );
  const create = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() =>
    Object.assign(create(), {
      getClientRects: () => [new DOMRect(100, 100, 900, 20)],
    }),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as CanvasRenderingContext2D);
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

it('does not cancel a pending HTML translation when neighbouring visual pixels are inspected', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('innerHeight', 400);
  setup();
  document.body.append(document.createElement('canvas'));
  let finish: ((response: ExtensionResponse) => void) | undefined;
  const send = vi.fn<RuntimePort['send']>(async (m) =>
    m.type === 'translation.inspect'
      ? inspectionFixture(m)
      : m.type === 'translation.read'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { version: 1, requestId: m.requestId, ok: true, data: { active: true } },
  );
  toggleTranslationLens(
    { sessionId: 'dom', loadingText: '等待', errorText: '错误' },
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
    m.type === 'translation.inspect'
      ? inspectionFixture(m)
      : m.type === 'translation.read'
        ? {
            version: 1,
            requestId: m.requestId,
            ok: false,
            error: { code: 'MODEL_AUTH', message: 'Private upstream credentials' },
          }
        : { version: 1, requestId: m.requestId, ok: true, data: { active: true } },
  );
  toggleTranslationLens(
    { sessionId: 'failed-text', loadingText: '等待', errorText: '错误' },
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
  expect(dom.missing().map((t) => t.text)).toEqual(['Full linked paragraph.']);
  expect(dom.visual).toEqual([]);
});

it('keeps standalone navigation links separate, with their own styles and source bounds', () => {
  const { dom, layer, area } = setup();
  document.body.innerHTML =
    '<div style="color:black"><a href="/home" style="color:blue;text-decoration:underline">Home</a> | <a href="/blog" style="color:red;text-decoration:underline">Blog</a></div>';
  dom.invalidate();
  dom.update(area);
  expect(dom.missing().map((t) => t.text)).toEqual(['Home', 'Blog']);
  dom.accept({
    blocks: dom
      .missing()
      .map((t) => ({ id: t.id, translation: t.text === 'Home' ? '首页' : '博客' })),
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

it('bounds independent link collection so admitted source IDs remain available for completion', () => {
  const { dom, area } = setup();
  document.body.innerHTML =
    '<nav>' +
    Array.from({ length: 160 }, (_, i) => `<a href="/${i}">Link ${i}</a>`).join(' | ') +
    '</nav>';
  dom.invalidate();
  dom.update(area);
  expect(dom.visible.length).toBeLessThanOrEqual(128);
  const batch = dom.missing();
  dom.accept({ blocks: batch.map(({ id }) => ({ id, translation: '链接' })) });
  expect(dom.missing().every((t) => !batch.some((b) => b.id === t.id))).toBe(true);
});

it('retains source IDs while layout changes and classifies images for the visual path', () => {
  const { dom, area } = setup();
  const original = dom.missing();
  document.body.append(document.createElement('img'));
  dom.invalidate();
  dom.update(area);
  expect(dom.missing()).toEqual(original);
  expect(dom.visual).toEqual([{ x: 100, y: 100, width: 900, height: 40 }]);
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

it('paints text previews without caching completion and clears only their source IDs', () => {
  const { dom, layer, area } = setup();
  const source = dom.missing()[0];
  if (!source) throw new Error('Source missing');
  dom.accept({ blocks: [{ id: source.id, translation: '临时译文' }] }, true);
  expect(layer.textContent).toBe('临时译文');
  expect(dom.missing()).toEqual([source]);
  dom.invalidate();
  dom.update(area);
  expect(layer.textContent).toBe('临时译文');
  dom.clearPreview(new Set(['another-request']));
  expect(layer.textContent).toBe('临时译文');
  dom.clearPreview(new Set([source.id]));
  expect(layer.textContent).toBe('');
  expect(dom.missing()).toEqual([source]);
});

it('removes a preview on source changes and ignores late updates for the old source ID', () => {
  const { dom, layer, area } = setup();
  const source = dom.missing()[0];
  const paragraph = document.querySelector('p');
  if (!source || !paragraph) throw new Error('Source missing');
  const result = { blocks: [{ id: source.id, translation: '原段落的译文' }] };
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
  dom.accept({ blocks: [{ id: source.id, translation: '临时译文' }] }, true);
  dom.accept({ blocks: [{ id: source.id, translation: '最终译文' }] });
  expect(layer.textContent).toBe('最终译文');
  expect(dom.missing()).toEqual([]);
  dom.accept({ blocks: [{ id: source.id, translation: source.text }] });
  expect(layer.textContent).toBe('');
  dom.clearPreview(new Set([source.id]));
  expect(layer.textContent).toBe('');
});
