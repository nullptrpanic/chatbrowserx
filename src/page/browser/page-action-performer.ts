import type { PageCommand } from '../../shared/protocol/message-types';
import { showVirtualPointer } from './mount-virtual-pointer';
import type { PageElementRefStore } from './page-element-ref-store';

type PageAction = Extract<PageCommand, { readonly type: 'page.action.perform' }>['payload'];

type PageActionReason =
  'ref_not_found' | 'scroll_target_not_found' | 'unsupported_action' | 'trusted_input_required';

interface PageActionPoint {
  readonly x: number;
  readonly y: number;
}

const EDITABLE_SETTLE_DEADLINE_MS = 120;

interface PageActionResultBase {
  readonly action: PageAction['action'];
  readonly applied: boolean;
  readonly url: string;
  readonly reason?: PageActionReason;
}

export type PageActionResult =
  | (PageActionResultBase & {
      readonly action: 'click';
      readonly dispatched: boolean;
    })
  | (PageActionResultBase & {
      readonly action: 'type';
      readonly dispatched: boolean;
      readonly value: string;
      readonly submitted: boolean;
      readonly target?: PageActionPoint;
    })
  | (PageActionResultBase & {
      readonly action: 'scroll';
      readonly moved: boolean;
      readonly actualDeltaX: number;
      readonly actualDeltaY: number;
    })
  | (PageActionResultBase & {
      readonly action: 'select';
      readonly dispatched: boolean;
      readonly value: string;
    });

function composedParent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function editorHostHint(element: Element): boolean {
  if ((element as HTMLElement).isContentEditable) return true;
  let current: Element | null = element;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const role = current.getAttribute('role')?.trim().toLowerCase();
    const roleDescription = current.getAttribute('aria-roledescription')?.trim().toLowerCase();
    const classHint = current.getAttribute('class') ?? '';
    if (
      role === 'code' ||
      role === 'application' ||
      roleDescription?.includes('editor') ||
      classHint
        .split(/\s+/)
        .some((token) => /(?:^|[-_])(editor|monaco|codemirror|ace)(?:$|[-_])/i.test(token))
    ) {
      return true;
    }
    current = composedParent(current);
  }
  return false;
}

function elementPoint(element: Element, topDocument: Document): PageActionPoint | null {
  const bounds = element.getBoundingClientRect();
  let x = bounds.x + bounds.width / 2;
  let y = bounds.y + bounds.height / 2;
  let currentDocument = element.ownerDocument;
  while (currentDocument !== topDocument) {
    const frame = currentDocument.defaultView?.frameElement;
    if (!(frame instanceof Element)) return null;
    const frameBounds = frame.getBoundingClientRect();
    x += frameBounds.x;
    y += frameBounds.y;
    currentDocument = frame.ownerDocument;
  }
  return Number.isFinite(x) && Number.isFinite(y) && bounds.width > 0 && bounds.height > 0
    ? { x: Math.max(0, x), y: Math.max(0, y) }
    : null;
}

function editableValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
  isTextControl: boolean,
): string {
  return isTextControl
    ? (element as HTMLInputElement | HTMLTextAreaElement).value
    : (element.textContent ?? '');
}

async function settleEditableValue(document_: Document, window_: Window): Promise<void> {
  await Promise.resolve();
  if (document_.visibilityState !== 'visible') return;
  await new Promise<void>((resolve) => {
    let animationFrame: number | undefined;
    let framesRemaining = 2;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (animationFrame !== undefined) window_.cancelAnimationFrame(animationFrame);
      window_.clearTimeout(deadline);
      document_.removeEventListener('visibilitychange', handleVisibilityChange);
      resolve();
    };
    const handleVisibilityChange = (): void => {
      if (document_.visibilityState !== 'visible') finish();
    };
    const handleAnimationFrame = (): void => {
      animationFrame = undefined;
      framesRemaining -= 1;
      if (framesRemaining === 0 || document_.visibilityState !== 'visible') {
        finish();
        return;
      }
      animationFrame = window_.requestAnimationFrame(handleAnimationFrame);
    };
    document_.addEventListener('visibilitychange', handleVisibilityChange);
    animationFrame = window_.requestAnimationFrame(handleAnimationFrame);
    const deadline = window_.setTimeout(finish, EDITABLE_SETTLE_DEADLINE_MS);
    handleVisibilityChange();
  });
}

function supportsAxis(element: Element, deltaX: number, deltaY: number): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const scrollableX =
    deltaX !== 0 &&
    element.scrollWidth > element.clientWidth &&
    ['auto', 'scroll', 'overlay'].includes(style?.overflowX ?? '');
  const scrollableY =
    deltaY !== 0 &&
    element.scrollHeight > element.clientHeight &&
    ['auto', 'scroll', 'overlay'].includes(style?.overflowY ?? '');
  return scrollableX || scrollableY;
}

function closestScrollable(element: Element, deltaX: number, deltaY: number): Element | null {
  let current: Element | null = element;
  while (current) {
    if (supportsAxis(current, deltaX, deltaY)) return current;
    current = composedParent(current);
  }
  return null;
}

function viewportTarget(document_: Document, deltaX: number, deltaY: number): Element | null {
  const root = document_.scrollingElement;
  if (!root) return null;
  const canMoveX = deltaX !== 0 && root.scrollWidth > root.clientWidth;
  const canMoveY = deltaY !== 0 && root.scrollHeight > root.clientHeight;
  return canMoveX || canMoveY ? root : null;
}

function pageUrl(document_: Document): string {
  return document_.location.href.slice(0, 4_096);
}

async function showElementPointer(
  element: Element,
  effect: 'move' | 'click',
  document_: Document,
  window_: Window,
): Promise<void> {
  const bounds = element.getBoundingClientRect();
  const point = {
    x: Math.max(0, bounds.x + bounds.width / 2),
    y: Math.max(0, bounds.y + bounds.height / 2),
  };
  await showVirtualPointer(
    { ...point, fromX: point.x, fromY: point.y, effect },
    document_,
    window_,
  ).catch(() => undefined);
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const ownerWindow = element.ownerDocument.defaultView;
  const prototype =
    element.tagName === 'INPUT'
      ? ownerWindow?.HTMLInputElement.prototype
      : ownerWindow?.HTMLTextAreaElement.prototype;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set : undefined;
  if (setter) setter.call(element, value);
  else element.value = value;
}

function inputEvent(element: Element, text: string): Event {
  const ownerWindow = element.ownerDocument.defaultView;
  if (ownerWindow?.InputEvent) {
    return new ownerWindow.InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text,
    });
  }
  const Event_ = ownerWindow?.Event ?? Event;
  return new Event_('input', { bubbles: true });
}

function bubblingEvent(element: Element, type: 'change' | 'input'): Event {
  const Event_ = element.ownerDocument.defaultView?.Event ?? Event;
  return new Event_(type, { bubbles: true });
}

function submitInput(element: HTMLInputElement | HTMLTextAreaElement | HTMLElement): void {
  const form = element.closest('form') as HTMLFormElement | null;
  if (form?.requestSubmit) {
    form.requestSubmit();
    return;
  }
  const ownerWindow = element.ownerDocument.defaultView;
  const KeyboardEvent_ = ownerWindow?.KeyboardEvent ?? KeyboardEvent;
  element.dispatchEvent(
    new KeyboardEvent_('keydown', { key: 'Enter', code: 'Enter', bubbles: true }),
  );
  element.dispatchEvent(
    new KeyboardEvent_('keyup', { key: 'Enter', code: 'Enter', bubbles: true }),
  );
}

function scrollElement(element: Element, deltaX: number, deltaY: number): void {
  if ('scrollBy' in element && typeof element.scrollBy === 'function') {
    element.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
    return;
  }
  element.scrollLeft += deltaX;
  element.scrollTop += deltaY;
}

/** Performs one bounded DOM action and returns measured page state instead of dispatch-only success. */
export async function performPageAction(
  action: PageAction,
  refs: PageElementRefStore,
  document_: Document,
  window_: Window,
): Promise<PageActionResult> {
  const url = pageUrl(document_);
  if (action.action === 'click') {
    const element = refs.resolve(action.ref);
    const clickable = element as HTMLElement | undefined;
    if (!clickable) {
      return { action: 'click', applied: false, dispatched: false, url, reason: 'ref_not_found' };
    }
    if (
      !clickable.isConnected ||
      action.button !== 'left' ||
      action.count !== 1 ||
      typeof clickable.click !== 'function' ||
      ('disabled' in clickable && clickable.disabled === true) ||
      clickable.getAttribute('aria-disabled') === 'true'
    ) {
      return {
        action: 'click',
        applied: false,
        dispatched: false,
        url,
        reason: 'unsupported_action',
      };
    }
    await showElementPointer(clickable, 'click', document_, window_);
    if (!clickable.isConnected) {
      return {
        action: 'click',
        applied: false,
        dispatched: false,
        url,
        reason: 'ref_not_found',
      };
    }
    clickable.focus?.({ preventScroll: true });
    clickable.click();
    return { action: 'click', applied: true, dispatched: true, url };
  }

  if (action.action === 'type') {
    const element = refs.resolve(action.ref);
    if (!element) {
      return {
        action: 'type',
        applied: false,
        dispatched: false,
        value: '',
        submitted: false,
        url,
        reason: 'ref_not_found',
      };
    }
    const isTextControl = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
    const isEditable = (element as HTMLElement).isContentEditable;
    if (!isTextControl && !isEditable) {
      return {
        action: 'type',
        applied: false,
        dispatched: false,
        value: '',
        submitted: false,
        url,
        reason: 'unsupported_action',
      };
    }
    const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
    if ('disabled' in control && (control.disabled || control.readOnly)) {
      return {
        action: 'type',
        applied: false,
        dispatched: false,
        value: isTextControl
          ? (control as HTMLInputElement | HTMLTextAreaElement).value
          : (control.textContent ?? ''),
        submitted: false,
        url,
        reason: 'unsupported_action',
      };
    }
    const target = elementPoint(element, document_);
    if (editorHostHint(element)) {
      return {
        action: 'type',
        applied: false,
        dispatched: false,
        value: editableValue(control, isTextControl).slice(0, 20_000),
        submitted: false,
        url,
        reason: 'trusted_input_required',
        ...(target ? { target } : {}),
      };
    }
    await showElementPointer(element, 'click', document_, window_);
    control.focus?.({ preventScroll: true });
    let nextValue: string;
    if (isTextControl) {
      const textControl = control as HTMLInputElement | HTMLTextAreaElement;
      nextValue = action.replace ? action.text : `${textControl.value}${action.text}`;
      setNativeValue(textControl, nextValue);
    } else {
      nextValue = action.replace ? action.text : `${control.textContent ?? ''}${action.text}`;
      control.textContent = nextValue;
    }
    control.dispatchEvent(inputEvent(control, action.text));
    control.dispatchEvent(bubblingEvent(control, 'change'));
    await settleEditableValue(document_, window_);
    const appliedValue = editableValue(control, isTextControl);
    if (appliedValue !== nextValue) {
      return {
        action: 'type',
        applied: false,
        dispatched: true,
        value: appliedValue.slice(0, 20_000),
        submitted: false,
        url,
        reason: 'trusted_input_required',
        ...(target ? { target } : {}),
      };
    }
    if (action.submit) submitInput(control);
    return {
      action: 'type',
      applied: true,
      dispatched: true,
      value: appliedValue.slice(0, 20_000),
      submitted: action.submit,
      url,
    };
  }

  if (action.action === 'select') {
    const element = refs.resolve(action.ref);
    if (!element) {
      return {
        action: 'select',
        applied: false,
        dispatched: false,
        value: '',
        url,
        reason: 'ref_not_found',
      };
    }
    if (element.tagName !== 'SELECT') {
      return {
        action: 'select',
        applied: false,
        dispatched: false,
        value: '',
        url,
        reason: 'unsupported_action',
      };
    }
    const select = element as HTMLSelectElement;
    if (![...select.options].some(({ value }) => value === action.value)) {
      return {
        action: 'select',
        applied: false,
        dispatched: false,
        value: select.value,
        url,
        reason: 'unsupported_action',
      };
    }
    await showElementPointer(select, 'click', document_, window_);
    const setter = select.ownerDocument.defaultView?.HTMLSelectElement
      ? Object.getOwnPropertyDescriptor(
          select.ownerDocument.defaultView.HTMLSelectElement.prototype,
          'value',
        )?.set
      : undefined;
    if (setter) setter.call(select, action.value);
    else select.value = action.value;
    select.dispatchEvent(bubblingEvent(select, 'input'));
    select.dispatchEvent(bubblingEvent(select, 'change'));
    return { action: 'select', applied: true, dispatched: true, value: select.value, url };
  }

  const referenced = action.target === 'viewport' ? undefined : refs.resolve(action.target);
  if (action.target !== 'viewport' && !referenced) {
    return {
      action: 'scroll',
      applied: false,
      moved: false,
      actualDeltaX: 0,
      actualDeltaY: 0,
      url,
      reason: 'ref_not_found',
    };
  }
  const target = referenced
    ? closestScrollable(referenced, action.deltaX, action.deltaY)
    : viewportTarget(document_, action.deltaX, action.deltaY);
  if (!target) {
    return {
      action: 'scroll',
      applied: false,
      moved: false,
      actualDeltaX: 0,
      actualDeltaY: 0,
      url,
      reason: 'scroll_target_not_found',
    };
  }

  await showElementPointer(target, 'move', document_, window_);
  const beforeX = target.scrollLeft;
  const beforeY = target.scrollTop;
  scrollElement(target, action.deltaX, action.deltaY);
  const actualDeltaX = target.scrollLeft - beforeX;
  const actualDeltaY = target.scrollTop - beforeY;
  return {
    action: 'scroll',
    applied: true,
    moved: actualDeltaX !== 0 || actualDeltaY !== 0,
    actualDeltaX,
    actualDeltaY,
    url,
  };
}
