import type { ModelProviderPort } from '../agent/model/model-provider';
import type { AppSettings, SettingsStore } from '../persistence/settings-store';
import { createTranslator, resolveLanguage } from '../shared/i18n/i18n';
import { bytesToBase64 } from '../shared/base64';
import { TranslationStateError } from './translation-state-error';
import {
  translateRegion,
  translateTexts,
  MAX_TRANSLATION_TEXT_REQUESTS,
  type TranslationTexts,
  type TranslationSelection,
  type TranslationLensOptions,
  type TranslationResult,
  type TranslationProgress,
  type TranslationImageSource,
  type TranslationImageResource,
} from './region-translation';

interface TranslationPorts {
  toggle(tabId: number, options: TranslationLensOptions): Promise<boolean>;
  getSession(tabId: number): Promise<string | null>;
  readonly provider: ModelProviderPort;
  readonly settings: Pick<SettingsStore, 'get'>;
  progress?(tabId: number, value: TranslationProgress): Promise<void>;
  readImage?(tabId: number, url: string, signal: AbortSignal): Promise<TranslationImageResource>;
}

type TranslationRequest = { id: string; abort: AbortController };

const cacheKey = (settings: AppSettings) =>
  JSON.stringify([
    settings.model,
    settings.reasoningEffort,
    resolveLanguage(settings.language, navigator.language),
  ]);

/** The page owns lens state; the worker owns only cancellable, bounded translation requests. */
export class TranslationController {
  readonly #requests = {
    text: new Map<number, Set<TranslationRequest>>(),
    pixels: new Map<number, Set<TranslationRequest>>(),
    images: new Map<number, Set<TranslationRequest>>(),
  };
  readonly #toggles = new Map<number, Promise<{ active: boolean }>>();
  constructor(readonly ports: TranslationPorts) {}

  toggle(tabId: number): Promise<{ active: boolean }> {
    const pending = this.#toggles.get(tabId);
    if (pending) return pending;
    this.cancelTab(tabId);
    const toggle = this.ports.settings
      .get()
      .then(async (settings) => {
        const t = createTranslator(resolveLanguage(settings.language, navigator.language));
        return {
          active: await this.ports.toggle(tabId, {
            sessionId: crypto.randomUUID(),
            loadingText: t('translationLoading'),
            errorText: t('translationFailed'),
            unsupportedText: t('translationUnsupported'),
            retryText: t('translationRetry'),
            cacheKey: cacheKey(settings),
          }),
        };
      })
      .finally(() => this.#toggles.delete(tabId));
    this.#toggles.set(tabId, toggle);
    return toggle;
  }

  async getState(tabId: number, expectedSessionId?: string): Promise<{ active: boolean }> {
    const sessionId = await this.ports.getSession(tabId);
    return {
      active:
        sessionId !== null && (expectedSessionId === undefined || sessionId === expectedSessionId),
    };
  }

  cancel(tabId: number, sessionId: string, close = true, kind?: 'text' | 'pixels'): void {
    for (const requests of close || !kind
      ? Object.values(this.#requests)
      : [this.#requests[kind]]) {
      const pending = requests.get(tabId);
      for (const request of pending ?? []) {
        if (request.id !== sessionId) continue;
        request.abort.abort();
        pending?.delete(request);
      }
      if (!pending?.size) requests.delete(tabId);
    }
  }

  cancelTab(tabId: number): void {
    for (const requests of Object.values(this.#requests)) {
      for (const request of requests.get(tabId) ?? []) request.abort.abort();
      requests.delete(tabId);
    }
  }

  async #authorize(tabId: number, expected: string, signal: AbortSignal) {
    const sessionId = await this.ports.getSession(tabId);
    signal.throwIfAborted();
    if (sessionId === null || sessionId !== expected)
      throw new TranslationStateError('TRANSLATION_SESSION_CLOSED');
  }

  async #capture(tabId: number, selection: TranslationSelection, signal: AbortSignal) {
    await this.#authorize(tabId, selection.sessionId, signal);
    const blob = await (await fetch(selection.imageUrl, { signal })).blob();
    signal.throwIfAborted();
    return blob;
  }

  async image(tabId: number, source: TranslationImageSource): Promise<TranslationImageResource> {
    const requests = this.#requests.images;
    const pending = requests.get(tabId) ?? new Set<TranslationRequest>();
    if (pending.size >= 8) throw new TranslationStateError('TRANSLATION_BUSY');
    const request = { id: source.sessionId, abort: new AbortController() };
    pending.add(request);
    requests.set(tabId, pending);
    const signal = AbortSignal.any([request.abort.signal, AbortSignal.timeout(10000)]);
    try {
      await this.#authorize(tabId, source.sessionId, signal);
      const result = (await this.ports.readImage?.(tabId, source.url, signal)) ?? null;
      await this.#authorize(tabId, source.sessionId, signal);
      return result;
    } finally {
      pending.delete(request);
      if (requests.get(tabId) === pending && !pending.size) requests.delete(tabId);
    }
  }

  async read(
    tabId: number,
    selection: TranslationSelection | TranslationTexts,
    requestId?: string,
  ) {
    const text = 'texts' in selection;
    const requests = this.#requests[text ? 'text' : 'pixels'];
    const pending = requests.get(tabId) ?? new Set<TranslationRequest>();
    if (text && pending.size >= MAX_TRANSLATION_TEXT_REQUESTS)
      throw new TranslationStateError('TRANSLATION_BUSY');
    if (!text) {
      for (const request of pending)
        if (request.id === selection.sessionId) {
          request.abort.abort();
          pending.delete(request);
        }
    }
    const abort = new AbortController();
    const request = { id: selection.sessionId, abort };
    pending.add(request);
    requests.set(tabId, pending);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]);
    const report =
      requestId && this.ports.progress
        ? (result: TranslationProgress['result']) => {
            signal.throwIfAborted();
            // Page delivery must not block the model or invalidate a completed response.
            void this.ports
              .progress?.(tabId, {
                version: 1,
                type: 'translation.progress',
                sessionId: selection.sessionId,
                requestId,
                result,
              })
              .catch(() => undefined);
          }
        : undefined;
    try {
      if ('texts' in selection) {
        await this.#authorize(tabId, selection.sessionId, signal);
        const settings = await this.ports.settings.get();
        const key = cacheKey(settings);
        const result = await translateTexts(
          this.ports.provider,
          selection.texts,
          settings.model,
          settings.reasoningEffort,
          resolveLanguage(settings.language, navigator.language),
          signal,
          report,
          selection.context,
        );
        return { ...result, cacheKey: key };
      }
      let blob = await this.#capture(tabId, selection, signal);
      const settings = await this.ports.settings.get();
      const key = cacheKey(settings);
      signal.throwIfAborted();
      const language = resolveLanguage(settings.language, navigator.language);
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Translation image unavailable.');
        context.drawImage(bitmap, 0, 0);
        if (selection.excluded?.length) {
          context.fillStyle = '#ffffff';
          for (const area of selection.excluded) {
            const sx = bitmap.width / selection.rect.width,
              sy = bitmap.height / selection.rect.height;
            context.fillRect(
              (area.x - selection.rect.x) * sx,
              (area.y - selection.rect.y) * sy,
              area.width * sx,
              area.height * sy,
            );
          }
          blob = await canvas.convertToBlob({ type: 'image/png' });
        }
        signal.throwIfAborted();
        const imageUrl = `data:image/png;base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`;
        const paint = (result: TranslationResult) => ({
          ...result,
          colors: result.blocks.map(({ box: [x, y] }) => {
            const [r = 255, g = 255, b = 255] = context.getImageData(
              Math.max(0, Math.floor((x * bitmap.width) / 1000) - 2),
              Math.max(0, Math.floor((y * bitmap.height) / 1000) - 2),
              1,
              1,
            ).data;
            return {
              background: `rgb(${r},${g},${b})`,
              color:
                r * 0.299 + g * 0.587 + b * 0.114 > 140
                  ? ('#172642' as const)
                  : ('#ffffff' as const),
            };
          }),
        });
        const result = await translateRegion(
          this.ports.provider,
          imageUrl,
          settings.model,
          settings.reasoningEffort,
          language,
          signal,
          report && ((result) => report(paint(result))),
          selection.context,
        );
        signal.throwIfAborted();
        return { ...paint(result), cacheKey: key };
      } finally {
        bitmap.close();
      }
    } finally {
      pending.delete(request);
      if (requests.get(tabId) === pending && !pending.size) requests.delete(tabId);
    }
  }
}
