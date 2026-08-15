import { describe, expect, it, vi } from 'vitest';
import {
  computeBubblePosition,
  normalizeSelectionText,
  pickSelectionRect,
  readPageSelection,
} from '../../../src/page/selection/read-selection';

describe('selected page text', () => {
  /** Requires one fixture element without weakening production selection types. */
  function element(selector: string): Element {
    const value = document.querySelector(selector);
    if (value === null) throw new Error(`Missing test element: ${selector}`);
    return value;
  }

  it('trims empty edges and caps text at 8,000 characters', () => {
    expect(normalizeSelectionText('  first\nsecond  ')).toBe('first\nsecond');
    expect(normalizeSelectionText(' x '.repeat(5_000))).toHaveLength(8_000);
    expect(normalizeSelectionText(' \n\t ')).toBeNull();
  });

  it('anchors to the first finite non-empty line rectangle', () => {
    expect(
      pickSelectionRect([
        { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        { left: 20, top: 40, right: 160, bottom: 60, width: 140, height: 20 },
        { left: 20, top: 64, right: 90, bottom: 84, width: 70, height: 20 },
      ]),
    ).toEqual({ left: 20, top: 40, right: 160, bottom: 60, width: 140, height: 20 });
  });

  it('flips below a top-edge selection and clamps inside a narrow viewport', () => {
    expect(
      computeBubblePosition(
        { left: 290, top: 4, right: 318, bottom: 24, width: 28, height: 20 },
        { width: 320, height: 480 },
        { width: 180, height: 44 },
      ),
    ).toEqual({ left: 132, top: 32, placement: 'below' });
  });

  it('rejects collapsed, password, editable, and extension-owned selections', () => {
    document.body.innerHTML = `
      <p id="plain">Normal selection</p>
      <input id="password" type="password" value="secret">
      <div id="editable" contenteditable="true">Draft</div>
      <div data-chatbrowserx-overlay="selection"><span id="owned">Owned</span></div>
    `;

    const getSelection = vi.spyOn(window, 'getSelection');
    const selectionFor = (element: Node, collapsed = false) =>
      ({
        isCollapsed: collapsed,
        rangeCount: 1,
        toString: () => ' selected ',
        getRangeAt: () => ({
          commonAncestorContainer: element,
          getClientRects: () => [
            { left: 10, top: 20, right: 110, bottom: 40, width: 100, height: 20 },
          ],
        }),
      }) as unknown as Selection;

    getSelection.mockReturnValue(selectionFor(element('#plain'), true));
    expect(readPageSelection(document, window)).toBeNull();

    for (const selector of ['#password', '#editable', '#owned']) {
      getSelection.mockReturnValue(selectionFor(element(selector)));
      expect(readPageSelection(document, window)).toBeNull();
    }

    getSelection.mockReturnValue(selectionFor(element('#plain')));
    expect(readPageSelection(document, window)).toMatchObject({
      text: 'selected',
      rect: { left: 10, top: 20, width: 100, height: 20 },
    });
  });
});
