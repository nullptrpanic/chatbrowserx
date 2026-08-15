import { describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_ALARM_NAME,
  registerBackground,
  type BackgroundChromeApi,
} from '../../../src/platform/chrome/register-background';
import type { ExtensionResponse } from '../../../src/shared/protocol/message-types';

class TestChromeEvent<TListener> {
  readonly listeners: TListener[] = [];

  /**
   * Captures a Chrome listener so tests can invoke the registered boundary explicitly.
   */
  addListener(listener: TListener): void {
    this.listeners.push(listener);
  }
}

/**
 * Creates an inspectable subset of the Chrome APIs used by background registration.
 */
function buildChromeApi() {
  type InstalledListener = Parameters<
    BackgroundChromeApi['runtime']['onInstalled']['addListener']
  >[0];
  type StartupListener = Parameters<BackgroundChromeApi['runtime']['onStartup']['addListener']>[0];
  type MessageListener = Parameters<BackgroundChromeApi['runtime']['onMessage']['addListener']>[0];
  type AlarmListener = Parameters<BackgroundChromeApi['alarms']['onAlarm']['addListener']>[0];
  type RemovedListener = Parameters<BackgroundChromeApi['tabs']['onRemoved']['addListener']>[0];
  type UpdatedListener = Parameters<BackgroundChromeApi['tabs']['onUpdated']['addListener']>[0];

  const events = {
    installed: new TestChromeEvent<InstalledListener>(),
    startup: new TestChromeEvent<StartupListener>(),
    message: new TestChromeEvent<MessageListener>(),
    alarm: new TestChromeEvent<AlarmListener>(),
    removed: new TestChromeEvent<RemovedListener>(),
    updated: new TestChromeEvent<UpdatedListener>(),
  };
  const createAlarm = vi.fn();
  const setPanelBehavior = vi.fn(async () => undefined);
  const api: BackgroundChromeApi = {
    runtime: {
      onInstalled: events.installed,
      onStartup: events.startup,
      onMessage: events.message,
    },
    alarms: { create: createAlarm, onAlarm: events.alarm },
    tabs: { onRemoved: events.removed, onUpdated: events.updated },
    sidePanel: { setPanelBehavior },
  };

  return { api, events, createAlarm, setPanelBehavior };
}

describe('registerBackground', () => {
  it('registers recovery triggers, initializes credentials, and routes async messages', async () => {
    const chromeApi = buildChromeApi();
    const requestRecoveryScan = vi.fn(async () => undefined);
    const handleBrowserStartup = vi.fn(async () => undefined);
    const initialize = vi.fn(async () => undefined);
    const routerResponse: ExtensionResponse = {
      version: 1,
      requestId: 'req_1',
      ok: true,
      data: { connected: true },
    };
    const router = vi.fn(async () => routerResponse);
    const onError = vi.fn();

    const registration = registerBackground({
      api: chromeApi.api,
      router,
      recovery: { requestRecoveryScan, handleBrowserStartup },
      credentialStore: { initialize },
      onError,
    });
    await registration.ready;

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(chromeApi.createAlarm).toHaveBeenCalledWith(RECOVERY_ALARM_NAME, {
      periodInMinutes: 1,
    });
    expect(chromeApi.events.installed.listeners).toHaveLength(1);
    expect(chromeApi.events.startup.listeners).toHaveLength(1);
    expect(chromeApi.events.message.listeners).toHaveLength(1);
    expect(chromeApi.events.alarm.listeners).toHaveLength(1);
    expect(chromeApi.events.removed.listeners).toHaveLength(1);
    expect(chromeApi.events.updated.listeners).toHaveLength(1);

    chromeApi.events.startup.listeners[0]?.();
    chromeApi.events.alarm.listeners[0]?.({ name: RECOVERY_ALARM_NAME });
    chromeApi.events.alarm.listeners[0]?.({ name: 'unrelated' });
    chromeApi.events.removed.listeners[0]?.(7);
    chromeApi.events.updated.listeners[0]?.(7, {}, {});
    const sendResponse = vi.fn();
    const keepChannelOpen = chromeApi.events.message.listeners[0]?.(
      { type: 'system.ping' },
      { tab: { id: 7 } },
      sendResponse,
    );
    await vi.waitFor(() => {
      expect(handleBrowserStartup).toHaveBeenCalledTimes(1);
      expect(requestRecoveryScan).toHaveBeenCalledTimes(3);
      expect(sendResponse).toHaveBeenCalledWith(routerResponse);
    });

    expect(keepChannelOpen).toBe(true);
    expect(router).toHaveBeenCalledWith({ type: 'system.ping' }, { senderTabId: 7 });
    expect(onError).not.toHaveBeenCalled();
  });

  it('configures toolbar Side Panel behavior after installation', async () => {
    const chromeApi = buildChromeApi();
    const registration = registerBackground({
      api: chromeApi.api,
      router: vi.fn(async () => ({
        version: 1 as const,
        requestId: 'req',
        ok: true as const,
        data: {},
      })),
      recovery: {
        requestRecoveryScan: vi.fn(async () => undefined),
        handleBrowserStartup: vi.fn(async () => undefined),
      },
      credentialStore: { initialize: vi.fn(async () => undefined) },
      onError: vi.fn(),
    });
    await registration.ready;

    chromeApi.events.installed.listeners[0]?.();
    await vi.waitFor(() => {
      expect(chromeApi.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    });
  });
});
