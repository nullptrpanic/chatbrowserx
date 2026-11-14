import { createTranslator, resolveLanguage } from '../../shared/i18n/i18n';
import {
  SELECTION_TRANSLATION_PORT,
  selectionTranslationOptionsSchema,
  selectionTranslationTextSchema,
  type SelectionTranslationOptions,
} from '../../translation/selection-translation';
import type { TranslationController } from '../../translation/translation-controller';

const menuId = 'translate-selection';

interface SelectionTranslationMenuDependencies {
  readonly contextMenus: {
    readonly create: typeof chrome.contextMenus.create;
    readonly onClicked: Pick<typeof chrome.contextMenus.onClicked, 'addListener'>;
  };
  readonly runtime: {
    readonly onInstalled: Pick<typeof chrome.runtime.onInstalled, 'addListener'>;
    readonly lastError?: typeof chrome.runtime.lastError;
  };
  readonly language: string;
  open(tabId: number, frameId: number, options: SelectionTranslationOptions): Promise<unknown>;
}

/** Registers the native gesture before the service worker's asynchronous initialization. */
export function registerSelectionTranslationMenu({
  contextMenus,
  runtime,
  language,
  open,
}: SelectionTranslationMenuDependencies): void {
  runtime.onInstalled.addListener(() => {
    const t = createTranslator(resolveLanguage('system', language));
    contextMenus.create(
      {
        id: menuId,
        title: t('translationSelection'),
        contexts: ['selection'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      () => {
        // The item can already exist after an unpacked extension reload.
        void runtime.lastError;
      },
    );
  });
  contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== menuId || tab?.id === undefined || !tab.active) return;
    const frameId = info.frameId ?? 0;
    const selection = selectionTranslationOptionsSchema.safeParse({
      url: frameId === 0 ? (info.pageUrl ?? tab.url) : info.frameUrl,
      text: info.selectionText,
    });
    if (selection.success) void open(tab.id, frameId, selection.data).catch(() => undefined);
  });
}

/** A single request stays attached to the bubble's connection for its whole lifetime. */
export function serveSelectionTranslation(
  port: chrome.runtime.Port,
  translate: TranslationController['readSelection'],
): void {
  if (port.name !== SELECTION_TRANSLATION_PORT) return;
  const sender = port.sender;
  if (
    !sender?.tab?.active ||
    sender.tab.id === undefined ||
    !sender.documentId ||
    !sender.url ||
    !/^https?:\/\//.test(sender.url)
  ) {
    port.disconnect();
    return;
  }
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
  port.onDisconnect.addListener(() => abort.abort());
  const read = (value: unknown) => {
    port.onMessage.removeListener(read);
    const selection = selectionTranslationTextSchema.safeParse(value);
    if (!selection.success) {
      port.disconnect();
      return;
    }
    void translate(selection.data, signal)
      .then((result) => {
        if (!signal.aborted) port.postMessage(result);
        else port.disconnect();
      })
      .catch(() => port.disconnect());
  };
  port.onMessage.addListener(read);
}
