import { describe, expect, it } from 'vitest';
import {
  ChromeTabTracker,
  type ChromeTabTrackerApi,
} from '../../../src/platform/chrome/tab-tracker';

class TestChromeEvent<TListener extends (...args: never[]) => void> {
  readonly listeners: TListener[] = [];

  /** Stores a listener so a test can emit the corresponding Chrome event. */
  addListener(listener: TListener): void {
    this.listeners.push(listener);
  }
}

/** Creates a deterministic tab API and mutable wall clock for tracking tests. */
function buildFixture() {
  let now = 1_000;
  const created = new TestChromeEvent<
    Parameters<ChromeTabTrackerApi['onCreated']['addListener']>[0]
  >();
  const updated = new TestChromeEvent<
    Parameters<ChromeTabTrackerApi['onUpdated']['addListener']>[0]
  >();
  const removed = new TestChromeEvent<
    Parameters<ChromeTabTrackerApi['onRemoved']['addListener']>[0]
  >();
  const api: ChromeTabTrackerApi = {
    query: async () => [{ id: 7, openerTabId: null, url: 'https://example.test/' }],
    onCreated: created,
    onUpdated: updated,
    onRemoved: removed,
  };
  const tracker = new ChromeTabTracker(api, { now: () => now });
  return {
    tracker,
    created,
    updated,
    removed,
    advance(value: number) {
      now = value;
    },
  };
}

describe('ChromeTabTracker', () => {
  it('tracks the bound tab and never substitutes an unrelated active tab', async () => {
    const fixture = buildFixture();

    await expect(fixture.tracker.hasTab(7)).resolves.toBe(true);
    await expect(fixture.tracker.hasTab(99)).resolves.toBe(false);
  });

  it('updates and removes tracked tabs from Chrome lifecycle events', async () => {
    const fixture = buildFixture();
    await fixture.tracker.ready;

    fixture.updated.listeners[0]?.(
      7,
      { url: 'https://example.test/next' },
      {
        id: 7,
        openerTabId: null,
        url: 'https://example.test/next',
      },
    );
    await expect(fixture.tracker.getTab(7)).resolves.toMatchObject({
      url: 'https://example.test/next',
    });
    fixture.removed.listeners[0]?.(7);
    await expect(fixture.tracker.hasTab(7)).resolves.toBe(false);
  });

  it('adopts only a new tab created after intent by the expected opener', async () => {
    const fixture = buildFixture();
    await fixture.tracker.ready;
    fixture.advance(1_050);
    fixture.created.listeners[0]?.({
      id: 8,
      openerTabId: 99,
      url: 'https://unrelated.test/',
    });
    fixture.advance(1_100);
    fixture.created.listeners[0]?.({
      id: 9,
      openerTabId: 7,
      url: 'https://example.test/new',
    });

    await expect(
      fixture.tracker.findAdoptableTab({ openerTabId: 7, createdAfter: 1_075 }),
    ).resolves.toMatchObject({ id: 9 });
    await expect(
      fixture.tracker.findAdoptableTab({ openerTabId: 7, createdAfter: 1_100 }),
    ).resolves.toBeNull();
  });

  it('does not resurrect a tab removed while the initial query is in flight', async () => {
    let resolveQuery: ((tabs: readonly [{ readonly id: number }]) => void) | undefined;
    const query = new Promise<readonly [{ readonly id: number }]>((resolve) => {
      resolveQuery = resolve;
    });
    const created = new TestChromeEvent<
      Parameters<ChromeTabTrackerApi['onCreated']['addListener']>[0]
    >();
    const updated = new TestChromeEvent<
      Parameters<ChromeTabTrackerApi['onUpdated']['addListener']>[0]
    >();
    const removed = new TestChromeEvent<
      Parameters<ChromeTabTrackerApi['onRemoved']['addListener']>[0]
    >();
    const tracker = new ChromeTabTracker(
      { query: async () => query, onCreated: created, onUpdated: updated, onRemoved: removed },
      { now: () => 1_000 },
    );

    removed.listeners[0]?.(7);
    resolveQuery?.([{ id: 7 }]);

    await expect(tracker.hasTab(7)).resolves.toBe(false);
  });
});
