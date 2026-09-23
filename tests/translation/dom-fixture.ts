import { vi } from 'vitest';

/** JSDOM cannot position mirrors. Respect their viewport position instead of returning
 * the same page-sized box for every overlay node (which falsely overlaps every source). */
export function mockTranslationGroupBox(el: Element, height: number): DOMRect | undefined {
  const group = el.closest<HTMLElement>('.translation-group');
  if (!group) return;
  return new DOMRect(
    parseFloat(group.style.left) || 0,
    parseFloat(group.style.top) || 0,
    parseFloat(group.style.width) || 0,
    parseFloat(group.style.height) || height,
  );
}

/** JSDOM has no pseudo-style engine; generated decoration is verified in Chromium E2E. */
export function mockAbsentPseudoStyles() {
  const computed = window.getComputedStyle.bind(window);
  const absent = document.createElement('span');
  absent.style.cssText = 'display:none;content:none';
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
    computed(pseudo ? absent : el),
  );
}
