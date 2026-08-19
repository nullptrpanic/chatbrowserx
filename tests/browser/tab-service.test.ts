import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserTabError,
  TabService,
  type BrowserTabLike,
  type ChromeTabsApi,
} from '../../src/browser/tab-service';

type UpdatedListener = (
  tabId: number,
  changeInfo: Readonly<{ status?: string }>,
  tab: BrowserTabLike,
) => void;

function tabsApi(initial: readonly BrowserTabLike[] = []): ChromeTabsApi & {
  emitUpdated(tabId: number, status: string): void;
} {
  const tabs = new Map(initial.flatMap((tab) => (tab.id === undefined ? [] : [[tab.id, tab]])));
  const listeners = new Set<UpdatedListener>();
  return {
    query: vi.fn(async () => [...tabs.values()]),
    get: vi.fn(async (tabId) => {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`Raw missing tab ${tabId}`);
      return tab;
    }),
    create: vi.fn(async ({ url, active }) => {
      const tab = { id: 91, windowId: 3, url, title: 'New tab', active, status: 'complete' };
      tabs.set(91, tab);
      return tab;
    }),
    update: vi.fn(async (tabId, changes) => {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('Raw missing tab');
      const updated = { ...tab, ...changes, status: changes.url ? 'loading' : tab.status };
      tabs.set(tabId, updated);
      return updated;
    }),
    remove: vi.fn(async (tabId) => {
      tabs.delete(tabId);
    }),
    reload: vi.fn(async () => undefined),
    onUpdated: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    emitUpdated(tabId, status) {
      const tab = { ...tabs.get(tabId), id: tabId, status };
      tabs.set(tabId, tab);
      for (const listener of listeners) listener(tabId, { status }, tab);
    },
  };
}

const HTTP_TAB: BrowserTabLike = {
  id: 7,
  windowId: 2,
  url: 'http://intranet.local/app',
  title: 'Internal application',
  active: false,
  status: 'complete',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('TabService', () => {
  it('lists bounded tab metadata and marks protected tabs uncontrollable', async () => {
    const api = tabsApi([
      HTTP_TAB,
      {
        id: 8,
        windowId: 2,
        url: 'chrome://settings',
        title: 'x'.repeat(700),
        active: true,
        status: 'complete',
      },
    ]);
    const service = new TabService(api);

    await expect(service.list()).resolves.toEqual([
      {
        tabId: 7,
        windowId: 2,
        url: 'http://intranet.local/app',
        title: 'Internal application',
        active: false,
        controllable: true,
      },
      expect.objectContaining({
        tabId: 8,
        url: 'chrome://settings',
        active: true,
        controllable: false,
        title: 'x'.repeat(500),
      }),
    ]);
  });

  it('opens, activates, and closes only explicit controllable tabs', async () => {
    const api = tabsApi([HTTP_TAB]);
    const service = new TabService(api);

    await expect(service.get(7)).resolves.toMatchObject({
      tabId: 7,
      url: 'http://intranet.local/app',
    });
    await expect(service.open('about:blank', true)).resolves.toMatchObject({ tabId: 91 });
    await expect(service.activate(7)).resolves.toMatchObject({ tabId: 7, active: true });
    await service.close(7);

    expect(api.create).toHaveBeenCalledWith({ url: 'about:blank', active: true });
    expect(api.update).toHaveBeenCalledWith(7, { active: true });
    expect(api.remove).toHaveBeenCalledWith(7);
  });

  it.each([
    'chrome://settings',
    'devtools://devtools/bundled/inspector.html',
    'file:///tmp/private.txt',
    'https://user:password@example.com/private',
    'https://chromewebstore.google.com/detail/example',
  ])('rejects protected navigation targets: %s', async (url) => {
    const api = tabsApi([HTTP_TAB]);
    const service = new TabService(api);

    await expect(service.open(url, true)).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
    await expect(service.navigate(7, url)).rejects.toBeInstanceOf(BrowserTabError);

    expect(api.create).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('navigates and resolves after the matching tab completes', async () => {
    const api = tabsApi([HTTP_TAB]);
    const service = new TabService(api, { loadTimeoutMs: 1_000 });

    const navigation = service.navigate(7, 'https://example.com/next');
    await vi.waitFor(() => expect(api.update).toHaveBeenCalledOnce());
    api.emitUpdated(88, 'complete');
    api.emitUpdated(7, 'complete');

    await expect(navigation).resolves.toMatchObject({
      tabId: 7,
      url: 'https://example.com/next',
    });
  });

  it('times out reload without leaking a raw Chrome error', async () => {
    vi.useFakeTimers();
    const api = tabsApi([HTTP_TAB]);
    const service = new TabService(api, { loadTimeoutMs: 250 });

    const reload = service.reload(7).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(251);

    await expect(reload).resolves.toMatchObject({ code: 'LOAD_TIMEOUT' });
    await expect(reload).resolves.not.toMatchObject({ message: expect.stringMatching(/Raw/) });
  });
});
