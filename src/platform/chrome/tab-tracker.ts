import type { Clock } from '../../shared/time';

export interface ChromeTrackedTabInput {
  readonly id: number;
  readonly openerTabId?: number | null;
  readonly url?: string;
  readonly title?: string;
}

export interface ChromeTabChangeInfo {
  readonly url?: string;
  readonly title?: string;
}

export type ChromeTabCreatedListener = (tab: ChromeTrackedTabInput) => void;
export type ChromeTabUpdatedListener = (
  tabId: number,
  changeInfo: ChromeTabChangeInfo,
  tab: ChromeTrackedTabInput,
) => void;
export type ChromeTabRemovedListener = (tabId: number) => void;

export interface ChromeTabTrackerApi {
  query(queryInfo: Record<string, never>): Promise<readonly ChromeTrackedTabInput[]>;
  readonly onCreated: { addListener(listener: ChromeTabCreatedListener): void };
  readonly onUpdated: { addListener(listener: ChromeTabUpdatedListener): void };
  readonly onRemoved: { addListener(listener: ChromeTabRemovedListener): void };
}

export interface TrackedTab {
  readonly id: number;
  readonly openerTabId: number | null;
  readonly url: string;
  readonly title: string;
  readonly createdAt: number | null;
  readonly updatedAt: number;
}

export interface AdoptableTabInput {
  readonly openerTabId: number;
  readonly createdAfter: number;
}

export interface TabTrackingPort {
  hasTab(tabId: number): Promise<boolean>;
  getTab(tabId: number): Promise<TrackedTab | null>;
  findAdoptableTab(input: AdoptableTabInput): Promise<TrackedTab | null>;
}

/** Normalizes the subset of Chrome tab data that task recovery is allowed to retain. */
function normalizeTab(
  tab: ChromeTrackedTabInput,
  now: number,
  createdAt: number | null,
): TrackedTab {
  return {
    id: tab.id,
    openerTabId: tab.openerTabId ?? null,
    url: tab.url ?? '',
    title: tab.title ?? '',
    createdAt,
    updatedAt: now,
  };
}

export class ChromeTabTracker implements TabTrackingPort {
  readonly #api: ChromeTabTrackerApi;
  readonly #clock: Clock;
  readonly #tabs = new Map<number, TrackedTab>();
  readonly #removedDuringInitialLoad = new Set<number>();
  #initialLoadPending = true;
  readonly ready: Promise<void>;

  /** Registers lifecycle listeners before loading pre-existing tabs to avoid missing new pages. */
  constructor(api: ChromeTabTrackerApi, clock: Clock) {
    this.#api = api;
    this.#clock = clock;
    api.onCreated.addListener((tab) => {
      const now = this.#clock.now();
      this.#removedDuringInitialLoad.delete(tab.id);
      this.#tabs.set(tab.id, normalizeTab(tab, now, now));
    });
    api.onUpdated.addListener((tabId, changeInfo, tab) => {
      this.#removedDuringInitialLoad.delete(tabId);
      const previous = this.#tabs.get(tabId);
      const normalized = normalizeTab(tab, this.#clock.now(), previous?.createdAt ?? null);
      this.#tabs.set(tabId, {
        ...normalized,
        url: changeInfo.url ?? normalized.url,
        title: changeInfo.title ?? normalized.title,
      });
    });
    api.onRemoved.addListener((tabId) => {
      if (this.#initialLoadPending) this.#removedDuringInitialLoad.add(tabId);
      this.#tabs.delete(tabId);
    });
    this.ready = this.#loadExistingTabs();
  }

  /** Reports whether the exact task-bound tab still exists. */
  async hasTab(tabId: number): Promise<boolean> {
    await this.ready;
    return this.#tabs.has(tabId);
  }

  /** Returns the exact tracked tab without consulting current-active browser state. */
  async getTab(tabId: number): Promise<TrackedTab | null> {
    await this.ready;
    return this.#tabs.get(tabId) ?? null;
  }

  /** Finds the earliest live child created strictly after one persisted action intent. */
  async findAdoptableTab(input: AdoptableTabInput): Promise<TrackedTab | null> {
    await this.ready;
    return (
      [...this.#tabs.values()]
        .filter(
          (tab) =>
            tab.openerTabId === input.openerTabId &&
            tab.createdAt !== null &&
            tab.createdAt > input.createdAfter,
        )
        .sort(
          (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0) || left.id - right.id,
        )[0] ?? null
    );
  }

  /** Loads tabs that predate tracker startup without making them eligible for action adoption. */
  async #loadExistingTabs(): Promise<void> {
    try {
      const tabs = await this.#api.query({});
      const now = this.#clock.now();
      for (const tab of tabs) {
        if (!this.#tabs.has(tab.id) && !this.#removedDuringInitialLoad.has(tab.id)) {
          this.#tabs.set(tab.id, normalizeTab(tab, now, null));
        }
      }
    } finally {
      this.#initialLoadPending = false;
      this.#removedDuringInitialLoad.clear();
    }
  }
}
