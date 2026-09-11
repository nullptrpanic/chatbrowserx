import { PROTOCOL_VERSION, type ExtensionResponse } from '../../shared/protocol/message-types';
import type { MessageRouter } from './message-router';

export const RECOVERY_ALARM_NAME = 'task-recovery-scan';

export type BackgroundInstalledListener = () => void;
export type BackgroundStartupListener = () => void;
export type BackgroundMessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: ExtensionResponse) => void,
) => boolean | undefined;
export type BackgroundAlarmListener = (alarm: { readonly name: string }) => void;
export type BackgroundTabRemovedListener = (tabId: number) => void;
export type BackgroundTabUpdatedListener = (
  tabId: number,
  changeInfo: unknown,
  tab: unknown,
) => void;

export interface ChromeListenerRegistry<TListener> {
  addListener(listener: TListener): void;
}

export interface BackgroundChromeApi {
  readonly runtime: {
    readonly id: string;
    readonly onInstalled: ChromeListenerRegistry<BackgroundInstalledListener>;
    readonly onStartup: ChromeListenerRegistry<BackgroundStartupListener>;
    readonly onMessage: ChromeListenerRegistry<BackgroundMessageListener>;
  };
  readonly alarms: {
    create(name: string, alarmInfo: { readonly periodInMinutes: number }): void | Promise<void>;
    readonly onAlarm: ChromeListenerRegistry<BackgroundAlarmListener>;
  };
  readonly tabs: {
    readonly onRemoved: ChromeListenerRegistry<BackgroundTabRemovedListener>;
    readonly onUpdated: ChromeListenerRegistry<BackgroundTabUpdatedListener>;
  };
  readonly sidePanel: {
    setPanelBehavior(options: { readonly openPanelOnActionClick: boolean }): Promise<void>;
  };
}

export interface RecoveryTriggerPort {
  requestRecoveryScan(): Promise<void>;
  handleBrowserStartup(): Promise<void>;
}

export interface CredentialInitializationPort {
  initialize(): Promise<void>;
}

export interface RegisterBackgroundDependencies {
  readonly api: BackgroundChromeApi;
  readonly router: MessageRouter;
  readonly recovery: RecoveryTriggerPort;
  readonly credentialStore: CredentialInitializationPort;
  readonly onTabInvalidated?: (tabId: number) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

export interface BackgroundRegistration {
  readonly ready: Promise<void>;
}

/**
 * Reports a background boundary failure without logging unknown values that could contain secrets.
 */
function reportBackgroundError(): void {
  console.error('ChatBrowserX background operation failed.');
}

/**
 * Observes a background promise so listener callbacks never create unhandled rejections.
 */
function observeOperation(operation: Promise<unknown>, onError: (error: unknown) => void): void {
  void operation.catch(onError);
}

/**
 * Creates the stable fallback response used only if a supposedly total router rejects unexpectedly.
 */
function backgroundUnavailableResponse(): ExtensionResponse {
  return {
    version: PROTOCOL_VERSION,
    requestId: 'unavailable',
    ok: false,
    error: {
      code: 'BACKGROUND_UNAVAILABLE',
      message: 'Background service is unavailable.',
    },
  };
}

/** Extracts the sender tab identifier without trusting arbitrary runtime sender fields. */
function senderTabId(sender: unknown, extensionId: string): number | null {
  if (typeof sender !== 'object' || sender === null || !('tab' in sender)) return null;
  // Extension documents can also be opened as tabs; their browser-owned URL identifies the UI.
  if (
    'url' in sender &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(`chrome-extension://${extensionId}/`)
  )
    return null;
  const tab = sender.tab;
  if (typeof tab !== 'object' || tab === null || !('id' in tab)) return null;
  return typeof tab.id === 'number' && Number.isInteger(tab.id) && tab.id >= 0 ? tab.id : null;
}

/**
 * Registers all MV3 wake-up boundaries synchronously and returns asynchronous initialization state.
 */
export function registerBackground(
  dependencies: RegisterBackgroundDependencies,
): BackgroundRegistration {
  const { api, router, recovery, credentialStore } = dependencies;
  const onError = dependencies.onError ?? reportBackgroundError;

  const createRecoveryAlarm = async (): Promise<void> => {
    await api.alarms.create(RECOVERY_ALARM_NAME, { periodInMinutes: 1 });
  };

  api.runtime.onInstalled.addListener(() => {
    observeOperation(
      Promise.all([
        api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
        createRecoveryAlarm(),
      ]),
      onError,
    );
  });
  api.runtime.onStartup.addListener(() => {
    observeOperation(recovery.handleBrowserStartup(), onError);
  });
  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECOVERY_ALARM_NAME) {
      observeOperation(recovery.requestRecoveryScan(), onError);
    }
  });
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const frameId =
      typeof sender === 'object' &&
      sender !== null &&
      'frameId' in sender &&
      typeof sender.frameId === 'number'
        ? sender.frameId
        : null;
    void router(message, {
      senderTabId: senderTabId(sender, api.runtime.id),
      senderFrameId: frameId,
    })
      .then(sendResponse)
      .catch((error: unknown) => {
        onError(error);
        sendResponse(backgroundUnavailableResponse());
      });
    return true;
  });
  api.tabs.onRemoved.addListener((tabId) => {
    if (dependencies.onTabInvalidated)
      observeOperation(dependencies.onTabInvalidated(tabId), onError);
    observeOperation(recovery.requestRecoveryScan(), onError);
  });
  api.tabs.onUpdated.addListener((tabId, change) => {
    if (
      dependencies.onTabInvalidated &&
      typeof change === 'object' &&
      change !== null &&
      (('status' in change && change.status === 'loading') || 'url' in change)
    ) {
      observeOperation(dependencies.onTabInvalidated(tabId), onError);
    }
    observeOperation(recovery.requestRecoveryScan(), onError);
  });

  const ready = Promise.all([credentialStore.initialize(), createRecoveryAlarm()])
    .then(() => undefined)
    .catch((error: unknown) => {
      onError(error);
      throw error;
    });
  return { ready };
}
