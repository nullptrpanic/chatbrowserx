import { ChromeRuntimePort, type RuntimePort } from '../../platform/chrome/runtime-port';
import {
  translationProgressSchema,
  translationBackgroundResourceSchema,
  translationTextResultSchema,
  MAX_TRANSLATION_TEXT_REQUESTS,
  type TranslationLensOptions,
} from '../../translation/region-translation';
import { TranslationLensView } from './translation-lens-view';
import { intersectRegions, type TranslationRect } from './translation-regions';
import { TranslationDom } from './translation-dom';
import { TranslationBackgroundSources } from './translation-background-source';
import { collectTranslationContext } from './translation-context';

const active = new WeakMap<Document, { sessionId: string; close(): void }>();
const retained = new WeakMap<Document, { key: string; texts: TranslationDom['cache'] }>();

export function getTranslationSession(doc: Document = document): string | null {
  return active.get(doc)?.sessionId ?? null;
}

export function closeTranslationLens(doc: Document = document): void {
  active.get(doc)?.close();
  retained.delete(doc);
}

/** The lens observes DOM text only. Images and other pixel content remain native and unchanged. */
export function toggleTranslationLens(
  options: TranslationLensOptions,
  doc: Document = document,
  view: Window = window,
  runtime: RuntimePort = new ChromeRuntimePort(),
): boolean {
  const previous = active.get(doc);
  if (previous) {
    previous.close();
    return false;
  }
  if (doc.hidden) return false;
  const { sessionId } = options;
  const ui = new TranslationLensView(doc, view, options, () => scheduleRead(bounds()), close);
  const { host, domLayer } = ui;
  const bounds = () => ui.bounds();
  let cache = retained.get(doc);
  if (!options.cacheKey || cache?.key !== options.cacheKey) {
    retained.delete(doc);
    cache = options.cacheKey ? { key: options.cacheKey, texts: new Map() } : undefined;
    if (cache) retained.set(doc, cache);
  }
  let textTimer = 0,
    textRequests = 0,
    requestSequence = 0,
    closed = false,
    preparing = false;
  const errors = new Map<string, string>();
  const textFailed = new Set<string>();
  const textPending = new Set<string>();
  const textPreviews = new Set<() => void>();
  const blockedTexts = () => new Set([...textPending, ...textFailed]);
  const backgrounds = new TranslationBackgroundSources(async (url, signal) => {
    const reply = await runtime.send({
      version: 1,
      requestId: `${sessionId}:${++requestSequence}`,
      type: 'translation.background',
      payload: { sessionId, url },
    });
    signal.throwIfAborted();
    if (!reply.ok) return null;
    const source = translationBackgroundResourceSchema.parse(reply.data);
    if (!source) return null;
    return new Response(
      Uint8Array.from(atob(source.data), (c) => c.charCodeAt(0)),
      {
        headers: { 'Content-Type': source.mimeType },
      },
    );
  });
  const dom = new TranslationDom(doc, view, domLayer, cache?.texts, (image) =>
    backgrounds.ready(image),
  );

  function status(value: 'waiting' | 'loading' | 'ready' | 'error') {
    const failure =
      errors.get('session') ??
      (dom.visible.some((e) => textFailed.has(e.id)) ? errors.get('text') : undefined) ??
      (dom.visible.some((e) => dom.layoutErrors.has(e.id)) ? 'text/LAYOUT_UNAVAILABLE' : undefined);
    if (failure) return ui.status('error', failure);
    const unsupported =
      value === 'ready' &&
      (dom.unsupported.some((r) => intersectRegions(r, bounds())) ||
        dom.visible.some(
          (e) =>
            dom.layoutUnsupported.has(e.id) && e.lines.some((r) => intersectRegions(r, bounds())),
        ));
    ui.status(unsupported ? 'unsupported' : value === 'error' ? 'waiting' : value);
  }
  function fail(stage: 'text' | 'session', error: unknown) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : 'INVALID_RESPONSE';
    errors.set(stage, `${stage}/${code}`);
    status('error');
  }
  ui.action.onclick = () => {
    if (closed) return;
    errors.clear();
    textFailed.clear();
    dom.retryLayout();
    scheduleRead(bounds());
  };
  function cancel() {
    void runtime
      .send({
        version: 1,
        requestId: `${sessionId}:${++requestSequence}`,
        type: 'translation.cancel',
        payload: { sessionId },
      })
      .catch(() => undefined);
  }
  function validateCache(result: { cacheKey?: string | undefined }) {
    // Settings may change while a request is running. Never retain mixed-configuration results.
    if (cache && result.cacheKey !== cache.key) retained.delete(doc);
  }
  function scheduleRead(rect: TranslationRect) {
    if (closed) return;
    updateDom(rect);
    if (errors.has('session')) return status('error');
    if (
      !textTimer &&
      textRequests < MAX_TRANSLATION_TEXT_REQUESTS &&
      dom.missing(blockedTexts()).length
    )
      textTimer = view.setTimeout(() => {
        textTimer = 0;
        void readTexts();
      }, 150);
    if (!dom.missing().length && !preparing) return status('ready');
    status(textRequests || preparing ? 'loading' : 'waiting');
  }
  function redraw() {
    if (!closed) ui.redraw();
  }
  function invalidate() {
    if (closed) return;
    dom.invalidate();
    redraw();
  }
  function updateDom(rect: TranslationRect) {
    const x = Math.max(0, rect.x - 80),
      y = Math.max(0, rect.y - 80);
    dom.update(
      {
        x,
        y,
        width: Math.min(view.innerWidth, rect.x + rect.width + 80) - x,
        height: Math.min(view.innerHeight, rect.y + rect.height + 80) - y,
      },
      rect,
    );
    // Restoring a photo under native DOM captions is not image translation. Plain images
    // never enter this path and unavailable backgrounds cannot trigger a model/capture fallback.
    const sources = dom.backgroundSources();
    if (!preparing && sources.some((image) => backgrounds.needsPreparation(image))) {
      preparing = true;
      void backgrounds.prepare(sources).finally(() => {
        preparing = false;
        if (closed) return;
        dom.invalidate();
        scheduleRead(bounds());
      });
    }
  }
  async function readTexts() {
    if (
      closed ||
      errors.has('session') ||
      textRequests >= MAX_TRANSLATION_TEXT_REQUESTS ||
      doc.hidden
    )
      return;
    const texts = dom.missing(blockedTexts());
    if (!texts.length) return;
    texts.forEach(({ id }) => textPending.add(id));
    textRequests++;
    const requestId = `${sessionId}:${++requestSequence}`;
    const ids = new Set(texts.map((text) => text.id));
    let active = true,
      displayed = 0;
    const unsubscribe = runtime.subscribe?.((value) => {
      if (closed || !active) return;
      const update = translationProgressSchema.safeParse(value);
      if (
        !update.success ||
        update.data.sessionId !== sessionId ||
        update.data.requestId !== requestId
      )
        return;
      const result = update.data.result;
      if (
        result.blocks.length <= displayed ||
        result.blocks.some((block) => !ids.has(block.id)) ||
        new Set(result.blocks.map((block) => block.id)).size !== result.blocks.length
      )
        return;
      displayed = result.blocks.length;
      updateDom(bounds());
      const failed = dom.accept(result, true);
      if (failed.length) {
        failed.forEach((id) => textFailed.add(id));
        fail('text', { code: 'LAYOUT_UNAVAILABLE' });
      }
    });
    const cleanup = () => {
      active = false;
      unsubscribe?.();
      dom.clearPreview(ids);
      textPreviews.delete(cleanup);
    };
    textPreviews.add(cleanup);
    try {
      scheduleRead(bounds());
      const response = await runtime.send({
        version: 1,
        requestId,
        type: 'translation.read',
        payload: {
          sessionId,
          texts,
          context: collectTranslationContext(
            doc,
            dom.visible
              .filter((entry) => ids.has(entry.id))
              .map((entry) => entry.nodes[0] ?? entry.owner),
          ),
        },
      });
      if (closed) return;
      if (!response.ok) throw response.error;
      updateDom(bounds());
      const result = translationTextResultSchema.parse(response.data);
      validateCache(result);
      const failed = dom.accept(result);
      if (failed.length) {
        failed.forEach((id) => textFailed.add(id));
        fail('text', { code: 'LAYOUT_UNAVAILABLE' });
      }
    } catch (error) {
      if (!closed) {
        ids.forEach((id) => textFailed.add(id));
        fail('text', error);
      }
    } finally {
      cleanup();
      texts.forEach(({ id }) => textPending.delete(id));
      textRequests--;
      if (!closed) scheduleRead(bounds());
    }
  }
  const visibility = () => {
    if (doc.hidden) close();
  };
  const changed = (event?: Event) => {
    if (event?.type === 'load' && event.target instanceof HTMLImageElement) {
      backgrounds.invalidate(event.target);
    }
    dom.invalidate();
    redraw();
  };
  const mutations = new MutationObserver((records) => {
    if (records.some((r) => r.target !== host && !host.contains(r.target))) changed();
  });
  mutations.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => changed());
  resize?.observe(doc.documentElement);
  // Browser tools can emulate focus, which makes document.hidden unreliable. Verify the real
  // active tab while the lens exists; no model call or durable state is involved in this probe.
  let checking = false;
  const visibilityTimer = view.setInterval(() => {
    if (checking || closed) return;
    checking = true;
    void runtime
      .send({
        version: 1,
        requestId: `${sessionId}:${++requestSequence}`,
        type: 'translation.getState',
        payload: { sessionId },
      })
      .then((response) => {
        if (closed) return;
        if (!response.ok) return fail('session', response.error);
        const data = response.data;
        if (!data || typeof data !== 'object' || !('active' in data) || data.active !== true)
          close();
      })
      .catch((error) => {
        if (!closed) fail('session', error);
      })
      .finally(() => {
        checking = false;
      });
  }, 1000);
  function close() {
    if (closed) return;
    closed = true;
    for (const cleanup of textPreviews) cleanup();
    view.clearTimeout(textTimer);
    view.clearInterval(visibilityTimer);
    view.removeEventListener('resize', invalidate);
    view.removeEventListener('scroll', invalidate, true);
    view.removeEventListener('pagehide', close);
    doc.removeEventListener('load', changed, true);
    view.removeEventListener('transitionrun', changed, true);
    view.removeEventListener('animationstart', changed, true);
    doc.fonts?.removeEventListener('loadingdone', changed);
    mutations.disconnect();
    resize?.disconnect();
    doc.removeEventListener('visibilitychange', visibility);
    view.visualViewport?.removeEventListener('resize', invalidate);
    backgrounds.close();
    ui.close();
    active.delete(doc);
    cancel();
  }
  view.addEventListener('resize', invalidate);
  view.addEventListener('scroll', invalidate, true);
  view.addEventListener('pagehide', close);
  doc.addEventListener('load', changed, true);
  view.addEventListener('transitionrun', changed, true);
  view.addEventListener('animationstart', changed, true);
  doc.fonts?.addEventListener('loadingdone', changed);
  doc.addEventListener('visibilitychange', visibility);
  view.visualViewport?.addEventListener('resize', invalidate);
  active.set(doc, { sessionId, close });
  // Acknowledge the session before a large page's layout / source scan can delay the reply.
  redraw();
  return true;
}
