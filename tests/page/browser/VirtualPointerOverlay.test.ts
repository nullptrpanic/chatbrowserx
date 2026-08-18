import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountVirtualPointer } from '../../../src/page/browser/mount-virtual-pointer';
import { setPageOverlaysHidden } from '../../../src/page/page-overlay-registry';

afterEach(() => {
  vi.useRealTimers();
  document
    .querySelectorAll('[data-chatbrowserx-overlay="virtual-pointer"]')
    .forEach((node) => node.remove());
});

describe('VirtualPointerOverlay', () => {
  it('mounts once, eases to the endpoint, and renders a click ripple', async () => {
    vi.useFakeTimers();
    const first = mountVirtualPointer(document, window);
    const second = mountVirtualPointer(document, window);
    expect(first).toBe(second);

    const shown = first.show({ x: 100, y: 80, fromX: 10, fromY: 20, effect: 'click' });
    await vi.runAllTimersAsync();
    await shown;

    const host = document.querySelector<HTMLElement>(
      '[data-chatbrowserx-overlay="virtual-pointer"]',
    );
    const cursor = host?.shadowRoot?.querySelector<HTMLElement>('[data-part="cursor"]');
    expect(cursor?.style.transform).toBe('translate3d(100px, 80px, 0)');
    expect(host?.shadowRoot?.querySelector('[data-part="ripple"]')).not.toBeNull();

    setPageOverlaysHidden(true);
    expect(host).toHaveStyle({ visibility: 'hidden' });
    setPageOverlaysHidden(false);
    first.destroy();
  });

  it('renders a drag trail and ends at the requested point', async () => {
    vi.useFakeTimers();
    const pointer = mountVirtualPointer(document, window);
    const shown = pointer.show({ x: 300, y: 220, fromX: 30, fromY: 40, effect: 'drag' });
    await vi.runAllTimersAsync();
    await shown;

    const host = document.querySelector<HTMLElement>(
      '[data-chatbrowserx-overlay="virtual-pointer"]',
    );
    expect(host?.shadowRoot?.querySelector('[data-part="drag-trail"]')).not.toBeNull();
    expect(
      host?.shadowRoot?.querySelector<HTMLElement>('[data-part="cursor"]')?.style.transform,
    ).toBe('translate3d(300px, 220px, 0)');
    pointer.destroy();
  });
});
