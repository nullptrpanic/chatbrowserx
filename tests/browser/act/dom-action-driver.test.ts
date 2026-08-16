import { describe, expect, it, vi } from 'vitest';
import type { BrowserActionRequest } from '../../../src/browser/contracts/action';
import type { ElementTarget } from '../../../src/browser/contracts/target';
import { createElementTarget } from '../../../src/browser/contracts/target';
import { ChromeDomActionPort, DomActionDriver } from '../../../src/browser/act/dom-action-driver';
import { observeDocument } from '../../../src/browser/observe/dom-observer';
import { executeDomAction } from '../../../src/page/dom-action-handler';
import type { PageActionFeedback } from '../../../src/shared/protocol/message-types';

/** Gives an element a deterministic visible box in jsdom. */
function setRect(element: Element, x: number, y: number, width = 120, height = 32): void {
  const rect = {
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(element, 'getClientRects').mockReturnValue(
    Object.assign([rect], {
      item: (index: number) => (index === 0 ? rect : null),
    }) as unknown as DOMRectList,
  );
}

/** Finds a current semantic element and converts it to the durable action target shape. */
function targetFor(nameOrId: string): ElementTarget {
  const observation = observeDocument(document, {
    id: 'observation_action',
    capturedAt: 1_000,
    tabId: 7,
    url: 'https://example.test/form',
    viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
  });
  const element = observation.elements.find(
    (candidate) => candidate.name === nameOrId || candidate.stableAttributes.id === nameOrId,
  );
  if (element === undefined) throw new Error(`Missing observed target: ${nameOrId}`);
  return createElementTarget(element);
}

/** Creates a DOM driver that executes through the real page action handler. */
function createDriver(): DomActionDriver {
  let now = 1_000;
  return new DomActionDriver({
    execute: (request) =>
      executeDomAction(document, request, {
        clock: { now: () => ++now },
        window,
      }),
  });
}

describe('DomActionDriver', () => {
  it('shows click feedback at the live target center', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector<HTMLButtonElement>('button');
    if (button === null) throw new Error('Click fixture failed to initialize.');
    setRect(button, 20, 40, 120, 32);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const feedback: PageActionFeedback[] = [];

    await executeDomAction(
      document,
      {
        actionId: 'click_feedback',
        tabId: 7,
        type: 'click',
        target: targetFor('Save'),
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      {
        clock: { now: () => 1_000 },
        window,
        feedback: { show: (value) => feedback.push(value) },
      },
    );

    expect(feedback).toEqual([{ kind: 'click', x: 80, y: 56 }]);
  });

  it('shows move feedback for hover without adding feedback to keyboard actions', async () => {
    document.body.innerHTML = '<button>Hover me</button><input aria-label="Keyboard" />';
    const button = document.querySelector<HTMLButtonElement>('button');
    const input = document.querySelector<HTMLInputElement>('input');
    if (button === null || input === null) throw new Error('Hover fixture failed to initialize.');
    setRect(button, 10, 20, 80, 40);
    setRect(input, 10, 80, 80, 40);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const feedback: PageActionFeedback[] = [];
    const environment = {
      clock: { now: () => 1_000 },
      window,
      feedback: { show: (value: PageActionFeedback) => feedback.push(value) },
    };

    await executeDomAction(
      document,
      {
        actionId: 'hover_feedback',
        tabId: 7,
        type: 'hover',
        target: targetFor('Hover me'),
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      environment,
    );
    await executeDomAction(
      document,
      {
        actionId: 'key_no_feedback',
        tabId: 7,
        type: 'pressKey',
        target: targetFor('Keyboard'),
        key: 'Enter',
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      environment,
    );

    expect(feedback).toEqual([{ kind: 'move', x: 50, y: 40 }]);
  });

  it('shows click feedback only when a check action changes state', async () => {
    document.body.innerHTML = '<label><input type="checkbox" />Accept</label>';
    const checkbox = document.querySelector<HTMLInputElement>('input');
    if (checkbox === null) throw new Error('Check fixture failed to initialize.');
    setRect(checkbox, 20, 30, 20, 20);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const feedback: PageActionFeedback[] = [];
    const environment = {
      clock: { now: () => 1_000 },
      window,
      feedback: { show: (value: PageActionFeedback) => feedback.push(value) },
    };
    const action: BrowserActionRequest = {
      actionId: 'check_feedback',
      tabId: 7,
      type: 'check',
      target: targetFor('Accept'),
      checked: true,
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    };

    await executeDomAction(document, action, environment);
    await executeDomAction(document, { ...action, actionId: 'check_unchanged' }, environment);

    expect(feedback).toEqual([{ kind: 'click', x: 30, y: 40 }]);
  });

  it('shows drag feedback using the live source and destination centers', async () => {
    document.body.innerHTML = '<button>Source</button><button>Destination</button>';
    const [source, destination] = [...document.querySelectorAll('button')];
    if (source === undefined || destination === undefined) {
      throw new Error('Drag fixture failed to initialize.');
    }
    setRect(source, 10, 20, 40, 20);
    setRect(destination, 200, 300, 80, 40);
    destination.addEventListener('dragover', (event) => event.preventDefault());
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const feedback: PageActionFeedback[] = [];

    await executeDomAction(
      document,
      {
        actionId: 'drag_feedback',
        tabId: 7,
        type: 'drag',
        target: targetFor('Source'),
        destination: targetFor('Destination'),
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      {
        clock: { now: () => 1_000 },
        window,
        feedback: { show: (value) => feedback.push(value) },
      },
    );

    expect(feedback).toEqual([{ kind: 'drag', fromX: 30, fromY: 30, toX: 240, toY: 320 }]);
  });

  it('keeps action evidence successful when visual feedback throws', async () => {
    document.body.innerHTML = '<button>Save</button>';
    const button = document.querySelector<HTMLButtonElement>('button');
    if (button === null) throw new Error('Feedback failure fixture failed to initialize.');
    setRect(button, 20, 40);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });

    const evidence = await executeDomAction(
      document,
      {
        actionId: 'feedback_failure',
        tabId: 7,
        type: 'click',
        target: targetFor('Save'),
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      {
        clock: { now: () => 1_000 },
        window,
        feedback: {
          show: () => {
            throw new Error('Overlay unavailable');
          },
        },
      },
    );

    expect(evidence).toMatchObject({
      actionId: 'feedback_failure',
      status: 'executed',
    });
  });

  it('clicks, types, clears, selects, and checks through native DOM behavior', async () => {
    document.body.innerHTML = `
      <label for="message">Message</label><input id="message" />
      <label for="choice">Choice</label><select id="choice"><option value="a">A</option><option value="b">B</option></select>
      <label for="accept">Accept</label><input id="accept" type="checkbox" />
      <button>Save</button>
    `;
    const input = document.querySelector<HTMLInputElement>('#message');
    const select = document.querySelector<HTMLSelectElement>('#choice');
    const checkbox = document.querySelector<HTMLInputElement>('#accept');
    const button = document.querySelector<HTMLButtonElement>('button');
    if (input === null || select === null || checkbox === null || button === null) {
      throw new Error('Action fixture failed to initialize.');
    }
    [input, select, checkbox, button].forEach((element, index) =>
      setRect(element, 20, 20 + index * 50),
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    const textEvents: string[] = [];
    input.addEventListener('input', () => textEvents.push('input'));
    input.addEventListener('change', () => textEvents.push('change'));
    const driver = createDriver();

    await driver.execute({
      actionId: 'click_1',
      tabId: 7,
      type: 'click',
      target: targetFor('Save'),
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });
    await driver.execute({
      actionId: 'type_1',
      tabId: 7,
      type: 'type',
      target: targetFor('Message'),
      text: 'hello',
      replace: true,
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('hello');
    expect(textEvents).toEqual(['input', 'change']);

    await driver.execute({
      actionId: 'clear_1',
      tabId: 7,
      type: 'clear',
      target: targetFor('Message'),
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });
    await driver.execute({
      actionId: 'select_1',
      tabId: 7,
      type: 'select',
      target: targetFor('Choice'),
      value: 'b',
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });
    await driver.execute({
      actionId: 'check_1',
      tabId: 7,
      type: 'check',
      target: targetFor('Accept'),
      checked: true,
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });
    expect(input).toHaveValue('');
    expect(select).toHaveValue('b');
    expect(checkbox).toBeChecked();
  });

  it('dispatches hover, keyboard, scroll, and accepted synthetic drag sequences', async () => {
    document.body.innerHTML = `
      <input aria-label="Keyboard" />
      <button id="hover">Hover me</button>
      <div id="scroll" tabindex="0">Scroll region</div>
      <button id="source">Source</button>
      <button id="destination">Destination</button>
    `;
    const keyboard = document.querySelector<HTMLInputElement>('input');
    const hover = document.querySelector<HTMLButtonElement>('#hover');
    const scroll = document.querySelector<HTMLElement>('#scroll');
    const source = document.querySelector<HTMLButtonElement>('#source');
    const destination = document.querySelector<HTMLButtonElement>('#destination');
    if (
      keyboard === null ||
      hover === null ||
      scroll === null ||
      source === null ||
      destination === null
    ) {
      throw new Error('Interaction fixture failed to initialize.');
    }
    [keyboard, hover, scroll, source, destination].forEach((element, index) =>
      setRect(element, 20, 20 + index * 50),
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const hoverEvents: string[] = [];
    hover.addEventListener('mouseover', () => hoverEvents.push('mouseover'));
    const keyEvents: string[] = [];
    keyboard.addEventListener('keydown', (event) => keyEvents.push(`down:${event.key}`));
    keyboard.addEventListener('keyup', (event) => keyEvents.push(`up:${event.key}`));
    const scrollBy = vi.fn();
    Object.defineProperty(scroll, 'scrollBy', {
      configurable: true,
      value: scrollBy,
    });
    const dragEvents: string[] = [];
    source.addEventListener('dragstart', () => dragEvents.push('dragstart'));
    destination.addEventListener('dragenter', () => dragEvents.push('dragenter'));
    destination.addEventListener('dragover', (event) => {
      dragEvents.push('dragover');
      event.preventDefault();
    });
    destination.addEventListener('drop', () => dragEvents.push('drop'));
    source.addEventListener('dragend', () => dragEvents.push('dragend'));
    const driver = createDriver();

    await driver.execute({
      actionId: 'hover_1',
      tabId: 7,
      type: 'hover',
      target: targetFor('Hover me'),
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });
    await driver.execute({
      actionId: 'key_1',
      tabId: 7,
      type: 'pressKey',
      target: targetFor('Keyboard'),
      key: 'Enter',
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });
    await driver.execute({
      actionId: 'scroll_1',
      tabId: 7,
      type: 'scroll',
      target: targetFor('scroll'),
      deltaX: 0,
      deltaY: 300,
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });
    const dragEvidence = await driver.execute({
      actionId: 'drag_1',
      tabId: 7,
      type: 'drag',
      target: targetFor('Source'),
      destination: targetFor('Destination'),
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    });

    expect(hoverEvents).toEqual(['mouseover']);
    expect(keyEvents).toEqual(['down:Enter', 'up:Enter']);
    expect(scrollBy).toHaveBeenCalledWith({
      left: 0,
      top: 300,
      behavior: 'auto',
    });
    expect(dragEvents).toEqual(['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']);
    expect(dragEvidence.status).toBe('executed');
  });

  it('reports waitFor and ignored synthetic drag without claiming an effect', async () => {
    document.body.innerHTML = '<button>Source</button><button>Destination</button>';
    const buttons = [...document.querySelectorAll('button')];
    buttons.forEach((button, index) => setRect(button, 20, 20 + index * 50));
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const driver = createDriver();

    const wait: BrowserActionRequest = {
      actionId: 'wait_1',
      tabId: 7,
      type: 'waitFor',
      timeoutMs: 1_000,
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    };
    await expect(driver.execute(wait)).resolves.toMatchObject({
      status: 'unsupported',
    });
    await expect(
      driver.execute({
        actionId: 'drag_ignored',
        tabId: 7,
        type: 'drag',
        target: targetFor('Source'),
        destination: targetFor('Destination'),
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      }),
    ).resolves.toMatchObject({ status: 'unsupported' });
  });

  it('refuses an obscured target before invoking its DOM method', async () => {
    document.body.innerHTML = '<button>Save</button><div id="overlay"></div>';
    const button = document.querySelector<HTMLButtonElement>('button');
    const overlay = document.querySelector<HTMLDivElement>('#overlay');
    if (button === null || overlay === null) throw new Error('Obscuration fixture failed.');
    setRect(button, 20, 20);
    setRect(overlay, 20, 20);
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => overlay),
    });
    const observedButton = observeDocument(document, {
      id: 'before_overlay',
      capturedAt: 1_000,
      tabId: 7,
      viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
    }).elements[0];
    if (observedButton === undefined) throw new Error('Button observation is missing.');
    const target = createElementTarget({
      ...observedButton,
      obscured: false,
    });

    await expect(
      createDriver().execute({
        actionId: 'blocked_click',
        tabId: 7,
        type: 'click',
        target,
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'ACTION_BLOCKED' }));
    expect(clicked).not.toHaveBeenCalled();
  });

  it('preserves a correlated stable action error returned by the page boundary', async () => {
    const port = new ChromeDomActionPort({
      sendMessage: async (_tabId, message) => ({
        version: 1,
        requestId: message.requestId,
        ok: false,
        error: {
          code: 'TARGET_NOT_FOUND',
          message: 'Browser target could not be found.',
        },
      }),
    });
    const action: BrowserActionRequest = {
      actionId: 'missing_1',
      tabId: 7,
      type: 'click',
      target: {
        framePath: [],
        shadowPath: [],
        role: 'button',
        name: 'Missing',
        label: null,
        text: 'Missing',
        stableAttributes: {},
        ancestorHint: null,
        lastKnownRect: null,
      },
      risk: 'low',
      expected: { type: 'page.stable', quietMs: 300 },
    };

    await expect(port.execute(action)).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    });
  });

  it('updates a same-origin frame control without depending on top-window constructors', async () => {
    document.body.innerHTML = '<iframe title="Embedded form"></iframe>';
    const frame = document.querySelector('iframe');
    const frameDocument = frame?.contentDocument;
    if (frame === null || frameDocument === null || frameDocument === undefined) {
      throw new Error('Frame fixture failed to initialize.');
    }
    setRect(frame, 20, 20, 400, 220);
    frameDocument.body.innerHTML = `
      <label for="choice">Frame Choice</label>
      <select id="choice"><option value="a">A</option><option value="b">B</option></select>
    `;
    const select = frameDocument.querySelector<HTMLSelectElement>('select');
    if (select === null) throw new Error('Frame select failed to initialize.');
    setRect(select, 10, 10);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    Object.defineProperty(frameDocument, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });

    await executeDomAction(
      document,
      {
        actionId: 'frame_select_1',
        tabId: 7,
        type: 'select',
        target: targetFor('Frame Choice'),
        value: 'b',
        risk: 'low',
        expected: {
          type: 'element.value',
          target: targetFor('Frame Choice'),
          equals: 'b',
        },
      },
      { clock: { now: () => 1_000 }, window },
    );

    expect(select).toHaveValue('b');
  });

  it('projects same-origin frame feedback into the top-level viewport', async () => {
    document.body.innerHTML = '<iframe title="Embedded controls"></iframe>';
    const frame = document.querySelector('iframe');
    const frameDocument = frame?.contentDocument;
    if (frame === null || frameDocument === null || frameDocument === undefined) {
      throw new Error('Frame feedback fixture failed to initialize.');
    }
    setRect(frame, 100, 200, 400, 220);
    frameDocument.body.innerHTML = '<button>Frame Save</button>';
    const button = frameDocument.querySelector<HTMLButtonElement>('button');
    if (button === null) throw new Error('Frame feedback button failed to initialize.');
    setRect(button, 10, 20, 100, 40);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    Object.defineProperty(frameDocument, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => null),
    });
    const feedback: PageActionFeedback[] = [];

    await executeDomAction(
      document,
      {
        actionId: 'frame_click_feedback',
        tabId: 7,
        type: 'click',
        target: targetFor('Frame Save'),
        risk: 'low',
        expected: { type: 'page.stable', quietMs: 300 },
      },
      {
        clock: { now: () => 1_000 },
        window,
        feedback: { show: (value) => feedback.push(value) },
      },
    );

    expect(feedback).toEqual([{ kind: 'click', x: 160, y: 240 }]);
  });
});
