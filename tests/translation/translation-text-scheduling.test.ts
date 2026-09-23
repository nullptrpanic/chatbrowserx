import { afterEach, expect, it, vi } from 'vitest';
import {
  closeTranslationLens,
  toggleTranslationLens,
} from '../../src/page/translation/mount-translation-lens';
import type { RuntimePort } from '../../src/platform/chrome/runtime-port';
import type { ExtensionMessage, ExtensionResponse } from '../../src/shared/protocol/message-types';
import { mockAbsentPseudoStyles, mockTranslationGroupBox } from './dom-fixture';
import { TranslationStructureLayout } from '../../src/page/translation/translation-structure-layout';
import { TranslationDom } from '../../src/page/translation/translation-dom';

function setup(html?: string) {
  mockAbsentPseudoStyles();
  vi.useFakeTimers();
  vi.stubGlobal('innerWidth', 1200);
  vi.stubGlobal('innerHeight', 1600);
  document.body.innerHTML =
    html ??
    '<p data-y="220">Upper paragraph.</p><p data-y="520">Lower paragraph.</p><p data-y="1000">Last paragraph.</p>';
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const group = mockTranslationGroupBox(this, 24);
    if (group) return group;
    return this.matches('p')
      ? new DOMRect(300, Number((this as HTMLElement).dataset.y), 600, 24)
      : new DOMRect(0, 0, 1200, 1800);
  });
  const create = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = create();
    return Object.assign(range, {
      getClientRects: () =>
        range.startContainer.nodeType !== Node.TEXT_NODE
          ? []
          : [range.startContainer.parentElement?.getBoundingClientRect() ?? new DOMRect()],
    });
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as CanvasRenderingContext2D);
  const attach = Element.prototype.attachShadow;
  let shadow: ShadowRoot | undefined;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
    shadow = attach.call(this, init);
    return shadow;
  });
  type TextMessage = Extract<ExtensionMessage, { type: 'translation.read' }>;
  const reads: {
    message: TextMessage;
    finish: (reply: ExtensionResponse) => void;
  }[] = [];
  const listeners = new Set<(message: unknown) => void>();
  let stateFails = false;
  const send = vi.fn<RuntimePort['send']>(async (m) => {
    if (m.type === 'translation.read')
      return new Promise((finish) => reads.push({ message: m, finish }));
    if (m.type === 'translation.getState' && stateFails)
      return {
        version: 1,
        requestId: m.requestId,
        ok: false,
        error: {
          code: 'TRANSLATION_PAGE_UNAVAILABLE',
          message: 'Page unavailable.',
        },
      };
    return {
      version: 1,
      requestId: m.requestId,
      ok: true,
      data: { active: true },
    };
  });
  toggleTranslationLens(
    {
      sessionId: 'text-scheduling',
      loadingText: 'Loading',
      errorText: 'Failed',
      unsupportedText: 'Share this tab',
      retryText: 'Retry',
    },
    document,
    window,
    {
      send,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  );
  move(260);
  const host = document.querySelector<HTMLElement>('[data-chatbrowserx-overlay=translation]');
  if (!host || !shadow) throw new Error('Missing lens');
  return {
    reads,
    host,
    shadow,
    send,
    listeners,
    reopen(cacheKey = 'configured', resultKey = cacheKey) {
      toggleTranslationLens(
        {
          sessionId: `reopened-${reads.length}`,
          loadingText: 'Loading',
          errorText: 'Failed',
          unsupportedText: 'Share this tab',
          retryText: 'Retry',
          cacheKey,
        },
        document,
        window,
        {
          send,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      );
      move(260);
      return {
        get shadow() {
          return shadow;
        },
        finish(index: number, translation: string) {
          const read = reads[index];
          if (!read || !('texts' in read.message.payload)) throw new Error('Missing text request');
          read.finish({
            version: 1,
            requestId: read.message.requestId,
            ok: true,
            data: {
              cacheKey: resultKey,
              blocks: read.message.payload.texts.map(({ id }) => ({
                id,
                translation,
              })),
            },
          });
        },
      };
    },
    progress(index: number, translation: string, overrides: Record<string, unknown> = {}) {
      const read = reads[index];
      if (!read || !('texts' in read.message.payload)) throw new Error('Missing text request');
      const value = {
        version: 1,
        type: 'translation.progress',
        sessionId: 'text-scheduling',
        requestId: read.message.requestId,
        result: {
          blocks: read.message.payload.texts.map(({ id }) => ({
            id,
            translation,
          })),
        },
        ...overrides,
      };
      for (const listener of listeners) listener(value);
    },
    failState() {
      stateFails = true;
    },
    restoreState() {
      stateFails = false;
    },
    finish(index: number, translation: string) {
      const read = reads[index];
      if (!read || !('texts' in read.message.payload)) throw new Error('Missing text request');
      read.finish({
        version: 1,
        requestId: read.message.requestId,
        ok: true,
        data: {
          blocks: read.message.payload.texts.map(({ id }) => ({
            id,
            translation,
          })),
        },
      });
    },
  };
}

function move(y: number) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 600, clientY: y }));
}

function refresh(init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', {
    key: 'r',
    code: 'KeyR',
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

it('retains completed blocks and retries only missing IDs after a partial response', async () => {
  const lens = setup('<p data-y="220">First.</p><p data-y="250">Second.</p>');
  await vi.advanceTimersByTimeAsync(300);
  const read = lens.reads[0];
  const first = read?.message.payload.texts.find((t) => t.text === 'First.');
  const second = read?.message.payload.texts.find((t) => t.text === 'Second.');
  if (!read || !first || !second) throw new Error('Missing batch');
  read.finish({
    version: 1,
    requestId: read.message.requestId,
    ok: true,
    data: { blocks: [{ id: first.id, translation: '第一段。' }] },
  });
  await vi.advanceTimersByTimeAsync(1500);
  expect(lens.host.dataset.status).toBe('error');
  expect(lens.shadow.textContent).toContain('第一段。');
  expect(lens.shadow.textContent).toContain('TRANSLATION_RESPONSE_INVALID');
  expect(lens.reads).toHaveLength(1);
  move(270);
  await vi.advanceTimersByTimeAsync(500);
  expect(lens.reads).toHaveLength(1);
  lens.shadow.querySelector<HTMLButtonElement>('[role=status] button')?.click();
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(2);
  expect(lens.reads[1]?.message.payload.texts).toEqual([
    { id: expect.any(String), text: second.text },
  ]);
  expect(lens.reads[1]?.message.payload.texts[0]?.id).not.toBe(second.id);
  expect(lens.shadow.textContent).toContain('第一段。');
  lens.finish(1, '第二段。');
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.shadow.textContent).toContain('第一段。');
  expect(lens.shadow.textContent).toContain('第二段。');
  expect([...document.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
    'First.',
    'Second.',
  ]);
});

it('refreshes current source and context while retaining the valid translation until replacement', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  lens.finish(0, '原有译文');
  await vi.advanceTimersByTimeAsync(30);
  const context = document.querySelectorAll('p')[1];
  if (!context) throw new Error('Missing context paragraph');
  context.textContent = 'New reference terminology.';
  expect(refresh({ key: '®' }).defaultPrevented).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(2);
  expect(lens.reads[1]?.message.payload.texts.map((t) => t.text)).toEqual(['Upper paragraph.']);
  expect(lens.reads[1]?.message.payload.context).toContain('New reference terminology.');
  expect(lens.reads[1]?.message.payload.texts[0]?.id).not.toBe(
    lens.reads[0]?.message.payload.texts[0]?.id,
  );
  expect(lens.shadow.textContent).toContain('原有译文');
  lens.progress(1, '刷新预览');
  expect(lens.shadow.textContent).toContain('原有译文');
  lens.finish(1, '结合新上下文的译文');
  await vi.advanceTimersByTimeAsync(30);
  expect(lens.shadow.textContent).toContain('结合新上下文的译文');
  expect(lens.shadow.textContent).not.toContain('原有译文');
  expect(document.querySelector('p')?.textContent).toBe('Upper paragraph.');
});

it('supersedes pending streams on refresh without accepting old results or restarting old work', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  lens.progress(0, '旧预览');
  refresh();
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(2);
  expect(lens.shadow.textContent).not.toContain('旧预览');
  lens.progress(0, '迟到的旧预览');
  lens.finish(0, '迟到的旧结果');
  lens.finish(1, '本次结果');
  await vi.advanceTimersByTimeAsync(1500);
  expect(lens.shadow.textContent).toContain('本次结果');
  expect(lens.shadow.textContent).not.toContain('迟到');
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.reads).toHaveLength(2);
});

it('accepts only the current source after two refreshes complete out of order', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  const paragraph = document.querySelector('p');
  if (!paragraph) throw new Error('Missing source paragraph');
  for (const text of ['Second version.', 'Current version.']) {
    paragraph.textContent = text;
    await vi.advanceTimersByTimeAsync(30);
    refresh();
    await vi.advanceTimersByTimeAsync(300);
  }
  expect(lens.reads).toHaveLength(3);
  expect(lens.reads.map((r) => r.message.payload.texts[0]?.text)).toEqual([
    'Upper paragraph.',
    'Second version.',
    'Current version.',
  ]);
  expect(new Set(lens.reads.map((r) => r.message.payload.texts[0]?.id)).size).toBe(3);
  lens.finish(2, '当前译文');
  lens.progress(0, '过期预览');
  lens.finish(1, '过期中间译文');
  lens.finish(0, '过期最初译文');
  await vi.advanceTimersByTimeAsync(1500);
  expect(lens.shadow.textContent).toContain('当前译文');
  expect(lens.shadow.textContent).not.toContain('过期');
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.reads).toHaveLength(3);
  expect(paragraph.textContent).toBe('Current version.');
});

it.each(['refresh', 'close'] as const)(
  'cleans a cancelled request only once when its result arrives after %s',
  async (action) => {
    const lens = setup();
    await vi.advanceTimersByTimeAsync(300);
    lens.progress(0, '旧预览');
    const clear = vi.spyOn(TranslationDom.prototype, 'clearPreview');
    if (action === 'refresh') refresh();
    else closeTranslationLens();
    await vi.advanceTimersByTimeAsync(300);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(lens.shadow.textContent).not.toContain('旧预览');
    lens.finish(0, '迟到的旧结果');
    await vi.advanceTimersByTimeAsync(30);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(lens.shadow.textContent).not.toContain('迟到的旧结果');
    if (action === 'refresh') {
      expect(lens.reads).toHaveLength(2);
      lens.progress(1, '新预览');
      expect(lens.shadow.textContent).toContain('新预览');
      lens.finish(1, '本次结果');
      await vi.advanceTimersByTimeAsync(30);
      expect(lens.shadow.textContent).toContain('本次结果');
      expect(clear).toHaveBeenCalledTimes(2);
      expect(lens.host.dataset.status).toBe('ready');
    } else expect(lens.host.isConnected).toBe(false);
  },
);

it('retains completed translations outside the refreshed lens', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  lens.finish(0, '上方译文');
  move(1020);
  await vi.advanceTimersByTimeAsync(300);
  lens.finish(1, '最后译文');
  move(260);
  await vi.advanceTimersByTimeAsync(100);
  refresh();
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(3);
  lens.finish(2, '上方更新');
  move(1020);
  await vi.advanceTimersByTimeAsync(500);
  expect(lens.shadow.textContent).toContain('最后译文');
  expect(lens.reads).toHaveLength(3);
});

it.each(['text', 'children'] as const)(
  'leaves changed %s native until refresh instead of chasing updates',
  async (kind) => {
    const lens = setup();
    await vi.advanceTimersByTimeAsync(300);
    lens.finish(0, '旧译文');
    await vi.advanceTimersByTimeAsync(30);
    const paragraph = document.querySelector('p');
    if (!paragraph?.firstChild) throw new Error('Missing source text');
    if (kind === 'text') paragraph.firstChild.textContent = 'Changed paragraph.';
    else paragraph.replaceChildren(document.createTextNode('Changed paragraph.'));
    await vi.advanceTimersByTimeAsync(500);
    expect(lens.reads).toHaveLength(1);
    expect(lens.shadow.querySelector('.text')).toBeNull();
    for (let i = 0; i < 3; i++) {
      paragraph.textContent = `Changed again ${i}.`;
      move(261 + i);
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(lens.reads).toHaveLength(1);
    refresh();
    await vi.advanceTimersByTimeAsync(300);
    expect(lens.reads).toHaveLength(2);
    expect(lens.reads[1]?.message.payload.texts.map((t) => t.text)).toEqual(['Changed again 2.']);
    lens.finish(1, '最新译文');
    await vi.advanceTimersByTimeAsync(30);
    expect(lens.shadow.textContent).toContain('最新译文');
  },
);

it.each([
  { repeat: true },
  { isComposing: true },
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
])('does not consume an unrelated or composing refresh chord: %j', async (init) => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  lens.finish(0, '译文');
  expect(refresh(init).defaultPrevented).toBe(false);
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(1);
});

it.each(['input', 'textarea', 'div'])(
  'refreshes from a focused %s without translating or modifying its draft',
  async (tag) => {
    const lens = setup();
    await vi.advanceTimersByTimeAsync(300);
    lens.finish(0, '译文');
    const editor = document.createElement(tag);
    if (tag === 'div') editor.setAttribute('contenteditable', 'true');
    editor.textContent = 'Private draft';
    document.body.append(editor);
    editor.focus();
    expect(refresh({}, editor).defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(lens.reads).toHaveLength(2);
    expect(JSON.stringify(lens.reads[1]?.message.payload)).not.toContain('Private draft');
    expect(editor.textContent).toBe('Private draft');
  },
);

it('uses the requested paragraph neighborhood, not the page prefix, only for an uncached request', async () => {
  const lens = setup();
  const readContext = vi.fn(() => 'Unrelated page prefix. '.repeat(400));
  Object.defineProperty(document.body, 'innerText', {
    configurable: true,
    get: readContext,
  });
  try {
    expect(readContext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    const context = lens.reads[0]?.message.payload?.context;
    expect(context).toContain('Upper paragraph.');
    expect(context).toContain('Lower paragraph.');
    expect(context).not.toContain('Unrelated page prefix');
    expect(readContext).not.toHaveBeenCalled();
    lens.finish(0, '已翻译');
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 10; i++) {
      move(260 + (i % 2));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(lens.reads).toHaveLength(1);
    expect(readContext).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(document.body, 'innerText');
  }
});

it('starts a coalesced text request while the lens keeps moving over the same paragraph', async () => {
  const lens = setup();
  for (let i = 0; i < 12; i++) {
    move(260 + (i % 2));
    await vi.advanceTimersByTimeAsync(40);
  }
  expect(lens.reads).toHaveLength(1);
  expect(lens.host.dataset.status).toBe('loading');
  lens.finish(0, '持续移动时显示译文');
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.shadow.textContent).toContain('持续移动时显示译文');
});

afterEach(() => {
  closeTranslationLens();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reuses completed text after Escape, but recomputes layout and stops all closed-session work', async () => {
  const lens = setup();
  closeTranslationLens();
  const first = lens.reopen();
  await vi.advanceTimersByTimeAsync(300);
  first.finish(0, '已完成译文');
  await vi.advanceTimersByTimeAsync(20);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  const requests = lens.send.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(lens.send.mock.calls).toHaveLength(requests);
  expect(lens.listeners.size).toBe(0);
  const p = document.querySelector<HTMLElement>('p');
  if (!p) throw new Error('Missing paragraph');
  p.dataset.y = '250';
  const reopened = lens.reopen();
  await vi.advanceTimersByTimeAsync(400);
  expect(reopened.shadow?.textContent).toContain('已完成译文');
  expect(reopened.shadow?.querySelector<HTMLElement>('.translation-group')?.style.top).toBe(
    '250px',
  );
  expect(lens.reads).toHaveLength(1);
});

it.each(['source', 'settings', 'in-flight settings', 'dispose', 'unfinished'])(
  'does not reuse invalid or unfinished text after reopening: %s',
  async (reason) => {
    const lens = setup();
    closeTranslationLens();
    const first = lens.reopen(
      'configured',
      reason === 'in-flight settings' ? 'changed' : 'configured',
    );
    await vi.advanceTimersByTimeAsync(300);
    if (reason !== 'unfinished') {
      first.finish(0, '旧译文');
      await vi.advanceTimersByTimeAsync(20);
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    if (reason === 'source') {
      const p = document.querySelector('p');
      if (!p) throw new Error('Missing paragraph');
      p.textContent = 'Changed source.';
    }
    if (reason === 'dispose') closeTranslationLens();
    const reopened = lens.reopen(reason === 'settings' ? 'changed' : 'configured');
    if (reason === 'unfinished') first.finish(0, '迟到的旧译文');
    await vi.advanceTimersByTimeAsync(400);
    expect(reopened.shadow?.textContent).not.toContain('旧译文');
    expect(lens.reads).toHaveLength(2);
  },
);

it.each(['complete', 'fail', 'cancel'] as const)(
  'correlates text previews and cleans them after %s without repainting a finished request',
  async (outcome) => {
    const lens = setup();
    await vi.advanceTimersByTimeAsync(300);
    lens.progress(0, '其他会话', { sessionId: 'other' });
    lens.progress(0, '其他请求', { requestId: 'other' });
    lens.progress(0, '未知来源', {
      result: { blocks: [{ id: 'unknown', translation: '未知来源' }] },
    });
    expect(lens.shadow.querySelectorAll('.text')).toHaveLength(0);
    lens.progress(0, '临时译文');
    expect(lens.shadow.textContent).toContain('临时译文');
    expect(lens.host.dataset.status).toBe('loading');
    await vi.advanceTimersByTimeAsync(1500);
    expect(lens.reads).toHaveLength(1);
    if (outcome === 'cancel') closeTranslationLens();
    else if (outcome === 'complete') lens.finish(0, '最终译文');
    else {
      const read = lens.reads[0];
      if (!read) throw new Error('Missing request');
      read.finish({
        version: 1,
        requestId: read.message.requestId,
        ok: false,
        error: { code: 'MODEL_INVALID_RESPONSE', message: 'Interrupted.' },
      });
    }
    await vi.advanceTimersByTimeAsync(20);
    expect(lens.shadow.textContent).not.toContain('临时译文');
    expect(lens.listeners.size).toBe(0);
    lens.progress(0, '迟到的译文');
    expect(lens.shadow.textContent).not.toContain('迟到的译文');
    if (outcome === 'cancel') {
      expect(lens.host.isConnected).toBe(false);
      lens.finish(0, '关闭后返回');
    } else {
      expect(lens.host.dataset.status).toBe(outcome === 'complete' ? 'ready' : 'error');
      expect(lens.shadow.textContent.includes('最终译文')).toBe(outcome === 'complete');
    }
  },
);

it('removes failed text previews without removing another completed batch', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  lens.finish(0, '已完成译文');
  await vi.advanceTimersByTimeAsync(30);
  window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -300, cancelable: true }));
  await vi.advanceTimersByTimeAsync(500);
  lens.progress(1, '待完成译文');
  expect(lens.shadow.textContent).toContain('待完成译文');
  const read = lens.reads[1];
  if (!read) throw new Error('Missing request');
  read.finish({
    version: 1,
    requestId: read.message.requestId,
    ok: false,
    error: { code: 'MODEL_INVALID_RESPONSE', message: 'Interrupted.' },
  });
  await vi.advanceTimersByTimeAsync(30);
  expect(lens.shadow.textContent).toContain('已完成译文');
  expect(lens.shadow.textContent).not.toContain('待完成译文');
});

it('translates newly exposed text before the old batch finishes, with no scrolling or duplicate sources', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(1);
  // Grow enough to expose the next paragraph, not the third one further down the page.
  window.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -138, cancelable: true }));
  await vi.advanceTimersByTimeAsync(500);
  expect(lens.reads).toHaveLength(2);
  expect(
    lens.reads.map(({ message }) =>
      'texts' in message.payload ? message.payload.texts.map((t) => t.text) : [],
    ),
  ).toEqual([['Upper paragraph.'], ['Lower paragraph.']]);
  lens.finish(1, '下方译文');
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.shadow.textContent).toContain('下方译文');
  expect(lens.host.dataset.status).toBe('loading');
  lens.finish(0, '上方译文');
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.shadow.textContent).toContain('上方译文');
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.reads).toHaveLength(2);
});

it('caps pending text batches and fills a freed slot without resending pending source IDs', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  move(540);
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(2);
  move(260);
  await vi.advanceTimersByTimeAsync(300);
  move(1020);
  await vi.advanceTimersByTimeAsync(1500);
  expect(lens.reads).toHaveLength(2);
  lens.finish(1, '下方译文');
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(3);
  expect(lens.reads[2]?.message.payload).toMatchObject({
    texts: [{ text: 'Last paragraph.' }],
  });
  lens.finish(2, '最后译文');
  lens.finish(0, '上方译文');
  await vi.advanceTimersByTimeAsync(500);
  expect(lens.host.dataset.status).toBe('ready');
  move(260);
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.shadow.textContent).toContain('上方译文');
  expect(lens.reads).toHaveLength(3);
});

it('keeps the lens and cached text when session verification is unavailable, without restarting model work', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  lens.finish(0, '上方译文');
  await vi.advanceTimersByTimeAsync(20);
  lens.failState();
  await vi.advanceTimersByTimeAsync(3500);
  expect(lens.host.isConnected).toBe(true);
  expect(lens.host.dataset.status).toBe('error');
  expect(lens.shadow.textContent).toContain('session/TRANSLATION_PAGE_UNAVAILABLE');
  expect(lens.shadow.textContent).toContain('上方译文');
  expect(lens.reads).toHaveLength(1);
  expect(lens.send.mock.calls.some(([m]) => m.type === 'translation.cancel')).toBe(false);
});

it('resumes discovery after the same session is verified again without resending completed text', async () => {
  const lens = setup();
  await vi.advanceTimersByTimeAsync(300);
  lens.finish(0, '上方译文');
  await vi.advanceTimersByTimeAsync(20);
  lens.failState();
  await vi.advanceTimersByTimeAsync(1500);
  move(540);
  await vi.advanceTimersByTimeAsync(300);
  expect(lens.reads).toHaveLength(1);
  expect(lens.host.dataset.status).toBe('error');
  lens.restoreState();
  await vi.advanceTimersByTimeAsync(1500);
  expect(lens.reads).toHaveLength(2);
  expect(lens.reads[1]?.message.payload.texts).toEqual([
    { id: expect.any(String), text: 'Lower paragraph.' },
  ]);
  lens.finish(1, '下方译文');
  await vi.advanceTimersByTimeAsync(20);
  expect(lens.host.dataset.status).toBe('ready');
  expect(lens.shadow.textContent).not.toContain('TRANSLATION_PAGE_UNAVAILABLE');
  move(260);
  await vi.advanceTimersByTimeAsync(1000);
  expect(lens.shadow.textContent).toContain('上方译文');
  expect(lens.reads).toHaveLength(2);
});

it('coalesces a burst of cumulative stream previews into one trailing layout pass', async () => {
  const lens = setup(
    Array.from({ length: 6 }, (_, i) => `<p data-y="${190 + i * 26}">Paragraph ${i}.</p>`).join(''),
  );
  await vi.advanceTimersByTimeAsync(300);
  const blocks = lens.reads[0]?.message.payload.texts.map(({ id }, i) => ({
    id,
    translation: `译文 ${i}`,
  }));
  if (!blocks || blocks.length !== 6) throw new Error('Missing preview fixture');
  const render = vi.spyOn(TranslationStructureLayout.prototype, 'render');
  lens.progress(0, '', { result: { blocks: blocks.slice(0, 1) } });
  expect(lens.shadow.textContent).toContain('译文 0');
  for (let i = 2; i <= blocks.length; i++)
    lens.progress(0, '', { result: { blocks: blocks.slice(0, i) } });
  expect(render).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(render).toHaveBeenCalledTimes(2);
  for (const block of blocks) expect(lens.shadow.textContent).toContain(block.translation);
  expect(lens.reads).toHaveLength(1);
  render.mockClear();
  lens.finish(0, '最终译文');
  await vi.advanceTimersByTimeAsync(200);
  expect(lens.shadow.textContent).not.toContain('译文 0');
  expect(lens.host.dataset.status).toBe('ready');
  expect(render).toHaveBeenCalledTimes(1);
});

it.each(['complete', 'fail', 'cancel'] as const)(
  'discards a queued preview after %s instead of reviving it on the next paint',
  async (outcome) => {
    const lens = setup('<p data-y="220">First paragraph.</p><p data-y="260">Second paragraph.</p>');
    await vi.advanceTimersByTimeAsync(300);
    const read = lens.reads[0];
    if (!read || read.message.payload.texts.length !== 2)
      throw new Error('Missing two-block request');
    const blocks = read.message.payload.texts.map(({ id }) => ({ id, translation: '临时译文' }));
    lens.progress(0, '', { result: { blocks: blocks.slice(0, 1) } });
    lens.progress(0, '', { result: { blocks } });
    if (outcome === 'complete') lens.finish(0, '最终译文');
    else if (outcome === 'cancel') closeTranslationLens();
    else
      read.finish({
        version: 1,
        requestId: read.message.requestId,
        ok: false,
        error: { code: 'MODEL_INVALID_RESPONSE', message: 'Interrupted.' },
      });
    await vi.advanceTimersByTimeAsync(1000);
    expect(lens.shadow.textContent).not.toContain('临时译文');
    expect(lens.listeners.size).toBe(0);
    if (outcome === 'cancel') expect(lens.host.isConnected).toBe(false);
    else {
      expect(lens.host.dataset.status).toBe(outcome === 'complete' ? 'ready' : 'error');
      expect(lens.shadow.textContent.includes('最终译文')).toBe(outcome === 'complete');
    }
  },
);
