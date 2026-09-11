import { ChromeRuntimePort, type RuntimePort } from '../../platform/chrome/runtime-port';
import {
  translationPaintSchema,
  translationProgressSchema,
  translationSampleSchema,
  translationTextResultSchema,
  MAX_TRANSLATION_TEXT_REQUESTS,
  type TranslationLensOptions,
} from '../../translation/region-translation';
import { registerPageOverlayHost } from '../page-overlay-registry';
import {
  intersectRegions,
  subtractRegions,
  nextTranslationCapture,
  translationPatchLimit,
  type TranslationRect,
} from './translation-regions';
import { TranslationContent } from './translation-content';
import { TranslationDom } from './translation-dom';
import { TranslationImages, type TranslationImageCapture } from './translation-images';
import {
  clipTranslationPatches,
  paintTranslation,
  type TranslationPatch,
} from './translation-paint';

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
  const host = doc.createElement('div');
  host.dataset.chatbrowserxOverlay = 'translation';
  host.setAttribute('aria-label', 'Region translation');
  Object.assign(host.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    pointerEvents: 'none',
    overflow: 'hidden',
  });
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = `
    .frame { position:absolute;box-sizing:border-box;border:1.5px solid #769dea;border-radius:16px;box-shadow:0 4px 24px #21386224 }
    :host([data-status="error"]) .frame { border-color:#df5968 }
    .patch { position:absolute;inset:0 }
    .text { position:absolute;white-space:nowrap;font-family:Arial,sans-serif;line-height:1;box-sizing:content-box }
    .notice { position:absolute;box-sizing:border-box;max-width:calc(100vw - 16px);height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#45618d;background:#fffffff2;padding:4px 9px;border-radius:7px;font:13px/16px Arial;box-shadow:0 2px 10px #21386215 }
    :host([data-status="error"]) .notice { color:#b92738 }
  `;
  const sheet = doc.createElement('div');
  Object.assign(sheet.style, { position: 'absolute', inset: '0' });
  const verified = doc.createElement('div');
  Object.assign(verified.style, { position: 'absolute', inset: '0' });
  const domLayer = doc.createElement('div');
  const imageLayer = doc.createElement('div');
  sheet.append(verified, imageLayer, domLayer);
  let cache = retained.get(doc);
  if (!options.cacheKey || cache?.key !== options.cacheKey) {
    retained.delete(doc);
    cache = options.cacheKey
      ? { key: options.cacheKey, texts: new Map(), images: new Map() }
      : undefined;
    if (cache) retained.set(doc, cache);
  }
  const dom = new TranslationDom(doc, view, domLayer, cache?.texts);
  const images = new TranslationImages(cache?.images);
  let staticImages = false;
  const frame = doc.createElement('div');
  frame.className = 'frame';
  const notice = doc.createElement('div');
  notice.className = 'notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  shadow.append(style, sheet, frame, notice);
  doc.documentElement.append(host);
  const unregister = registerPageOverlayHost(host);
  let point = { x: view.innerWidth / 2, y: view.innerHeight / 2 },
    scale = 1;
  let timer = 0,
    textTimer = 0,
    textRequests = 0,
    animation = 0,
    generation = 0,
    closed = false,
    requestSequence = 0;
  let failure: string | null = null;
  const textPending = new Set<string>();
  const textPreviews = new Set<() => void>();
  type PendingRequest = {
    rect: TranslationRect;
    regions: TranslationRect[];
    cancelled: boolean;
    capture?: TranslationImageCapture;
    preview?: TranslationPatch;
    unsubscribe?: (() => void) | undefined;
  };
  let pending: PendingRequest | null = null;
  const patches: TranslationPatch[] = [];
  const content = new TranslationContent();
  let inspected: TranslationRect | null = null,
    inspectTimer = 0,
    inspecting = false;

  const maximumScale = () => Math.max(0.5, view.innerWidth / 500, view.innerHeight / 260);
  function bounds() {
    const width = Math.max(1, Math.min(view.innerWidth, 500 * scale));
    const height = Math.max(1, Math.min(view.innerHeight, 260 * scale));
    return {
      x: Math.max(0, Math.min(view.innerWidth - width, point.x - width / 2)),
      y: Math.max(0, Math.min(view.innerHeight - height, point.y - height / 2)),
      width,
      height,
    };
  }
  function draw() {
    animation = 0;
    const r = bounds();
    Object.assign(frame.style, {
      left: `${r.x}px`,
      top: `${r.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    sheet.style.clipPath = `inset(${r.y}px ${view.innerWidth - r.x - r.width}px ${view.innerHeight - r.y - r.height}px ${r.x}px round 16px)`;
    Object.assign(notice.style, {
      left: `${r.x}px`,
      top: `${r.y >= 30 ? r.y - 30 : r.y + r.height + 30 <= view.innerHeight ? r.y + r.height + 6 : Math.max(0, Math.min(r.y + 6, view.innerHeight - 24))}px`,
    });
    scheduleRead(r);
  }
  function status(value: 'waiting' | 'loading' | 'ready' | 'error') {
    if (host.dataset.status === value) return;
    host.dataset.status = value;
    notice.hidden = value === 'ready';
    notice.textContent =
      value === 'error' ? `${options.errorText} (${failure})` : options.loadingText;
    notice.title = notice.textContent;
  }
  function fail(stage: 'text' | 'pixels' | 'inspection' | 'session', error: unknown) {
    const code =
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
        ? error.code
        : 'INVALID_RESPONSE';
    if (!failure) generation++;
    failure ??= `${stage}/${code}`;
    view.clearTimeout(inspectTimer);
    inspectTimer = 0;
    // Cached screenshot text is not safe to display while pixel verification is paused.
    // Keep it for revalidation on retry, without hiding DOM text or verified static images.
    inspected = null;
    refreshLayers();
    status('error');
  }
  function cancel(close: boolean) {
    void runtime
      .send({
        version: 1,
        requestId: `${sessionId}:${++requestSequence}`,
        type: 'translation.cancel',
        payload: { sessionId, close, ...(close ? {} : { kind: 'pixels' as const }) },
      })
      .catch(() => undefined);
  }
  function covered(rect: TranslationRect) {
    return !dom.missing().length && pixelsCovered(rect);
  }
  function validateCache(result: { cacheKey?: string | undefined }) {
    // Settings may change while a request is running. Never retain mixed-configuration results.
    if (cache && result.cacheKey !== cache.key) retained.delete(doc);
  }
  function pixelsCovered(rect: TranslationRect) {
    return (
      !needsPixels() ||
      (staticImages
        ? images.covered(dom.images, rect)
        : inspected !== null &&
          subtractRegions(rect, [inspected]).length === 0 &&
          subtractRegions(rect, [...content.blocked, ...patches.flatMap((patch) => patch.regions)])
            .length === 0)
    );
  }
  function needsPixels() {
    // With no readable DOM source, retain the visual fallback (e.g. PDF or closed shadow content).
    return !dom.visible.length || dom.visual.some((r) => intersectRegions(r, bounds()));
  }
  function scheduleRead(rect: TranslationRect) {
    view.clearTimeout(timer);
    view.clearTimeout(textTimer);
    timer = 0;
    updateDom(rect);
    if (failure) return status('error');
    if (!needsPixels()) {
      verified.style.clipPath = 'inset(100%)';
    }
    if (pending && !pending.capture) {
      // Cancel only when the captures no longer overlap at all, not on every pointer movement.
      const p = pending.rect;
      if (
        rect.x >= p.x + p.width ||
        p.x >= rect.x + rect.width ||
        rect.y >= p.y + p.height ||
        p.y >= rect.y + rect.height
      )
        cancelPending();
    }
    if (pending?.capture && !images.valid(pending.capture)) cancelPending();
    if (textRequests < MAX_TRANSLATION_TEXT_REQUESTS && dom.missing(textPending).length)
      textTimer = view.setTimeout(() => {
        void readTexts();
      }, 150);
    if (!pending && !pixelsCovered(rect) && inspected && !subtractRegions(rect, [inspected]).length)
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
    request.preview?.element.remove();
    delete request.preview;
    if (request.capture) images.clearPreview(request.capture);
  }
  function redraw() {
    if (!closed && !animation) animation = view.requestAnimationFrame(draw);
  }
  function invalidate() {
    if (closed) return;
    scale = Math.min(scale, maximumScale());
    generation++;
    patches.length = 0;
    content.reset();
    inspected = null;
    staticImages = false;
    verified.replaceChildren();
    dom.invalidate();
    failure = null;
    if (pending && !pending.capture) cancelPending();
    status('waiting');
    redraw();
  }
  function updateDom(rect: TranslationRect) {
    const before = dom.visualKey;
    const invalidated = dom.area === null;
    dom.update(captureBounds(), rect);
    images.update(dom.images, imageLayer);
    if (before && before !== dom.visualKey) {
      inspected = null;
      staticImages = false;
      // Merely discovering a neighboring source does not invalidate already translated pixels.
      if (invalidated) {
        generation++;
        patches.length = 0;
        content.reset();
        verified.replaceChildren();
        if (pending && !pending.capture) cancelPending();
      }
    }
    staticImages = dom.images.length === dom.visual.length && images.ready(dom.images);
    if (staticImages) inspected = { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
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
  function refreshLayers() {
    verified.style.clipPath =
      !failure && inspected
        ? `inset(${inspected.y}px ${view.innerWidth - inspected.x - inspected.width}px ${view.innerHeight - inspected.y - inspected.height}px ${inspected.x}px)`
        : 'inset(100%)';
    clipTranslationPatches(pending?.preview ? [...patches, pending.preview] : patches);
  }
  function discardRegions(changed: TranslationRect[]) {
    for (const patch of pending?.preview ? [...patches, pending.preview] : patches) {
      const invalid = patch.painted.filter((box) =>
        changed.some((r) => intersectRegions(r, box.rect)),
      );
      invalid.forEach((box) => box.element.remove());
      patch.painted = patch.painted.filter((box) => !invalid.includes(box));
      patch.regions = patch.regions.flatMap((r) =>
        subtractRegions(r, [...changed, ...invalid.map((box) => box.rect)]),
      );
      // Bound fragmentation as well as the number of cached capture layers.
      if (patch.regions.length > 512) patch.regions = [];
    }
    if (pending && !pending.capture) {
      pending.regions = pending.regions.flatMap((r) => subtractRegions(r, changed));
      if (!pending.regions.length || pending.regions.length > 512) cancelPending();
    }
  }
  function scheduleInspection(delay = 1000) {
    if (closed || failure || inspecting || inspectTimer) return;
    inspectTimer = view.setTimeout(() => {
      inspectTimer = 0;
      void inspect();
    }, delay);
  }
  async function inspect() {
    if (closed || failure || inspecting || doc.hidden) return;
    inspecting = true;
    updateDom(bounds());
    const ticket = generation,
      capture = captureBounds();
    // Complete fixed grid cells keep fingerprint identities unchanged as the cursor moves.
    const x = Math.floor(capture.x / 64) * 64,
      y = Math.floor(capture.y / 64) * 64;
    const rect = {
      x,
      y,
      width: Math.min(view.innerWidth - x, Math.ceil((capture.x + capture.width) / 64) * 64 - x),
      height: Math.min(view.innerHeight - y, Math.ceil((capture.y + capture.height) / 64) * 64 - y),
    };
    try {
      if (!needsPixels()) {
        inspected = null;
        refreshLayers();
        scheduleRead(bounds());
        return;
      }
      const prepared =
        dom.images.length > 0 &&
        dom.images.length === dom.visual.length &&
        (await images.prepare(dom.images));
      if (closed || failure || ticket !== generation) return;
      if (prepared) {
        staticImages = true;
        images.update(dom.images, imageLayer);
        inspected = { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
        refreshLayers();
        scheduleRead(bounds());
        return;
      }
      const response = await runtime.send({
        version: 1,
        requestId: `${sessionId}:${++requestSequence}`,
        type: 'translation.inspect',
        payload: selection(rect),
      });
      if (closed || failure || ticket !== generation) return;
      if (!response.ok) throw response.error;
      const { tiles } = translationSampleSchema.parse(response.data);
      if (
        subtractRegions(
          rect,
          tiles.map((tile) => tile.rect),
        ).length
      )
        throw new Error('Incomplete inspection.');
      inspected = rect;
      discardRegions(content.sample(tiles));
      refreshLayers();
      scheduleRead(bounds());
    } catch (error) {
      if (!closed && ticket === generation) {
        fail('inspection', error);
      }
    } finally {
      inspecting = false;
      scheduleInspection();
    }
  }
  async function readTexts() {
    if (closed || failure || textRequests >= MAX_TRANSLATION_TEXT_REQUESTS || doc.hidden) return;
    const texts = dom.missing(textPending);
    if (!texts.length) return;
    texts.forEach(({ id }) => textPending.add(id));
    textRequests++;
    const requestId = `${sessionId}:${++requestSequence}`;
    const ids = new Set(texts.map((text) => text.id));
    let active = true,
      displayed = 0;
    const unsubscribe = runtime.subscribe?.((value) => {
      if (closed || !active || failure) return;
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
      dom.accept(result, true);
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
        payload: { sessionId, texts },
      });
      if (closed) return;
      if (!response.ok) throw response.error;
      updateDom(bounds());
      const result = translationTextResultSchema.parse(response.data);
      validateCache(result);
      dom.accept(result);
    } catch (error) {
      if (!closed) fail('text', error);
    } finally {
      cleanup();
      texts.forEach(({ id }) => textPending.delete(id));
      textRequests--;
      if (!closed) scheduleRead(bounds());
    }
  }
  async function read() {
    timer = 0;
    if (closed || failure || pending || doc.hidden || pixelsCovered(bounds())) return;
    const ticket = generation;
    // Keep nearby pixels ready for movement without uploading the entire page.
    let rect = captureBounds();
    if (!staticImages)
      rect = nextTranslationCapture(
        rect,
        subtractRegions(rect, [...content.blocked, ...patches.flatMap((patch) => patch.regions)]),
      );
    const area = inspected && intersectRegions(rect, inspected);
    if (!area) return;
    const request: PendingRequest = {
      rect,
      regions: subtractRegions(area, content.blocked),
      cancelled: false,
    };
    pending = request;
    status('loading');
    try {
      let imageUrl: string | undefined;
      if (staticImages) {
        const rendered = await images.render(dom.images, rect, doc);
        if (closed || ticket !== generation || request.cancelled) return;
        if (!rendered) return;
        request.capture = rendered;
        rect = rendered.rect;
        imageUrl = rendered.imageUrl;
        request.rect = rect;
        // Empty space outside the image has been examined too; it needs no model request.
      }
      const requestId = `${sessionId}:${++requestSequence}`;
      let displayed = 0;
      request.unsubscribe = runtime.subscribe?.((value) => {
        if (closed || failure || request.cancelled || (!request.capture && ticket !== generation))
          return;
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
        if (request.capture) {
          updateDom(bounds());
          images.accept(request.capture, result, true);
        } else {
          const previous = request.preview;
          request.preview = paintTranslation(verified, result, rect, request.regions);
          previous?.element.remove();
          refreshLayers();
        }
      });
      const response = await runtime.send({
        version: 1,
        requestId,
        type: 'translation.read',
        payload: {
          ...selection(rect),
          ...(imageUrl ? { imageUrl } : {}),
          excluded: request.capture
            ? []
            : [
                ...[...content.blocked, ...dom.textRects()].flatMap((r) => {
                  const clipped = intersectRegions(r, rect);
                  return clipped ? [clipped] : [];
                }),
              ].slice(0, 512),
        },
      });
      if (closed || (!request.capture && ticket !== generation) || request.cancelled) return;
      if (!response.ok) throw response.error;
      const result = translationPaintSchema.parse(response.data);
      validateCache(result);
      if (request.capture) {
        updateDom(bounds());
        if (images.accept(request.capture, result) && result.incomplete)
          fail('pixels', { code: 'INCOMPLETE_RESPONSE' });
        return;
      }
      patches.push(paintTranslation(verified, result, rect, request.regions));
      if (result.incomplete) fail('pixels', { code: 'INCOMPLETE_RESPONSE' });
      while (patches.length > translationPatchLimit(captureBounds()))
        patches.shift()?.element.remove();
      // Keep already translated pixels stable. New captures fill only previously uncovered areas.
      refreshLayers();
    } catch (error) {
      if (!closed && (request.capture || ticket === generation) && !request.cancelled)
        fail('pixels', error);
    } finally {
      clearPreview(request);
      pending = null;
      if (!closed) scheduleRead(bounds());
    }
  }
  const move = (event: PointerEvent) => {
    if (point.x === event.clientX && point.y === event.clientY) return;
    point = { x: event.clientX, y: event.clientY };
    failure = null;
    redraw();
  };
  const zoom = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const next = Math.max(0.5, Math.min(maximumScale(), scale * Math.exp(-event.deltaY * 0.005)));
    if (next === scale) return;
    scale = next;
    failure = null;
    redraw();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };
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
    view.cancelAnimationFrame(animation);
    view.removeEventListener('pointermove', move);
    view.removeEventListener('wheel', zoom);
    view.removeEventListener('keydown', key, true);
    view.removeEventListener('resize', invalidate);
    view.removeEventListener('scroll', invalidate, true);
    view.removeEventListener('pagehide', close);
    view.removeEventListener('load', changed, true);
    view.removeEventListener('transitionrun', changed, true);
    view.removeEventListener('animationstart', changed, true);
    doc.fonts?.removeEventListener('loadingdone', changed);
    mutations.disconnect();
    resize?.disconnect();
    doc.removeEventListener('visibilitychange', visibility);
    view.visualViewport?.removeEventListener('resize', invalidate);
    content.reset();
    images.close();
    unregister();
    host.remove();
    patches.length = 0;
    active.delete(doc);
    cancel(true);
  }
  view.addEventListener('pointermove', move);
  view.addEventListener('wheel', zoom, { passive: false });
  view.addEventListener('keydown', key, true);
  view.addEventListener('resize', invalidate);
  view.addEventListener('scroll', invalidate, true);
  view.addEventListener('pagehide', close);
  view.addEventListener('load', changed, true);
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
