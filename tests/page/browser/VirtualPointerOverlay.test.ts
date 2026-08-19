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
  it('removes a stale overlay left by an earlier content-script context', () => {
    const stale = document.createElement('div');
    stale.dataset.chatbrowserxOverlay = 'virtual-pointer';
    document.documentElement.append(stale);

    const pointer = mountVirtualPointer(document, window);

    expect(document.querySelectorAll('[data-chatbrowserx-overlay="virtual-pointer"]')).toHaveLength(
      1,
    );
    expect(stale.isConnected).toBe(false);

    const lateStale = document.createElement('div');
    lateStale.dataset.chatbrowserxOverlay = 'virtual-pointer';
    document.documentElement.append(lateStale);
    expect(mountVirtualPointer(document, window)).toBe(pointer);
    expect(document.querySelectorAll('[data-chatbrowserx-overlay="virtual-pointer"]')).toHaveLength(
      1,
    );
    expect(lateStale.isConnected).toBe(false);
    pointer.destroy();
  });

  it('hides after feedback and does not let an old hide deadline conceal a newer action', async () => {
    vi.useFakeTimers();
    const pointer = mountVirtualPointer(document, window);
    const first = pointer.show({ x: 100, y: 80, fromX: 10, fromY: 20, effect: 'click' });
    await vi.advanceTimersByTimeAsync(220);
    await first;
    await vi.advanceTimersByTimeAsync(100);

    const second = pointer.show({ x: 240, y: 160, fromX: 100, fromY: 80, effect: 'move' });
    await vi.advanceTimersByTimeAsync(220);
    await second;
    const cursor = document
      .querySelector<HTMLElement>('[data-chatbrowserx-overlay="virtual-pointer"]')
      ?.shadowRoot?.querySelector<SVGElement>('[data-part="cursor"]');

    await vi.advanceTimersByTimeAsync(200);
    expect(cursor?.style.opacity).toBe('1');
    await vi.advanceTimersByTimeAsync(500);
    expect(cursor?.style.opacity).toBe('0');
    pointer.destroy();
  });

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
    const cursor = host?.shadowRoot?.querySelector<SVGElement>('svg[data-part="cursor"]');
    const styles = host?.shadowRoot?.querySelector('style')?.textContent ?? '';
    expect(cursor?.getAttribute('viewBox')).toBe('0 0 20 24');
    expect(cursor?.querySelector('path')).not.toBeNull();
    expect(cursor?.style.transform).toBe('translate3d(100px, 80px, 0)');
    expect(host?.shadowRoot?.querySelector('[data-part="ripple"]')).not.toBeNull();
    expect(styles).toContain('@keyframes cbx-pointer-ripple');
    expect(styles).toContain('animation: cbx-pointer-ripple');
    expect(styles).toContain('background: transparent');
    expect(styles).not.toContain('radial-gradient');

    setPageOverlaysHidden(true);
    expect(host).toHaveStyle({ visibility: 'hidden' });
    setPageOverlaysHidden(false);
    first.destroy();
  });

  it('renders a black cursor with a white outline and blue halo', () => {
    const pointer = mountVirtualPointer(document, window);
    const host = document.querySelector<HTMLElement>(
      '[data-chatbrowserx-overlay="virtual-pointer"]',
    );
    const styles = host?.shadowRoot?.querySelector('style')?.textContent ?? '';
    const cursorShape = host?.shadowRoot?.querySelector(
      'svg[data-part="cursor"] [data-layer="fill"]',
    );

    expect(cursorShape).toHaveAttribute('fill', '#050505');
    expect(styles).toContain('drop-shadow(0 0 4px rgba(64,149,238,.74))');
    expect(styles).toContain('drop-shadow(0 0 10px rgba(80,166,244,.38))');
    pointer.destroy();
  });

  it('renders the reference cursor as a crisp white silhouette behind a black fill', () => {
    const pointer = mountVirtualPointer(document, window);
    const host = document.querySelector<HTMLElement>(
      '[data-chatbrowserx-overlay="virtual-pointer"]',
    );
    const cursor = host?.shadowRoot?.querySelector<SVGElement>('svg[data-part="cursor"]');
    const outline = cursor?.querySelector('[data-layer="outline"]');
    const fill = cursor?.querySelector('[data-layer="fill"]');

    expect(cursor?.getAttribute('viewBox')).toBe('0 0 20 24');
    expect(outline).toHaveAttribute('fill', '#ffffff');
    expect(fill).toHaveAttribute('fill', '#050505');
    expect(outline?.getAttribute('d')).not.toBe(fill?.getAttribute('d'));
    pointer.destroy();
  });

  it('does not render a trailing line for drag movement', async () => {
    vi.useFakeTimers();
    const pointer = mountVirtualPointer(document, window);
    const shown = pointer.show({ x: 300, y: 220, fromX: 30, fromY: 40, effect: 'drag' });
    await vi.runAllTimersAsync();
    await shown;

    const host = document.querySelector<HTMLElement>(
      '[data-chatbrowserx-overlay="virtual-pointer"]',
    );
    expect(host?.shadowRoot?.querySelector('[data-part="drag-trail"]')).toBeNull();
    expect(
      host?.shadowRoot?.querySelector<HTMLElement>('[data-part="cursor"]')?.style.transform,
    ).toBe('translate3d(300px, 220px, 0)');
    pointer.destroy();
  });
});
