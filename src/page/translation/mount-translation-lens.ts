import { ChromeRuntimePort, type RuntimePort } from '../../platform/chrome/runtime-port';
import {
  translationPaintSchema,
  translationProgressSchema,
  translationImageResourceSchema,
  translationTextResultSchema,
  MAX_TRANSLATION_TEXT_REQUESTS,
  type TranslationLensOptions,
} from '../../translation/region-translation';
import { TranslationLensView } from './translation-lens-view';
import { intersectRegions, subtractRegions, type TranslationRect } from './translation-regions';
import { TranslationDom } from './translation-dom';
import { TranslationImages, type TranslationImageCapture } from './translation-images';
import { collectTranslationContext } from './translation-context';

const active = new WeakMap<Document, { sessionId: string; close(): void }>();
const retained = new WeakMap<
  Document,
  {
    key: string;
    texts: TranslationDom['cache'];
    images: TranslationImages['retained'];
  }
>();

export function getTranslationSession(doc: Document = document): string | null {
  return active.get(doc)?.sessionId ?? null;
}

export function closeTranslationLens(doc: Document = document): void {
  active.get(doc)?.close();
  retained.delete(doc);
}

/** The lens clips fixed, bounded translation layers; only page changes invalidate their pixels. */
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
  const { host, domLayer, imageLayer } = ui;
  const bounds = () => ui.bounds();
  let cache = retained.get(doc);
  if (!options.cacheKey || cache?.key !== options.cacheKey) {
    retained.delete(doc);
    cache = options.cacheKey
      ? { key: options.cacheKey, texts: new Map(), images: new Map() }
      : undefined;
    if (cache) retained.set(doc, cache);
  }
  const dom = new TranslationDom(doc, view, domLayer, cache?.texts);
  const images = new TranslationImages(cache?.images, async (url, signal) => {
    const reply = await runtime.send({
      version: 1,
      requestId: `${sessionId}:${++requestSequence}`,
      type: 'translation.image',
      payload: { sessionId, url },
    });
    signal.throwIfAborted();
    if (!reply.ok) return null;
    const source = translationImageResourceSchema.parse(reply.data);
    if (!source) return null;
    const bytes = Uint8Array.from(atob(source.data), (c) => c.charCodeAt(0));
    return new Response(bytes, {
      headers: { 'Content-Type': source.mimeType },
    });
  });
  let staticImages: HTMLImageElement[] = [];
  let timer = 0,
    textTimer = 0,
    textRequests = 0,
    generation = 0,
    closed = false,
    requestSequence = 0;
  const errors = new Map<string, string>();
  const textFailed = new Set<string>();
  const blockedTexts = () => new Set([...textPending, ...textFailed]);
  const visualFailed = () => errors.has('pixels') || errors.has('inspection');
  const textPending = new Set<string>();
  const textPreviews = new Set<() => void>();
  type PendingRequest = {
    rect: TranslationRect;
    cancelled: boolean;
    capture?: TranslationImageCapture;
    unsubscribe?: (() => void) | undefined;
  };
  let pending: PendingRequest | null = null;
  let inspected: TranslationRect | null = null,
    inspectTimer = 0,
    inspecting = false;

  function status(value: 'waiting' | 'loading' | 'ready' | 'error') {
    const failure =
      errors.get('session') ??
      errors.get('inspection') ??
      (!pixelsCovered(bounds()) ? errors.get('pixels') : undefined) ??
      (dom.visible.some((e) => textFailed.has(e.id)) ? errors.get('text') : undefined) ??
      (dom.visible.some((e) => dom.layoutErrors.has(e.id)) ? 'text/LAYOUT_UNAVAILABLE' : undefined);
    if (failure) return ui.status('error', failure);
    const unsupported =
      value === 'ready' &&
      (dom.unsupported.some((r) => intersectRegions(r, bounds())) ||
        dom.images.some(
          (image) =>
            !staticImages.includes(image) &&
            intersectRegions(image.getBoundingClientRect(), bounds()),
        ));
    ui.status(unsupported ? 'unsupported' : value === 'error' ? 'waiting' : value);
  }
  function fail(stage: 'text' | 'pixels' | 'inspection' | 'session', error: unknown) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : 'INVALID_RESPONSE';
    errors.set(stage, `${stage}/${code}`);
    if (stage === 'inspection') {
      inspected = null;
    }
    status('error');
  }
  ui.action.onclick = () => {
    if (closed) return;
    if (visualFailed()) {
      generation++;
      inspected = null;
    }
    errors.clear();
    textFailed.clear();
    dom.retryLayout();
    scheduleRead(bounds());
  };
  function cancel(close: boolean) {
    void runtime
      .send({
        version: 1,
        requestId: `${sessionId}:${++requestSequence}`,
        type: 'translation.cancel',
        payload: {
          sessionId,
          close,
          ...(close ? {} : { kind: 'pixels' as const }),
        },
      })
      .catch(() => undefined);
  }
  function covered(rect: TranslationRect) {
    return inspected !== null && !dom.missing().length && pixelsCovered(rect);
  }
  function validateCache(result: { cacheKey?: string | undefined }) {
    // Settings may change while a request is running. Never retain mixed-configuration results.
    if (cache && result.cacheKey !== cache.key) retained.delete(doc);
  }
  function pixelsCovered(rect: TranslationRect) {
    return staticImages.length === 0 || images.covered(staticImages, rect);
  }
  function scheduleRead(rect: TranslationRect) {
    updateDom(rect);
    if (errors.has('session')) return status('error');
    if (pending?.capture && !images.valid(pending.capture)) cancelPending();
    // Coalesce movement without postponing queued work indefinitely. Callbacks read current bounds.
    if (
      !textTimer &&
      textRequests < MAX_TRANSLATION_TEXT_REQUESTS &&
      dom.missing(blockedTexts()).length
    )
      textTimer = view.setTimeout(() => {
        textTimer = 0;
        void readTexts();
      }, 150);
    if (
      !timer &&
      !visualFailed() &&
      !pending &&
      !pixelsCovered(rect) &&
      inspected &&
      !subtractRegions(rect, [inspected]).length
    )
      timer = view.setTimeout(() => {
        void read();
      }, 800);
    if (!inspected || subtractRegions(rect, [inspected]).length) scheduleInspection(0);
    if (covered(rect)) return status('ready');
    status(textRequests || (pending && !pending.cancelled) ? 'loading' : 'waiting');
  }
  function cancelPending() {
    if (pending && !pending.cancelled) {
      pending.cancelled = true;
      clearPreview(pending);
      cancel(false);
    }
  }
  function clearPreview(request: PendingRequest) {
    request.unsubscribe?.();
    delete request.unsubscribe;
    if (request.capture) images.clearPreview(request.capture);
  }
  function redraw() {
    if (!closed) ui.redraw();
  }
  function invalidate() {
    if (closed) return;
    generation++;
    inspected = null;
    dom.invalidate();
    if (pending && !pending.capture) cancelPending();
    status('waiting');
    redraw();
  }
  function updateDom(rect: TranslationRect) {
    const before = dom.visualKey;
    dom.update(captureBounds(), rect);
    images.update(dom.images, imageLayer);
    if (before && before !== dom.visualKey) {
      inspected = null;
      generation++;
    }
    // Unsupported neighbors do not veto independently verified static sources.
    staticImages = dom.images.filter((image) => images.ready([image]));
    if (staticImages.length === dom.images.length)
      inspected = {
        x: 0,
        y: 0,
        width: view.innerWidth,
        height: view.innerHeight,
      };
  }
  function captureBounds() {
    const lens = bounds();
    const x = Math.floor(Math.max(0, lens.x - 80)),
      y = Math.floor(Math.max(0, lens.y - 80));
    return {
      x,
      y,
      width: Math.min(view.innerWidth, Math.ceil(lens.x + lens.width + 80)) - x,
      height: Math.min(view.innerHeight, Math.ceil(lens.y + lens.height + 80)) - y,
    };
  }
  function selection(rect: TranslationRect) {
    return {
      sessionId,
      rect,
      devicePixelRatio: view.devicePixelRatio,
      viewportWidth: view.innerWidth,
      viewportHeight: view.innerHeight,
    };
  }
  function scheduleInspection(delay = 0) {
    if (closed || errors.has('session') || errors.has('inspection') || inspecting || inspectTimer)
      return;
    inspectTimer = view.setTimeout(() => {
      inspectTimer = 0;
      void inspect();
    }, delay);
  }
  async function inspect() {
    if (closed || errors.has('session') || errors.has('inspection') || inspecting || doc.hidden)
      return;
    inspecting = true;
    updateDom(bounds());
    const ticket = generation;
    try {
      if (dom.images.length) await images.prepare(dom.images);
      if (closed || ticket !== generation) return;
      // An unavailable source is a bounded unsupported case, not unfinished capture work.
      inspected = { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
      scheduleRead(bounds());
    } catch (error) {
      if (!closed && ticket === generation) {
        fail('inspection', error);
      }
    } finally {
      inspecting = false;
      // Movement may invalidate an asynchronous image read after its replacement inspection
      // was coalesced away. Recheck current sources once; unchanged failures stay explicit.
      if (ticket !== generation) scheduleInspection(0);
      if (!closed)
        status(covered(bounds()) ? 'ready' : textRequests || pending ? 'loading' : 'waiting');
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
        update.data.requestId !== requestId ||
        'colors' in update.data.result
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
  async function read() {
    timer = 0;
    if (
      closed ||
      errors.has('session') ||
      visualFailed() ||
      pending ||
      doc.hidden ||
      pixelsCovered(bounds())
    )
      return;
    const ticket = generation;
    // Only verified original-image bytes are sent. There is no page-screen capture fallback.
    let rect = captureBounds();
    const area = inspected && intersectRegions(rect, inspected);
    if (!area) return;
    const request: PendingRequest = {
      rect,
      cancelled: false,
    };
    pending = request;
    status('loading');
    try {
      const rendered = await images.render(staticImages, rect, doc);
      if (closed || ticket !== generation || request.cancelled) return;
      if (!rendered) throw { code: 'IMAGE_RENDER_UNAVAILABLE' };
      request.capture = rendered;
      rect = rendered.rect;
      request.rect = rect;
      const requestId = `${sessionId}:${++requestSequence}`;
      let displayed = 0;
      request.unsubscribe = runtime.subscribe?.((value) => {
        if (closed || request.cancelled) return;
        const update = translationProgressSchema.safeParse(value);
        if (
          !update.success ||
          update.data.sessionId !== sessionId ||
          update.data.requestId !== requestId ||
          !('colors' in update.data.result)
        )
          return;
        const result = { ...update.data.result, incomplete: true };
        if (result.blocks.length <= displayed) return;
        displayed = result.blocks.length;
        updateDom(bounds());
        images.accept(rendered, result, true);
      });
      const response = await runtime.send({
        version: 1,
        requestId,
        type: 'translation.read',
        payload: {
          ...selection(rect),
          imageUrl: rendered.imageUrl,
          context: collectTranslationContext(
            doc,
            rendered.sources.map((source) => source.image),
          ),
        },
      });
      if (closed || request.cancelled) return;
      if (!response.ok) throw response.error;
      const result = translationPaintSchema.parse(response.data);
      validateCache(result);
      updateDom(bounds());
      if (images.accept(rendered, result) && result.incomplete)
        fail('pixels', { code: 'INCOMPLETE_RESPONSE' });
    } catch (error) {
      if (!closed && (request.capture || ticket === generation) && !request.cancelled)
        fail('pixels', error);
    } finally {
      clearPreview(request);
      pending = null;
      if (!closed) scheduleRead(bounds());
    }
  }
  const visibility = () => {
    if (doc.hidden) close();
  };
  const changed = (event?: Event) => {
    if (event?.type === 'load' && event.target instanceof HTMLImageElement) {
      images.invalidate(event.target);
      invalidate();
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
    if (pending) clearPreview(pending);
    for (const cleanup of textPreviews) cleanup();
    generation++;
    view.clearTimeout(timer);
    view.clearTimeout(textTimer);
    view.clearInterval(visibilityTimer);
    view.clearTimeout(inspectTimer);
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
    images.close();
    ui.close();
    active.delete(doc);
    cancel(true);
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
  scheduleInspection(0);
  return true;
}
