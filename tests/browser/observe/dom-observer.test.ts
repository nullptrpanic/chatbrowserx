import { describe, expect, it, vi } from 'vitest';
import { observeDocument } from '../../../src/browser/observe/dom-observer';

/**
 * Gives an element a deterministic visible rectangle in jsdom.
 */
function setRect(element: Element, left: number, top: number, width = 120, height = 32): void {
  const rect: DOMRect = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
  const clientRects = Object.assign([rect], {
    item: (index: number) => (index === 0 ? rect : null),
  }) as unknown as DOMRectList;
  vi.spyOn(element, 'getClientRects').mockReturnValue(clientRects);
}

/**
 * Creates the stable options shared by semantic observation tests.
 */
function observationOptions() {
  return {
    id: 'observation_1',
    capturedAt: 1_000,
    tabId: 7,
    url: 'https://example.test/form',
    viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
  };
}

describe('observeDocument', () => {
  it('captures semantic DOM, open shadow roots, and same-origin frames without page mutation', () => {
    document.title = 'Account form';
    document.body.innerHTML = `
      <main>
        <label for="email">Email</label>
        <input id="email" name="email" autocomplete="email" value="a@example.test" />
        <button style="display:none">Hidden</button>
        <button id=":r12:" class="generated_hash_abc123" disabled>Save</button>
        <dialog open aria-label="Preferences"><p>Dialog details</p></dialog>
        <div id="shadow-host" aria-label="Account controls"></div>
        <iframe name="profile-frame" title="Profile"></iframe>
      </main>
    `;
    const email = document.querySelector('#email');
    const hidden = document.querySelector('button');
    const save = document.querySelectorAll('button')[1];
    const dialog = document.querySelector('dialog');
    const shadowHost = document.querySelector('#shadow-host');
    const frame = document.querySelector('iframe');
    if (
      email === null ||
      hidden === null ||
      save === undefined ||
      dialog === null ||
      shadowHost === null ||
      frame === null
    ) {
      throw new Error('Test fixture failed to initialize.');
    }
    setRect(email, 20, 20);
    setRect(hidden, 20, 60);
    setRect(save, 20, 100);
    setRect(dialog, 200, 20, 300, 180);
    setRect(frame, 20, 180, 400, 220);

    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    shadowRoot.innerHTML = '<button data-testid="shadow-action">Shadow Action</button>';
    const shadowButton = shadowRoot.querySelector('button');
    if (shadowButton === null) {
      throw new Error('Shadow fixture failed to initialize.');
    }
    setRect(shadowButton, 40, 140);

    const frameDocument = frame.contentDocument;
    if (frameDocument === null) {
      throw new Error('Frame fixture failed to initialize.');
    }
    frameDocument.body.innerHTML = `
      <label for="frame-email">Frame Email</label>
      <input id="frame-email" value="frame@example.test" />
      <button name="frame-action" disabled>Frame Action</button>
    `;
    const frameInput = frameDocument.querySelector('input');
    const frameButton = frameDocument.querySelector('button');
    if (frameInput === null || frameButton === null) {
      throw new Error('Frame controls failed to initialize.');
    }
    setRect(frameInput, 10, 10);
    setRect(frameButton, 10, 10);

    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    Object.defineProperty(frameDocument, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    const observation = observeDocument(document, observationOptions());

    expect(observation).toMatchObject({
      id: 'observation_1',
      capturedAt: 1_000,
      tabId: 7,
      url: 'https://example.test/form',
      title: 'Account form',
      truncated: false,
    });
    expect(observation.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'textbox',
          name: 'Email',
          label: 'Email',
          value: 'a@example.test',
          stableAttributes: { id: 'email', name: 'email', autocomplete: 'email' },
        }),
        expect.objectContaining({
          role: 'button',
          name: 'Save',
          state: expect.objectContaining({ disabled: true }),
          stableAttributes: {},
        }),
        expect.objectContaining({ role: 'dialog', name: 'Preferences' }),
        expect.objectContaining({
          role: 'button',
          name: 'Shadow Action',
          shadowPath: [expect.objectContaining({ hostName: 'Account controls' })],
        }),
        expect.objectContaining({
          role: 'button',
          name: 'Frame Action',
          state: expect.objectContaining({ disabled: true }),
          framePath: [expect.objectContaining({ name: 'profile-frame', title: 'Profile' })],
        }),
        expect.objectContaining({
          role: 'textbox',
          name: 'Frame Email',
          label: 'Frame Email',
          value: 'frame@example.test',
          framePath: [expect.objectContaining({ name: 'profile-frame' })],
        }),
      ]),
    );
    expect(observation.elements.some((item) => item.name === 'Hidden')).toBe(false);
    expect(observation.frames).toEqual([
      expect.objectContaining({ name: 'profile-frame', title: 'Profile', accessible: true }),
    ]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('enforces hard semantic limits and reports truncation explicitly', () => {
    document.body.replaceChildren();
    for (let index = 0; index < 121; index += 1) {
      const paragraph = document.createElement('p');
      paragraph.textContent = `Region ${String(index)}`;
      setRect(paragraph, 10, index * 2);
      document.body.append(paragraph);
    }
    for (let index = 0; index < 405; index += 1) {
      const button = document.createElement('button');
      button.textContent = `Action ${String(index)}`;
      setRect(button, 10, 10);
      document.body.append(button);
    }

    const observation = observeDocument(document, observationOptions());

    expect(observation.textRegions).toHaveLength(120);
    expect(observation.elements).toHaveLength(400);
    expect(observation.truncated).toBe(true);
    expect(
      observation.textRegions.reduce((length, region) => length + region.text.length, 0),
    ).toBeLessThanOrEqual(20_000);
  });
});
