const MAX_TAB_ID = 2_147_483_647;
const MAX_LISTED_TABS = 80;
const MAX_TITLE_CHARACTERS = 500;
const MAX_LIST_URL_CHARACTERS = 1_024;
const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

export type BrowserTabErrorCode =
  | 'INVALID_TAB'
  | 'TAB_NOT_FOUND'
  | 'TAB_NOT_CONTROLLABLE'
  | 'URL_NOT_ALLOWED'
  | 'LOAD_TIMEOUT'
  | 'BROWSER_OPERATION_FAILED';

export class BrowserTabError extends Error {
  readonly code: BrowserTabErrorCode;

  constructor(code: BrowserTabErrorCode, message: string) {
    super(message);
    this.name = 'BrowserTabError';
    this.code = code;
  }
}

export interface BrowserTabLike {
  readonly id?: number;
  readonly windowId?: number;
  readonly url?: string;
  readonly pendingUrl?: string;
  readonly title?: string;
  readonly active?: boolean;
  readonly status?: string;
}

type TabUpdatedListener = (
  tabId: number,
  changeInfo: Readonly<{ status?: string }>,
  tab: BrowserTabLike,
) => void;

export interface ChromeTabsApi {
  query(queryInfo: Readonly<Record<string, never>>): Promise<readonly BrowserTabLike[]>;
  get(tabId: number): Promise<BrowserTabLike>;
  create(createProperties: {
    readonly url: string;
    readonly active: boolean;
  }): Promise<BrowserTabLike>;
  update(
    tabId: number,
    updateProperties: { readonly active?: boolean; readonly url?: string },
  ): Promise<BrowserTabLike>;
  remove(tabId: number): Promise<void>;
  reload(tabId: number): Promise<void>;
  readonly onUpdated: {
    addListener(listener: TabUpdatedListener): void;
    removeListener(listener: TabUpdatedListener): void;
  };
}

export interface BrowserTabSummary {
  readonly tabId: number;
  readonly windowId: number | null;
  readonly url: string | null;
  readonly title: string;
  readonly active: boolean;
  readonly controllable: boolean;
}

export interface BrowserTabState {
  readonly tabId: number;
  readonly url: string | null;
  readonly title: string;
  readonly active: boolean;
}

export interface BrowserTabPort {
  list(): Promise<readonly BrowserTabSummary[]>;
  get(tabId: number): Promise<BrowserTabState>;
  open(url: string, activate: boolean): Promise<BrowserTabState>;
  activate(tabId: number): Promise<BrowserTabState>;
  close(tabId: number): Promise<void>;
  navigate(tabId: number, url: string): Promise<BrowserTabState>;
  reload(tabId: number): Promise<BrowserTabState>;
}

export interface TabServiceOptions {
  readonly loadTimeoutMs?: number;
}

function bounded(value: string | undefined, maximum: number): string {
  return (value ?? '').slice(0, maximum);
}

function validTabId(tabId: number): boolean {
  return Number.isSafeInteger(tabId) && tabId >= 0 && tabId <= MAX_TAB_ID;
}

/** Allows ordinary user pages while excluding Chrome-owned and credential-bearing targets. */
export function isControllableBrowserUrl(value: string | undefined): boolean {
  if (value === undefined || value.trim() !== value || value.length === 0 || value.length > 4_096) {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'about:') return parsed.href === 'about:blank';
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return !(
      host === 'chromewebstore.google.com' ||
      (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))
    );
  } catch {
    return false;
  }
}

function tabState(tab: BrowserTabLike, fallbackUrl?: string): BrowserTabState {
  if (tab.id === undefined || !validTabId(tab.id)) {
    throw new BrowserTabError('BROWSER_OPERATION_FAILED', 'The browser returned an invalid tab.');
  }
  const url = tab.url ?? tab.pendingUrl ?? fallbackUrl ?? null;
  return {
    tabId: tab.id,
    url: url === null ? null : bounded(url, 4_096),
    title: bounded(tab.title, MAX_TITLE_CHARACTERS),
    active: tab.active === true,
  };
}

/** Performs bounded, URL-restricted tab lifecycle operations through chrome.tabs. */
export class TabService implements BrowserTabPort {
  readonly #api: ChromeTabsApi;
  readonly #loadTimeoutMs: number;

  constructor(
    api: ChromeTabsApi = chrome.tabs as unknown as ChromeTabsApi,
    options: TabServiceOptions = {},
  ) {
    const timeout = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 250 || timeout > 10_000) {
      throw new Error('Tab load timeout is invalid.');
    }
    this.#api = api;
    this.#loadTimeoutMs = timeout;
  }

  async list(): Promise<readonly BrowserTabSummary[]> {
    let tabs: readonly BrowserTabLike[];
    try {
      tabs = await this.#api.query({});
    } catch {
      throw new BrowserTabError('BROWSER_OPERATION_FAILED', 'Browser tabs could not be listed.');
    }
    return tabs
      .flatMap((tab): BrowserTabSummary[] => {
        if (tab.id === undefined || !validTabId(tab.id)) return [];
        const rawUrl = tab.url ?? tab.pendingUrl;
        return [
          {
            tabId: tab.id,
            windowId:
              tab.windowId !== undefined && Number.isSafeInteger(tab.windowId)
                ? tab.windowId
                : null,
            url: rawUrl === undefined ? null : bounded(rawUrl, MAX_LIST_URL_CHARACTERS),
            title: bounded(tab.title, MAX_TITLE_CHARACTERS),
            active: tab.active === true,
            controllable: isControllableBrowserUrl(rawUrl),
          },
        ];
      })
      .slice(0, MAX_LISTED_TABS);
  }

  /** Reads one exact controllable tab without relying on window-level active state. */
  get(tabId: number): Promise<BrowserTabState> {
    return this.#getControllable(tabId);
  }

  async open(url: string, activate: boolean): Promise<BrowserTabState> {
    this.#requireUrl(url);
    try {
      return tabState(await this.#api.create({ url, active: activate }), url);
    } catch (error) {
      if (error instanceof BrowserTabError) throw error;
      throw new BrowserTabError('BROWSER_OPERATION_FAILED', 'The browser tab could not be opened.');
    }
  }

  async activate(tabId: number): Promise<BrowserTabState> {
    await this.#getControllable(tabId);
    try {
      return tabState(await this.#api.update(tabId, { active: true }));
    } catch {
      throw new BrowserTabError(
        'BROWSER_OPERATION_FAILED',
        'The browser tab could not be activated.',
      );
    }
  }

  async close(tabId: number): Promise<void> {
    await this.#getControllable(tabId);
    try {
      await this.#api.remove(tabId);
    } catch {
      throw new BrowserTabError('BROWSER_OPERATION_FAILED', 'The browser tab could not be closed.');
    }
  }

  async navigate(tabId: number, url: string): Promise<BrowserTabState> {
    await this.#getControllable(tabId);
    this.#requireUrl(url);
    await this.#waitForLoad(tabId, async () => this.#api.update(tabId, { url }));
    return this.#getControllable(tabId, url);
  }

  async reload(tabId: number): Promise<BrowserTabState> {
    await this.#getControllable(tabId);
    await this.#waitForLoad(tabId, async () => {
      await this.#api.reload(tabId);
      return undefined;
    });
    return this.#getControllable(tabId);
  }

  #requireTabId(tabId: number): void {
    if (!validTabId(tabId)) {
      throw new BrowserTabError('INVALID_TAB', 'The browser tab ID is invalid.');
    }
  }

  #requireUrl(url: string): void {
    if (!isControllableBrowserUrl(url)) {
      throw new BrowserTabError('URL_NOT_ALLOWED', 'This browser URL cannot be controlled.');
    }
  }

  async #getControllable(tabId: number, fallbackUrl?: string): Promise<BrowserTabState> {
    this.#requireTabId(tabId);
    let tab: BrowserTabLike;
    try {
      tab = await this.#api.get(tabId);
    } catch {
      throw new BrowserTabError('TAB_NOT_FOUND', 'The browser tab does not exist.');
    }
    const state = tabState(tab, fallbackUrl);
    if (!isControllableBrowserUrl(state.url ?? undefined)) {
      throw new BrowserTabError('TAB_NOT_CONTROLLABLE', 'This browser tab cannot be controlled.');
    }
    return state;
  }

  #waitForLoad(tabId: number, action: () => Promise<BrowserTabLike | undefined>): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: BrowserTabError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#api.onUpdated.removeListener(listener);
        if (error) reject(error);
        else resolve();
      };
      const listener: TabUpdatedListener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
      };
      const timer = setTimeout(
        () => finish(new BrowserTabError('LOAD_TIMEOUT', 'The page did not become ready in time.')),
        this.#loadTimeoutMs,
      );
      this.#api.onUpdated.addListener(listener);
      void action().then(
        (tab) => {
          if (tab?.status === 'complete') finish();
        },
        () =>
          finish(
            new BrowserTabError(
              'BROWSER_OPERATION_FAILED',
              'The browser navigation could not be completed.',
            ),
          ),
      );
    });
  }
}
