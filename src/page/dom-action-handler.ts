import type { BrowserActionRequest } from '../browser/contracts/action';
import type { BrowserActionEvidence } from '../browser/contracts/evidence';
import type { ObservedElement } from '../browser/contracts/observation';
import type { ElementTarget } from '../browser/contracts/target';
import { ActionExecutionError } from '../browser/act/action-errors';
import { resolveTarget } from '../browser/locate/target-resolver';
import { observeDocumentWithBindings } from '../browser/observe/dom-observer';
import type { Clock } from '../shared/time';

export interface DomActionEnvironment {
  readonly clock: Clock;
  readonly window: Window;
}

interface LiveTarget {
  readonly observed: ObservedElement;
  readonly element: Element;
}

/** Resolves a durable target against a fresh DOM snapshot and returns its private live binding. */
function resolveLiveTarget(
  target: ElementTarget,
  observation: ReturnType<typeof observeDocumentWithBindings>,
): LiveTarget {
  const resolution = resolveTarget(observation.observation, target);
  if (resolution.kind === 'not_found') {
    throw new ActionExecutionError('TARGET_NOT_FOUND', 'Browser target could not be found.');
  }
  if (resolution.kind === 'ambiguous') {
    throw new ActionExecutionError('TARGET_AMBIGUOUS', 'Browser target is ambiguous.');
  }
  if (
    resolution.element.obscured ||
    !resolution.element.visible ||
    resolution.element.state.disabled
  ) {
    throw new ActionExecutionError('ACTION_BLOCKED', 'Browser target is not safely interactable.');
  }
  const element = observation.bindings.get(resolution.element.observationRef);
  if (element === undefined) {
    throw new ActionExecutionError('TARGET_NOT_FOUND', 'Browser target binding is stale.');
  }
  return { observed: resolution.element, element };
}

/** Calls the native property setter so controlled frameworks receive the same value transition. */
function setNativeProperty(element: Element, property: 'value' | 'checked', value: unknown): void {
  let prototype: object | null = element;
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor?.set !== undefined) {
      descriptor.set.call(element, value);
      return;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  throw new ActionExecutionError('ACTION_UNSUPPORTED', `Target does not support ${property}.`);
}

/** Dispatches framework-compatible input and change events after a native form update. */
function dispatchFormEvents(element: Element, data: string | null): void {
  const view = element.ownerDocument.defaultView;
  const EventConstructor = view?.Event ?? Event;
  const inputEvent =
    view !== null && typeof view.InputEvent === 'function'
      ? new view.InputEvent('input', {
          bubbles: true,
          cancelable: false,
          data,
          inputType: data === null ? 'deleteContentBackward' : 'insertText',
        })
      : new EventConstructor('input', { bubbles: true });
  element.dispatchEvent(inputEvent);
  element.dispatchEvent(new EventConstructor('change', { bubbles: true }));
}

/** Creates a mouse-family event with coordinates centered on the current target rectangle. */
function mouseEvent(element: Element, type: string): MouseEvent {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  const MouseEventConstructor = view?.MouseEvent ?? MouseEvent;
  return new MouseEventConstructor(type, {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  });
}

/** Dispatches a cancelable drag event, falling back to Event when DragEvent is unavailable. */
function dragEvent(element: Element, type: string): Event {
  const view = element.ownerDocument.defaultView;
  const EventConstructor = view?.Event ?? Event;
  return view !== null && typeof view.DragEvent === 'function'
    ? new view.DragEvent(type, { bubbles: true, cancelable: true })
    : new EventConstructor(type, { bubbles: true, cancelable: true });
}

/** Produces the bounded semantic target summary stored in action evidence. */
function targetSummary(target: LiveTarget | null): BrowserActionEvidence['resolvedTarget'] {
  if (target === null) return null;
  return {
    role: target.observed.role,
    name: target.observed.name.slice(0, 200),
    frameDepth: target.observed.framePath.length,
    shadowDepth: target.observed.shadowPath.length,
  };
}

/** Executes the approved native DOM actions after a fresh semantic resolution boundary. */
export async function executeDomAction(
  document: Document,
  request: BrowserActionRequest,
  environment: DomActionEnvironment = { clock: { now: () => Date.now() }, window },
): Promise<BrowserActionEvidence> {
  const startedAt = environment.clock.now();
  const beforeUrl = environment.window.location.href;
  const snapshot = observeDocumentWithBindings(document, {
    id: `action_${request.actionId}`,
    capturedAt: startedAt,
    tabId: request.tabId,
    url: beforeUrl,
    viewport: {
      width: environment.window.innerWidth,
      height: environment.window.innerHeight,
      scrollX: environment.window.scrollX,
      scrollY: environment.window.scrollY,
    },
  });
  let target: LiveTarget | null = null;
  let status: BrowserActionEvidence['status'] = 'executed';
  const commandResult: Record<string, string | number | boolean | null> = {};

  if ('target' in request && request.target !== null) {
    target = resolveLiveTarget(request.target, snapshot);
  }

  switch (request.type) {
    case 'click': {
      const clickable = target?.element as { click?: () => void } | undefined;
      if (clickable?.click === undefined) {
        throw new ActionExecutionError('ACTION_UNSUPPORTED', 'Target does not support click.');
      }
      clickable.click();
      break;
    }
    case 'type': {
      if (target === null) throw new ActionExecutionError('TARGET_NOT_FOUND', 'Target is missing.');
      const current = 'value' in target.element ? String(target.element.value ?? '') : '';
      const nextValue = request.replace ? request.text : `${current}${request.text}`;
      setNativeProperty(target.element, 'value', nextValue);
      dispatchFormEvents(target.element, request.text);
      commandResult.characters = request.text.length;
      break;
    }
    case 'clear':
      if (target === null) throw new ActionExecutionError('TARGET_NOT_FOUND', 'Target is missing.');
      setNativeProperty(target.element, 'value', '');
      dispatchFormEvents(target.element, null);
      break;
    case 'select': {
      if (target?.element.tagName !== 'SELECT') {
        throw new ActionExecutionError('ACTION_UNSUPPORTED', 'Target is not a select element.');
      }
      const select = target.element as HTMLSelectElement;
      if (![...select.options].some((option) => option.value === request.value)) {
        throw new ActionExecutionError('ACTION_FAILED', 'Requested option is unavailable.');
      }
      setNativeProperty(select, 'value', request.value);
      dispatchFormEvents(select, request.value);
      break;
    }
    case 'check':
      if (
        target?.element.tagName !== 'INPUT' ||
        !['checkbox', 'radio'].includes((target.element as HTMLInputElement).type)
      ) {
        throw new ActionExecutionError('ACTION_UNSUPPORTED', 'Target is not checkable.');
      }
      if ((target.element as HTMLInputElement).checked !== request.checked) {
        setNativeProperty(target.element, 'checked', request.checked);
        dispatchFormEvents(target.element, null);
      }
      break;
    case 'hover':
      if (target === null) throw new ActionExecutionError('TARGET_NOT_FOUND', 'Target is missing.');
      for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
        target.element.dispatchEvent(mouseEvent(target.element, type));
      }
      break;
    case 'pressKey': {
      const keyTarget = target?.element ?? document.activeElement ?? document.body;
      if ('focus' in keyTarget && typeof keyTarget.focus === 'function') keyTarget.focus();
      const view = keyTarget.ownerDocument.defaultView;
      const KeyboardEventConstructor = view?.KeyboardEvent ?? KeyboardEvent;
      keyTarget.dispatchEvent(
        new KeyboardEventConstructor('keydown', {
          key: request.key,
          bubbles: true,
          cancelable: true,
        }),
      );
      keyTarget.dispatchEvent(
        new KeyboardEventConstructor('keyup', {
          key: request.key,
          bubbles: true,
          cancelable: true,
        }),
      );
      break;
    }
    case 'scroll': {
      const scrollTarget = target?.element as
        { scrollBy?: (options: ScrollToOptions) => void } | undefined;
      if (scrollTarget?.scrollBy !== undefined) {
        scrollTarget.scrollBy({ left: request.deltaX, top: request.deltaY, behavior: 'auto' });
      } else {
        environment.window.scrollBy({
          left: request.deltaX,
          top: request.deltaY,
          behavior: 'auto',
        });
      }
      break;
    }
    case 'drag': {
      if (target === null) throw new ActionExecutionError('TARGET_NOT_FOUND', 'Source is missing.');
      const destination = resolveLiveTarget(request.destination, snapshot);
      target.element.dispatchEvent(dragEvent(target.element, 'dragstart'));
      destination.element.dispatchEvent(dragEvent(destination.element, 'dragenter'));
      const accepted = !destination.element.dispatchEvent(
        dragEvent(destination.element, 'dragover'),
      );
      destination.element.dispatchEvent(dragEvent(destination.element, 'drop'));
      target.element.dispatchEvent(dragEvent(target.element, 'dragend'));
      status = accepted ? 'executed' : 'unsupported';
      commandResult.accepted = accepted;
      break;
    }
    case 'waitFor':
      status = 'unsupported';
      commandResult.reason = 'verification_engine_required';
      break;
  }

  return {
    actionId: request.actionId,
    actionKind: request.type,
    driver: 'dom',
    status,
    startedAt,
    finishedAt: environment.clock.now(),
    resolvedTarget: targetSummary(target),
    beforeUrl,
    afterUrl: environment.window.location.href,
    commandResult,
  };
}
