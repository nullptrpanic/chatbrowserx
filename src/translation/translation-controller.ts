import type { ModelProviderPort } from '../agent/model/model-provider';
import type { AppSettings, SettingsStore } from '../persistence/settings-store';
import { createTranslator, resolveLanguage } from '../shared/i18n/i18n';
import { TranslationStateError } from './translation-state-error';
import {
  translateTexts,
  MAX_TRANSLATION_TEXT_REQUESTS,
  type TranslationTexts,
  type TranslationLensOptions,
  type TranslationProgress,
} from './region-translation';

interface TranslationPorts {
  toggle(tabId: number, options: TranslationLensOptions): Promise<boolean>;
  getSession(tabId: number): Promise<string | null>;
  readonly provider: ModelProviderPort;
  readonly settings: Pick<SettingsStore, 'get'>;
  progress?(tabId: number, value: TranslationProgress): Promise<void>;
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
  readonly #requests = new Map<number, Set<TranslationRequest>>();
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
            refreshText: t('translationRefreshHint'),
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

  cancel(tabId: number, sessionId: string): void {
    const pending = this.#requests.get(tabId);
    for (const request of pending ?? []) {
      if (request.id !== sessionId) continue;
      request.abort.abort();
      pending?.delete(request);
    }
    if (!pending?.size) this.#requests.delete(tabId);
  }

  cancelTab(tabId: number): void {
    for (const request of this.#requests.get(tabId) ?? []) request.abort.abort();
    this.#requests.delete(tabId);
  }

  async #authorize(tabId: number, expected: string, signal: AbortSignal) {
    const sessionId = await this.ports.getSession(tabId);
    signal.throwIfAborted();
    if (sessionId === null || sessionId !== expected)
      throw new TranslationStateError('TRANSLATION_SESSION_CLOSED');
  }

  async read(tabId: number, selection: TranslationTexts, requestId?: string) {
    const requests = this.#requests;
    const pending = requests.get(tabId) ?? new Set<TranslationRequest>();
    if (pending.size >= MAX_TRANSLATION_TEXT_REQUESTS)
      throw new TranslationStateError('TRANSLATION_BUSY');
    const abort = new AbortController();
    const request = { id: selection.sessionId, abort };
    pending.add(request);
    requests.set(tabId, pending);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]);
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
    } catch (error) {
      // Providers normalize fetch cancellation to ABORTED. Preserve our deadline so the
      // message router can distinguish a slow translation from closing/moving the lens.
      if (
        signal.aborted &&
        signal.reason instanceof DOMException &&
        signal.reason.name === 'TimeoutError'
      )
        throw signal.reason;
      throw error;
    } finally {
      pending.delete(request);
      if (requests.get(tabId) === pending && !pending.size) requests.delete(tabId);
    }
  }
}
