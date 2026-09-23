import { ChromeRuntimePort, type RuntimePort } from '../../platform/chrome/runtime-port';
import {
  translationProgressSchema,
  translationTextResultSchema,
  TranslationResponseError,
  MAX_TRANSLATION_TEXT_REQUESTS,
  type TranslationLensOptions,
  type TranslationTextResult,
} from '../../translation/region-translation';
import { TranslationLensView } from './translation-lens-view';
import { intersectRegions, type TranslationRect } from './translation-regions';
import { TranslationDom } from './translation-dom';
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
  const ui = new TranslationLensView(
    doc,
    view,
    options,
    () => scheduleRead(bounds()),
    close,
    () => {
      void refresh();
    },
  );
  const { host, domLayer } = ui;
  const bounds = () => ui.bounds();
  let cache = retained.get(doc);
  if (!options.cacheKey || cache?.key !== options.cacheKey) {
    retained.delete(doc);
    cache = options.cacheKey ? { key: options.cacheKey, texts: new Map() } : undefined;
    if (cache) retained.set(doc, cache);
  }
  let textTimer = 0,
    scrollTimer = 0,
    textRequests = 0,
    requestSequence = 0,
    generation = 0,
    refreshing = false,
    closed = false;
  const errors = new Map<string, string>();
  const textFailed = new Set<string>();
  const textPending = new Set<string>();
  const textPreviews = new Set<() => void>();
  const blockedTexts = () => new Set([...textPending, ...textFailed]);
  const dom = new TranslationDom(doc, view, domLayer, cache?.texts);

  function status(value: 'waiting' | 'loading' | 'ready' | 'error') {
    const coverage = JSON.stringify(dom.report(textPending, textFailed));
    if (domLayer.dataset.translationCoverage !== coverage)
      domLayer.dataset.translationCoverage = coverage;
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
    // An invalid/failed stream must not leave its preview visible behind an error state.
    // Error cleanup takes precedence over deferring reflow during a gesture.
    if (scrollTimer) {
      settleScroll();
      updateDom(bounds());
    }
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
    void refresh(true);
  };
  function cancel() {
    return runtime.send({
      version: 1,
      requestId: `${sessionId}:${++requestSequence}`,
      type: 'translation.cancel',
      payload: { sessionId },
    });
  }
  async function refresh(retryOnly = false) {
    if (closed || refreshing) return;
    refreshing = true;
    const retryIds = retryOnly ? new Set([...textFailed, ...dom.layoutErrors]) : undefined;
    ++generation;
    view.clearTimeout(textTimer);
    textTimer = 0;
    for (const cleanup of textPreviews) cleanup();
    textPending.clear();
    textFailed.clear();
    textRequests = 0;
    errors.clear();
    settleScroll();
    updateDom(bounds());
    dom.refresh(bounds(), retryIds);
    status('loading');
    try {
      // Await cancellation before sending another batch with this session ID.
      const reply = await cancel();
      if (!reply.ok) throw reply.error;
    } catch (error) {
      if (!closed) fail('session', error);
    } finally {
      refreshing = false;
      if (!closed) scheduleRead(bounds());
    }
  }
  function validateCache(result: { cacheKey?: string | undefined }) {
    // Settings may change while a request is running. Never retain mixed-configuration results.
    if (cache && result.cacheKey !== cache.key) retained.delete(doc);
  }
  function scheduleRead(rect: TranslationRect) {
    if (closed || scrollTimer || refreshing) return;
    updateDom(rect);
    if (errors.has('session')) return status('error');
    if (
      !textTimer &&
      (dom.needsReconcile ||
        (textRequests < MAX_TRANSLATION_TEXT_REQUESTS && dom.missing(blockedTexts()).length))
    )
      textTimer = view.setTimeout(() => {
        textTimer = 0;
        if (dom.needsReconcile) scheduleRead(bounds());
        else void readTexts();
      }, 150);
    if (!dom.missing().length && !dom.needsReconcile) return status('ready');
    status(textRequests ? 'loading' : 'waiting');
  }
  function redraw() {
    if (!closed) ui.redraw();
  }
  function settleScroll() {
    view.clearTimeout(scrollTimer);
    scrollTimer = 0;
    dom.settle();
  }
  function invalidate(event?: Event) {
    if (closed) return;
    if (
      event instanceof WheelEvent &&
      (!event.isTrusted || event.ctrlKey || event.metaKey || (!event.deltaX && !event.deltaY))
    )
      return;
    if (event?.type === 'scroll' || event?.type === 'wheel') {
      // Synchronize before the browser paints, not after the next frame's source scan.
      // Capture wheel intent before custom scrollers move their content via CSS. Those
      // gestures need the same lifecycle even when no native scroll event is dispatched.
      dom.scroll();
      view.clearTimeout(scrollTimer);
      scrollTimer = view.setTimeout(() => {
        settleScroll();
        scheduleRead(bounds());
      }, 100);
      return;
    }
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
  }
  async function readTexts() {
    if (
      closed ||
      refreshing ||
      scrollTimer ||
      errors.has('session') ||
      textRequests >= MAX_TRANSLATION_TEXT_REQUESTS ||
      doc.hidden
    )
      return;
    const texts = dom.missing(blockedTexts());
    if (!texts.length) return;
    texts.forEach(({ id }) => textPending.add(id));
    textRequests++;
    const requestGeneration = generation;
    const requestId = `${sessionId}:${++requestSequence}`;
    const ids = new Set(texts.map((text) => text.id));
    let active = true,
      displayed = 0,
      previewTimer = 0;
    let preview: TranslationTextResult | undefined;
    const paintPreview = () => {
      if (closed || !active || !preview) return;
      const result = preview;
      preview = undefined;
      updateDom(bounds());
      const failed = dom.accept(result, true);
      if (failed.length) {
        failed.forEach((id) => textFailed.add(id));
        fail('text', { code: 'LAYOUT_UNAVAILABLE' });
      }
      // A cumulative stream can deliver many rows before the page can answer messages.
      // Keep the first preview immediate, then paint only the latest validated snapshot.
      previewTimer = view.setTimeout(() => {
        previewTimer = 0;
        paintPreview();
      }, 100);
    };
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
      preview = result;
      if (!previewTimer) paintPreview();
    });
    const cleanup = () => {
      if (!active) return;
      active = false;
      view.clearTimeout(previewTimer);
      preview = undefined;
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
      if (closed || requestGeneration !== generation) return;
      if (!response.ok) throw response.error;
      updateDom(bounds());
      const result = translationTextResultSchema.parse(response.data);
      const returned = new Set(result.blocks.map((block) => block.id));
      if (returned.size !== result.blocks.length || result.blocks.some((b) => !ids.has(b.id)))
        throw new TranslationResponseError();
      validateCache(result);
      const failed = dom.accept(result);
      if (failed.length) {
        failed.forEach((id) => textFailed.add(id));
        fail('text', { code: 'LAYOUT_UNAVAILABLE' });
      }
      const missing = [...ids].filter((id) => !returned.has(id));
      if (missing.length) {
        missing.forEach((id) => textFailed.add(id));
        fail('text', { code: 'TRANSLATION_RESPONSE_INVALID' });
      }
    } catch (error) {
      if (!closed && requestGeneration === generation) {
        ids.forEach((id) => textFailed.add(id));
        fail('text', error);
      }
    } finally {
      cleanup();
      if (requestGeneration === generation) {
        texts.forEach(({ id }) => textPending.delete(id));
        textRequests--;
        if (!closed) scheduleRead(bounds());
      }
    }
  }
  const visibility = () => {
    if (doc.hidden) close();
  };
  const changed = (event?: Event) => {
    dom.invalidate(event?.target instanceof Node ? [event.target] : undefined);
    redraw();
  };
  const motion = (event: Event) => {
    if (event.target instanceof Element && dom.motion(event.target)) redraw();
  };
  const animationEvents = [
    'transitionrun',
    'transitionend',
    'transitioncancel',
    'animationstart',
    'animationend',
    'animationcancel',
  ] as const;
  const mutations = new MutationObserver((records) => {
    const source = records.filter((r) => r.target !== host && !host.contains(r.target));
    if (source.length && dom.mutate(source)) redraw();
  });
  mutations.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
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
          return close();
        // The background has reverified this exact session, not merely a live tab.
        // A transient lost reply must not permanently stop discovery or erase cached text.
        if (errors.delete('session')) scheduleRead(bounds());
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
    view.clearTimeout(scrollTimer);
    view.clearInterval(visibilityTimer);
    view.removeEventListener('resize', invalidate);
    view.removeEventListener('scroll', invalidate, true);
    view.removeEventListener('wheel', invalidate, true);
    view.removeEventListener('pagehide', close);
    doc.removeEventListener('load', changed, true);
    for (const event of animationEvents) view.removeEventListener(event, motion, true);
    doc.fonts?.removeEventListener('loadingdone', changed);
    mutations.disconnect();
    resize?.disconnect();
    doc.removeEventListener('visibilitychange', visibility);
    view.visualViewport?.removeEventListener('resize', invalidate);
    ui.close();
    active.delete(doc);
    void cancel().catch(() => undefined);
  }
  view.addEventListener('resize', invalidate);
  view.addEventListener('scroll', invalidate, true);
  view.addEventListener('wheel', invalidate, { capture: true, passive: true });
  view.addEventListener('pagehide', close);
  doc.addEventListener('load', changed, true);
  for (const event of animationEvents) view.addEventListener(event, motion, true);
  doc.fonts?.addEventListener('loadingdone', changed);
  doc.addEventListener('visibilitychange', visibility);
  view.visualViewport?.addEventListener('resize', invalidate);
  active.set(doc, { sessionId, close });
  // Acknowledge the session before a large page's layout / source scan can delay the reply.
  redraw();
  return true;
}
