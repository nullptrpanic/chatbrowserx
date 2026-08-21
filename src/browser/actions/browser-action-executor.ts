import type { Protocol } from 'devtools-protocol';
import type { ParsedBrowserToolCall } from '../../agent/tools/browser-tool-schema';
import { IMAGE_POLICY } from '../../attachments/attachment-policy';
import type { AttachmentRepository } from '../../persistence/attachment-repository';
import type { PageCommand } from '../../shared/protocol/message-types';
import type { DebuggerSession, DebuggerTransport } from '../debugger/debugger-transport';
import type {
  BrowserSessionSnapshot,
  TargetSessionRegistry,
} from '../debugger/target-session-registry';
import {
  ElementRefStoreError,
  type ElementRefStore,
  type ObservedElementRefState,
  type ObservedElementTarget,
  type ResolvedElementRef,
  type ViewportRect,
} from '../observation/element-ref-store';
import {
  SEMANTIC_SNAPSHOT_STYLES,
  buildSemanticPageSnapshot,
} from '../observation/semantic-page-snapshot';
import { readSelectionState } from '../selection-state';
import { parseKeyChord, type ParsedKeyChord } from './key-chords';

const POINTER_FEEDBACK_DEADLINE_MS = 250;
const INPUT_SETTLE_TIMEOUT_MS = 1_500;
const INPUT_POLL_INTERVAL_MS = 75;
const SELECTION_SETTLE_TIMEOUT_MS = 1_500;
const SELECTION_POLL_INTERVAL_MS = 75;

const SELECT_FUNCTION = `function(value) {
  if (!(this instanceof HTMLSelectElement)) return { ok: false };
  this.value = value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: this.value };
}`;

const SCROLL_ELEMENT_FUNCTION = `function(deltaX, deltaY) {
  const __chatbrowserxScrollTarget = true;
  void __chatbrowserxScrollTarget;
  const element = this;
  const window_ = element?.ownerDocument?.defaultView;
  if (!window_?.Element || !(element instanceof window_.Element)) return { found: false };
  const scrollable = (candidate) => {
    const style = window_.getComputedStyle(candidate);
    const overflow = (value) => value === 'auto' || value === 'scroll' || value === 'overlay';
    return (
      (overflow(style.overflowX) && candidate.scrollWidth > candidate.clientWidth + 1) ||
      (overflow(style.overflowY) && candidate.scrollHeight > candidate.clientHeight + 1)
    );
  };
  let target = element;
  while (target && !scrollable(target)) target = target.parentElement;
  if (!target) return { found: false };
  const beforeX = target.scrollLeft;
  const beforeY = target.scrollTop;
  target.scrollLeft = beforeX + deltaX;
  target.scrollTop = beforeY + deltaY;
  return {
    found: true,
    beforeX,
    beforeY,
    afterX: target.scrollLeft,
    afterY: target.scrollTop,
    maxX: Math.max(0, target.scrollWidth - target.clientWidth),
    maxY: Math.max(0, target.scrollHeight - target.clientHeight),
  };
}`;

const CLICK_ELEMENT_FUNCTION = `function() {
  if (!this || typeof this.click !== 'function') return { dispatched: false };
  this.click();
  return { dispatched: true };
}`;

const READ_SELECTION_STATE_FUNCTION = `function(role) {
  const __chatbrowserxSelectionState = true;
  void __chatbrowserxSelectionState;
  const element = this;
  const window_ = element?.ownerDocument?.defaultView;
  if (!window_?.Element || !(element instanceof window_.Element)) {
    return { observable: false };
  }
  if (!element.isConnected) return { observable: false };
  const booleanAttribute = (name) => {
    const value = element.getAttribute(name);
    if (value === null) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === '' || normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    return undefined;
  };
  let selected;
  if (role === 'option') {
    if (typeof element.selected === 'boolean') selected = element.selected;
    if (selected === undefined) selected = booleanAttribute('aria-selected');
    if (selected === undefined) selected = booleanAttribute('data-selected');
  } else {
    if (typeof element.checked === 'boolean') selected = element.checked;
    if (selected === undefined) selected = booleanAttribute('aria-checked');
    if (selected === undefined) selected = booleanAttribute('data-checked');
  }
  const dataState = (element.getAttribute('data-state') || '').trim().toLowerCase();
  if (selected === undefined && ['checked', 'selected', 'on'].includes(dataState)) selected = true;
  if (selected === undefined && ['unchecked', 'unselected', 'off'].includes(dataState)) selected = false;
  const className = typeof element.className === 'string' ? element.className : '';
  const tokens = className.split(/\\s+/).filter(Boolean);
  if (
    selected === undefined &&
    tokens.some((token) => /(?:^|[-_])(?:is[-_]|state[-_])?(?:checked|selected)(?:$|[-_])/i.test(token))
  ) {
    selected = true;
  }
  if (
    selected === undefined &&
    tokens.some((token) => /(?:^|[-_])(?:checkbox|radio|switch|choice|option)(?:$|[-_])/i.test(token))
  ) {
    selected = false;
  }
  return selected === undefined
    ? { observable: false }
    : { observable: true, selected };
}`;

const FIND_ACTIONABLE_POINT_FUNCTION = `function(points) {
  const __chatbrowserxActionablePoint = true;
  void __chatbrowserxActionablePoint;
  const element = this;
  const document_ = element?.ownerDocument;
  const window_ = document_?.defaultView;
  if (
    !window_?.Element ||
    !(element instanceof window_.Element) ||
    !element.isConnected ||
    typeof document_.elementFromPoint !== 'function' ||
    !Array.isArray(points)
  ) {
    return null;
  }
  const composedRelated = (left, right) => {
    const reaches = (start, expected) => {
      let current = start;
      for (let depth = 0; current && depth < 32; depth += 1) {
        if (current === expected) return true;
        const root = current.getRootNode?.();
        current = current.parentElement ||
          (window_.ShadowRoot && root instanceof window_.ShadowRoot ? root.host : null);
      }
      return false;
    };
    return reaches(right, left) || reaches(left, right);
  };
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    let hit = document_.elementFromPoint(point.x, point.y);
    for (let depth = 0; hit?.shadowRoot && depth < 8; depth += 1) {
      const inner = hit.shadowRoot.elementFromPoint?.(point.x, point.y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (hit && composedRelated(element, hit)) return index;
  }
  return -1;
}`;

const FOCUSED_EDITABLE_VALUE_EXPRESSION = `(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element) return null;
  if ('value' in element && typeof element.value === 'string') return element.value;
  if (element instanceof HTMLElement && element.isContentEditable) {
    return element.innerText ?? element.textContent ?? '';
  }
  return null;
})()`;

const INSERT_FOCUSED_TEXT_FUNCTION = `function(text, replace, customEditor) {
  const __chatbrowserxInsertText = true;
  void __chatbrowserxInsertText;
  const isElement = (candidate) => candidate?.ownerDocument?.defaultView?.Element &&
    candidate instanceof candidate.ownerDocument.defaultView.Element;
  const composedParent = (candidate) => {
    const root = candidate?.getRootNode?.();
    return candidate?.parentElement || (root?.host && isElement(root.host) ? root.host : null);
  };
  const isEditable = (candidate) => {
    const window_ = candidate?.ownerDocument?.defaultView;
    return Boolean(
      candidate &&
      ((typeof window_?.HTMLInputElement === 'function' &&
        candidate instanceof window_.HTMLInputElement) ||
        (typeof window_?.HTMLTextAreaElement === 'function' &&
          candidate instanceof window_.HTMLTextAreaElement) ||
        (typeof window_?.HTMLElement === 'function' &&
          candidate instanceof window_.HTMLElement &&
          candidate.isContentEditable))
    );
  };
  let source = isElement(this) ? this : this.document?.activeElement;
  let active = source?.ownerDocument?.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  let element = source;
  while (element && !isEditable(element)) element = composedParent(element);
  if (
    !element &&
    isEditable(active) &&
    (!isElement(source) || source.contains(active) || active.contains(source))
  ) {
    element = active;
  }
  const window_ = element?.ownerDocument?.defaultView;
  if (
    element &&
    ((typeof window_?.HTMLInputElement === 'function' &&
      element instanceof window_.HTMLInputElement) ||
      (typeof window_?.HTMLTextAreaElement === 'function' &&
        element instanceof window_.HTMLTextAreaElement)) &&
    typeof window_.InputEvent === 'function'
  ) {
    const before = element.value;
    const start = replace ? 0 : (element.selectionStart ?? before.length);
    const end = replace ? before.length : (element.selectionEnd ?? start);
    const value = before.slice(0, start) + text + before.slice(end);
    const prototype = element instanceof window_.HTMLTextAreaElement
      ? window_.HTMLTextAreaElement.prototype
      : window_.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.setSelectionRange?.(start + text.length, start + text.length);
    const event = new window_.InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: customEditor
        ? 'insertFromPaste'
        : replace
          ? 'insertReplacementText'
          : 'insertText',
      data: text,
    });
    element.dispatchEvent(event);
    return {
      dispatched: true,
      strategy: customEditor ? 'input_from_paste' : 'native_input',
      defaultPrevented: event.defaultPrevented,
    };
  }
  if (!element || !window_?.DataTransfer || !window_.ClipboardEvent) {
    return { dispatched: false };
  }
  const clipboardData = new window_.DataTransfer();
  clipboardData.setData('text/plain', text);
  const event = new window_.ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    composed: true,
    clipboardData,
  });
  element.dispatchEvent(event);
  const content = () => element.innerText ?? element.textContent ?? '';
  if (event.defaultPrevented || content().includes(text)) {
    return {
      dispatched: true,
      strategy: 'synthetic_paste',
      defaultPrevented: event.defaultPrevented,
    };
  }
  if (!(element instanceof window_.HTMLElement) || !element.isContentEditable) {
    return { dispatched: true, strategy: 'synthetic_paste', defaultPrevented: false };
  }
  const document_ = element.ownerDocument;
  const selection = window_.getSelection();
  let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const container = range?.commonAncestorContainer;
  const rangeInside = container && (container === element || element.contains(container));
  if (!range || replace || !rangeInside) {
    range = document_.createRange();
    range.selectNodeContents(element);
    if (!replace) range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  const inserted = document_.execCommand?.('insertText', false, text) === true;
  if (!inserted) {
    range.deleteContents();
    const textNode = document_.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new window_.InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: replace ? 'insertReplacementText' : 'insertText',
      data: text,
    }));
  }
  return { dispatched: true, strategy: inserted ? 'insert_text' : 'range_insert' };
}`;

export async function pasteImageIntoEditor(
  this: unknown,
  base64: string,
  mimeType: string,
  fileName: string,
  settleMs = 1_200,
): Promise<Readonly<Record<string, unknown>>> {
  const __chatbrowserxPasteImage = true;
  void __chatbrowserxPasteImage;
  const source = this as (Node & { readonly document?: Document }) | null;
  const document_ = source?.ownerDocument ?? source?.document;
  const window_ = document_?.defaultView;
  if (!document_ || !window_?.DataTransfer || !window_.File || typeof window_.atob !== 'function') {
    return { dispatched: false, reason: 'clipboard_api_unavailable' };
  }
  const isElement = (candidate: unknown): candidate is Element =>
    Boolean(window_.Element && candidate instanceof window_.Element);
  const composedParent = (candidate: Node): Element | null => {
    const root = candidate?.getRootNode?.();
    return (
      candidate?.parentElement ||
      (window_.ShadowRoot && root instanceof window_.ShadowRoot ? root.host : null)
    );
  };
  const acceptsPaste = (candidate: unknown): candidate is Element => {
    if (!isElement(candidate)) return false;
    if (window_.HTMLInputElement && candidate instanceof window_.HTMLInputElement) return true;
    if (window_.HTMLTextAreaElement && candidate instanceof window_.HTMLTextAreaElement)
      return true;
    return Boolean(
      window_.HTMLElement &&
      candidate instanceof window_.HTMLElement &&
      (candidate.isContentEditable ||
        ['', 'true', 'plaintext-only'].includes(
          (candidate.getAttribute('contenteditable') ?? 'false').trim().toLowerCase(),
        ) ||
        candidate.getAttribute('role') === 'textbox'),
    );
  };
  let element: Element | null = isElement(source)
    ? source
    : source instanceof window_.Node
      ? composedParent(source)
      : null;
  let target: Element | null = null;
  for (let depth = 0; element && depth < 10; depth += 1) {
    if (acceptsPaste(element)) {
      target = element;
      break;
    }
    element = composedParent(element);
  }
  if (!target && isElement(source) && typeof source.querySelector === 'function') {
    target = source.querySelector(
      'input[type="file"], [contenteditable="true"], [contenteditable="plaintext-only"], textarea, [role="textbox"]',
    );
  }
  if (!target || !target.isConnected) return { dispatched: false, reason: 'target_not_editable' };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const binary = window_.atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return { dispatched: false, reason: 'invalid_image_data' };
  }
  const file = new window_.File([bytes], fileName, { type: mimeType, lastModified: Date.now() });
  const clipboardData = new window_.DataTransfer();
  clipboardData.items.add(file);
  if (target instanceof window_.HTMLElement) target.focus({ preventScroll: true });
  if (
    window_.HTMLInputElement &&
    target instanceof window_.HTMLInputElement &&
    target.type.toLowerCase() === 'file'
  ) {
    try {
      target.files = clipboardData.files;
    } catch {
      return { dispatched: false, reason: 'file_input_rejected' };
    }
    target.dispatchEvent(new window_.Event('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new window_.Event('change', { bubbles: true, composed: true }));
    const fileCount = target.files?.length || 0;
    return {
      dispatched: true,
      strategy: 'file_input',
      fileCount,
      handled: fileCount === 1,
      verified: fileCount === 1,
      mutations: 0,
    };
  }
  let observationRoot = target;
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = composedParent(observationRoot);
    if (!parent) break;
    observationRoot = parent;
  }
  const mediaSelector = 'img, canvas, video, object, embed, [role="img"]';
  const beforeLocalElements = new Set(observationRoot.querySelectorAll('*'));
  const beforeMedia = new Set(document_.querySelectorAll(mediaSelector));
  const targetRect = target.getBoundingClientRect();
  const countElements = () => observationRoot.querySelectorAll('*').length;
  const beforeElements = countElements();
  let mutations = 0;
  let addedElements = 0;
  const observer = window_.MutationObserver
    ? new window_.MutationObserver((records) => {
        mutations += records.length;
        for (const record of records) {
          for (const node of record.addedNodes || []) {
            if (node.nodeType === 1) addedElements += 1;
          }
        }
      })
    : null;
  observer?.observe(observationRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'class', 'aria-label', 'data-state'],
  });
  let event: Event;
  try {
    event = new window_.ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData,
    });
  } catch {
    event = new window_.Event('paste', { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  }
  const propagated = target.dispatchEvent(event);
  const boundedSettleMs = Number.isFinite(settleMs)
    ? Math.max(0, Math.min(5_000, settleMs))
    : 1_200;
  await new Promise((resolve) => window_.setTimeout(resolve, boundedSettleMs));
  observer?.disconnect();
  const handled = event.defaultPrevented || propagated === false;
  const isNearTarget = (candidate: Element): boolean => {
    const rect = candidate.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const horizontalOverlap = rect.right >= targetRect.left && rect.left <= targetRect.right;
    const verticalDistance = Math.max(
      0,
      targetRect.top - rect.bottom,
      rect.top - targetRect.bottom,
    );
    return horizontalOverlap && verticalDistance <= 480;
  };
  const isVisualElement = (candidate: Element): boolean => {
    if (candidate.matches(mediaSelector)) return true;
    const backgroundImage = window_.getComputedStyle(candidate).backgroundImage;
    return backgroundImage !== 'none' && /url\s*\(/i.test(backgroundImage);
  };
  const localPreviews = Array.from(observationRoot.querySelectorAll('*')).filter(
    (candidate) => !beforeLocalElements.has(candidate) && isVisualElement(candidate),
  );
  const nearbyMediaPreviews = Array.from(document_.querySelectorAll(mediaSelector)).filter(
    (candidate) => !beforeMedia.has(candidate) && isNearTarget(candidate),
  );
  const previews = new Set([...localPreviews, ...nearbyMediaPreviews]);
  const verified = previews.size > 0;
  return {
    dispatched: true,
    strategy: 'clipboard_event',
    fileCount: clipboardData.files.length,
    handled,
    verified,
    mutations,
    addedElements,
    localChanged: countElements() !== beforeElements,
    previewCount: previews.size,
  };
}

const PASTE_IMAGE_FUNCTION = pasteImageIntoEditor.toString();

/** Self-contained DOM probe serialized into the target realm by Runtime.callFunctionOn. */
export function inspectEditorTarget(this: unknown): {
  readonly editor: boolean;
  readonly custom: boolean;
  readonly connected: boolean;
  readonly value: string;
} {
  const __chatbrowserxEditorTargetInfo = true;
  void __chatbrowserxEditorTargetInfo;
  const source = this as {
    readonly ownerDocument?: Document;
    readonly document?: Document;
    readonly parentElement?: Element | null;
    getRootNode?(): Node;
  } | null;
  const document_ = source?.ownerDocument ?? source?.document;
  const window_ = document_?.defaultView;
  if (!window_?.Node || !source || !(source instanceof window_.Node)) {
    return { editor: false, custom: false, connected: false, value: '' };
  }
  const isElement = (candidate: unknown): candidate is Element =>
    Boolean(window_.Element && candidate instanceof window_.Element);
  const composedParent = (candidate: Node): Element | null => {
    if (candidate.parentElement) return candidate.parentElement;
    const root = candidate.getRootNode();
    return window_.ShadowRoot && root instanceof window_.ShadowRoot && isElement(root.host)
      ? root.host
      : null;
  };
  let current: Element | null = isElement(source) ? source : composedParent(source);
  let editorElement: Element | null = null;
  let monacoRoot: Element | null = null;
  let editor = false;
  let custom = false;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const role = (current.getAttribute('role') || '').trim().toLowerCase();
    const roleDescription = (current.getAttribute('aria-roledescription') || '')
      .trim()
      .toLowerCase();
    const classHint = current.getAttribute('class') || '';
    const classTokens = classHint.split(/\s+/);
    const monaco = classTokens.some((token) => /(?:^|[-_])monaco(?:$|[-_])/i.test(token));
    if (monaco) monacoRoot ||= current;
    const declaredContentEditable = current.getAttribute('contenteditable');
    const contentEditable = (declaredContentEditable ?? '').trim().toLowerCase();
    const contentEditableHost =
      window_.HTMLElement &&
      current instanceof window_.HTMLElement &&
      (current.isContentEditable ||
        (declaredContentEditable !== null &&
          (contentEditable === '' ||
            contentEditable === 'true' ||
            contentEditable === 'plaintext-only')));
    if (
      contentEditableHost ||
      (window_.HTMLInputElement && current instanceof window_.HTMLInputElement) ||
      (window_.HTMLTextAreaElement && current instanceof window_.HTMLTextAreaElement)
    ) {
      editor = true;
      editorElement ||= current;
    }
    if (
      role === 'code' ||
      role === 'application' ||
      roleDescription.includes('code editor') ||
      classTokens.some(
        (token) =>
          /(?:^|[-_])(?:monaco|codemirror)(?:$|[-_])/i.test(token) ||
          /^ace[-_]editor(?:$|[-_])/i.test(token),
      )
    ) {
      editor = true;
      custom = true;
    }
    const root = current.getRootNode();
    current =
      current.parentElement ||
      (window_.ShadowRoot && root instanceof window_.ShadowRoot && isElement(root.host)
        ? root.host
        : null);
  }
  const valueElement = editorElement ?? (isElement(source) ? source : composedParent(source));
  let value =
    valueElement && 'value' in valueElement && typeof valueElement.value === 'string'
      ? valueElement.value
      : ((valueElement as HTMLElement | null)?.innerText ?? valueElement?.textContent ?? '');
  const monacoApi = (
    window_ as typeof window_ & {
      readonly monaco?: {
        readonly editor?: {
          getEditors?(): readonly {
            getDomNode?(): HTMLElement | null;
            getModel?(): { getValue?(): unknown } | null;
          }[];
        };
      };
    }
  ).monaco?.editor;
  if (monacoRoot && typeof monacoApi?.getEditors === 'function') {
    const matchingEditors = monacoApi.getEditors().filter((candidate) => {
      const domNode = candidate.getDomNode?.();
      return Boolean(
        domNode &&
        (domNode === monacoRoot || domNode.contains(source) || monacoRoot.contains(domNode)),
      );
    });
    if (matchingEditors.length === 1) {
      const modelValue = matchingEditors[0]?.getModel?.()?.getValue?.();
      if (typeof modelValue === 'string') value = modelValue;
    }
  }
  return { editor, custom, connected: valueElement?.isConnected === true, value };
}

const EDITOR_TARGET_INFO_FUNCTION = inspectEditorTarget.toString();

export type PointerEffect = 'move' | 'click' | 'double_click' | 'drag';

export interface PointerPagePort {
  show(
    tabId: number,
    effect: {
      readonly x: number;
      readonly y: number;
      readonly fromX: number;
      readonly fromY: number;
      readonly effect: PointerEffect;
    },
  ): Promise<void>;
}

export interface BrowserPlatformPort {
  getOs(): Promise<string>;
}

export interface BrowserActionResult {
  readonly tabId: number;
  readonly url: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly observation: Readonly<Record<string, unknown>> | null;
  /** A batch mutation may preserve a verified prefix while reporting its first failure. */
  readonly failure?: {
    readonly code: string;
    readonly stage?: BrowserActionError['stage'];
  };
}

export interface BrowserActionPort {
  execute(call: ParsedBrowserToolCall, signal: AbortSignal): Promise<BrowserActionResult>;
}

type PageActionInput = Extract<PageCommand, { readonly type: 'page.action.perform' }>['payload'];

export interface BrowserPageActionPort {
  performAction(
    tabId: number,
    action: PageActionInput,
  ): Promise<
    Readonly<Record<string, unknown>> & {
      readonly action: PageActionInput['action'];
      readonly applied: boolean;
      readonly url: string;
    }
  >;
}

export type BrowserActionErrorCode =
  | 'UNSUPPORTED_ACTION'
  | 'ASSET_NOT_AVAILABLE'
  | 'ATTACHMENT_VERIFICATION_FAILED'
  | 'SELECTABLE_ACTION_REQUIRED'
  | 'ACTION_STATE_MISMATCH'
  | 'ACTION_STATE_UNAVAILABLE'
  | 'ACTION_TARGET_OBSCURED'
  | 'POINT_OUT_OF_VIEWPORT'
  | 'HISTORY_UNAVAILABLE'
  | 'WAIT_TIMEOUT'
  | 'TYPE_VERIFICATION_FAILED';

export class BrowserActionError extends Error {
  readonly code: BrowserActionErrorCode;
  readonly stage: 'focus' | 'insert' | 'readback' | 'submit' | undefined;

  constructor(
    code: BrowserActionErrorCode,
    message: string,
    stage?: 'focus' | 'insert' | 'readback' | 'submit',
  ) {
    super(message);
    this.name = 'BrowserActionError';
    this.code = code;
    this.stage = stage;
  }
}

export interface BrowserActionExecutorDependencies {
  readonly sessions: Pick<TargetSessionRegistry, 'ensure'>;
  readonly transport: DebuggerTransport;
  readonly refs: ElementRefStore;
  readonly pointer: PointerPagePort;
  readonly platform: BrowserPlatformPort;
  readonly page?: BrowserPageActionPort;
  readonly attachments?: Pick<AttachmentRepository, 'get'>;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Browser action was aborted.', 'AbortError');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 32 * 1_024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function quadRect(quad: readonly number[] | undefined): ViewportRect | undefined {
  if (!quad || quad.length < 8 || quad.some((coordinate) => !Number.isFinite(coordinate))) {
    return undefined;
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]].filter(
    (value): value is number => value !== undefined,
  );
  const ys = [quad[1], quad[3], quad[5], quad[7]].filter(
    (value): value is number => value !== undefined,
  );
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

interface PreparedElementTarget {
  readonly reference: ResolvedElementRef;
  readonly session: DebuggerSession;
  readonly point: Point;
  readonly rect: ViewportRect;
}

interface EditorTargetInfo {
  readonly editor: boolean;
  readonly custom: boolean;
  readonly connected?: boolean;
  readonly value: string;
}

interface RefStateObservation {
  readonly target?: ObservedElementRefState;
  readonly rebound: boolean;
  readonly changes: readonly Readonly<{
    ref: string;
    state: readonly string[];
  }>[];
}

interface RuntimeSelectionState {
  readonly observable: boolean;
  readonly selected?: boolean;
}

interface SetCheckedExecutionResult {
  readonly ref: string;
  readonly requested: boolean;
  readonly actual: boolean;
  readonly dispatched: boolean;
  readonly strategy: string;
  readonly state: readonly string[];
  readonly target: ObservedElementRefState;
  readonly changes: readonly Readonly<{ ref: string; state: readonly string[] }>[];
}

function input<T>(call: ParsedBrowserToolCall): T {
  return call.arguments as T;
}

function trustedInputPoint(
  pageResult: Awaited<ReturnType<BrowserPageActionPort['performAction']>> | null,
): Point | null {
  if (
    pageResult?.action !== 'type' ||
    pageResult.applied ||
    pageResult.reason !== 'trusted_input_required' ||
    typeof pageResult.target !== 'object' ||
    pageResult.target === null
  ) {
    return null;
  }
  const target = pageResult.target as Readonly<Record<string, unknown>>;
  return typeof target.x === 'number' &&
    Number.isFinite(target.x) &&
    typeof target.y === 'number' &&
    Number.isFinite(target.y)
    ? { x: target.x, y: target.y }
    : null;
}

function axValue(value: Protocol.Accessibility.AXValue | undefined): string | null {
  return typeof value?.value === 'string' ? value.value.replace(/\r\n?/g, '\n') : null;
}

function axBoolean(value: Protocol.Accessibility.AXValue | undefined): boolean {
  return value?.value === true;
}

function axEditable(value: Protocol.Accessibility.AXValue | undefined): boolean {
  return value?.value === true || value?.value === 'richtext' || value?.value === 'plaintext';
}

function focusedEditableValue(nodes: readonly Protocol.Accessibility.AXNode[]): string | null {
  const editable = nodes.filter((node) => {
    if (node.ignored) return false;
    const role = axValue(node.role)?.toLowerCase();
    return (
      role === 'textbox' ||
      role === 'searchbox' ||
      (node.properties ?? []).some(
        (property) => property.name === 'editable' && axEditable(property.value),
      )
    );
  });
  const focused = editable.find((node) =>
    (node.properties ?? []).some(
      (property) => property.name === 'focused' && axBoolean(property.value),
    ),
  );
  return axValue(focused?.value);
}

function evaluatedEditableValue(response: Protocol.Runtime.EvaluateResponse): string | null {
  return response.exceptionDetails === undefined && typeof response.result.value === 'string'
    ? response.result.value.replace(/\r\n?/g, '\n')
    : null;
}

const EDITOR_PLACEHOLDER = /(?:\u200b|\u200c|\u200d|\u2060|\ufeff)/u;
const EDITOR_PLACEHOLDER_GLOBAL = /(?:\u200b|\u200c|\u200d|\u2060|\ufeff)/gu;
const EDITOR_PLACEHOLDER_SUFFIX = /^(?:\s|\u200b|\u200c|\u200d|\u2060|\ufeff)*$/u;

function substantiveEditorLines(value: string): readonly string[] {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(EDITOR_PLACEHOLDER_GLOBAL, '')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function verifiesRichTextReplacement(actual: string, expected: string): boolean {
  const expectedLines = substantiveEditorLines(expected);
  if (expectedLines.length === 0) return false;
  const actualLines = substantiveEditorLines(actual);
  return (
    actualLines.length === expectedLines.length &&
    actualLines.every((line, index) => line === expectedLines[index])
  );
}

function verifiesReplacement(actual: string | null, expected: string): boolean {
  if (actual === expected) return true;
  if (actual === null) return false;
  const expectedIndex = actual.indexOf(expected);
  if (expectedIndex >= 0) {
    const prefix = actual.slice(0, expectedIndex);
    const suffix = actual.slice(expectedIndex + expected.length);
    const boundary = `${prefix}${suffix}`;
    if (
      EDITOR_PLACEHOLDER.test(boundary) &&
      EDITOR_PLACEHOLDER_SUFFIX.test(prefix) &&
      EDITOR_PLACEHOLDER_SUFFIX.test(suffix)
    ) {
      return true;
    }
  }
  return verifiesRichTextReplacement(actual, expected);
}

function verifiesInput(actual: string | null, expected: string, replace: boolean, before: string) {
  return replace
    ? verifiesReplacement(actual, expected)
    : expected.length === 0 || (actual !== null && actual !== before && actual.includes(expected));
}

function normalizeInputValue(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function inputValueHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function inputVerification(actual: string, expected: string) {
  const normalizedActual = normalizeInputValue(actual);
  const normalizedExpected = normalizeInputValue(expected);
  return {
    valueLength: normalizedActual.length,
    valueHash: inputValueHash(normalizedActual),
    prefixMatch: normalizedActual.startsWith(normalizedExpected),
    suffixMatch: normalizedActual.endsWith(normalizedExpected),
  };
}

function expectedSelectionAfterClick(role: string, selected: boolean): boolean {
  return role === 'radio' || role === 'option' ? true : !selected;
}

function booleanAxValue(value: unknown): boolean | undefined {
  if (value === true || value === 'true' || value === 1) return true;
  if (value === false || value === 'false' || value === 0) return false;
  return undefined;
}

function partialAxSelectionState(
  response: Protocol.Accessibility.GetPartialAXTreeResponse,
  backendNodeId: number,
  role: string,
): boolean | undefined {
  const node = response.nodes.find(
    (candidate) => candidate.backendDOMNodeId === backendNodeId && !candidate.ignored,
  );
  if (!node) return undefined;
  const preferred = role === 'option' ? ['selected', 'checked'] : ['checked', 'selected'];
  for (const name of preferred) {
    const property = (node.properties ?? []).find((candidate) => candidate.name === name);
    const value = booleanAxValue(property?.value.value);
    if (value !== undefined) return value;
  }
  return undefined;
}

function runtimeSelectionState(
  response: Protocol.Runtime.CallFunctionOnResponse,
): boolean | undefined {
  if (response.exceptionDetails !== undefined || typeof response.result.value !== 'object') {
    return undefined;
  }
  const value = response.result.value as RuntimeSelectionState | null;
  return value?.observable === true && typeof value.selected === 'boolean'
    ? value.selected
    : undefined;
}

function selectionState(
  current: readonly string[],
  role: string,
  selected: boolean,
): readonly string[] {
  const property = role === 'option' ? 'selected' : 'checked';
  return [
    selected ? property : `${property}=false`,
    ...current.filter(
      (value) =>
        value !== 'checked' &&
        value !== 'checked=false' &&
        value !== 'selected' &&
        value !== 'selected=false',
    ),
  ];
}

/** Executes already-checkpointed browser actions through semantic refs or validated viewport points. */
export class BrowserActionExecutor implements BrowserActionPort {
  readonly #dependencies: BrowserActionExecutorDependencies;
  #primaryModifier: Promise<number> | undefined;

  constructor(dependencies: BrowserActionExecutorDependencies) {
    this.#dependencies = dependencies;
  }

  async execute(call: ParsedBrowserToolCall, signal: AbortSignal): Promise<BrowserActionResult> {
    throwIfAborted(signal);
    const tabId = (call.arguments as { readonly tabId: number }).tabId;
    const pageResult = await this.#performPageAction(call, tabId);
    if (pageResult?.applied) {
      const { url, ...rawData } = pageResult;
      const observedValue = typeof pageResult.value === 'string' ? pageResult.value : '';
      const data =
        pageResult.action === 'type'
          ? {
              action: 'type',
              applied: true,
              dispatched: pageResult.dispatched,
              strategy: 'dom',
              verified: true,
              replaced: input<{ readonly replace: boolean }>(call).replace,
              submitted: pageResult.submitted,
              valueLength: observedValue.length,
              verification: inputVerification(
                observedValue,
                input<{ readonly text: string }>(call).text,
              ),
            }
          : rawData;
      return {
        tabId,
        url,
        data,
        observation: {
          targetPresent: call.operation === 'scroll' ? null : true,
        },
      };
    }
    if (call.operation === 'wait') {
      const value = input<{
        condition: 'load' | 'network_idle' | 'dom_stable' | 'delay';
        timeoutMs: number;
      }>(call);
      if (value.condition === 'delay') {
        await this.#delay(value.timeoutMs, signal);
        return {
          tabId,
          url: null,
          data: { action: 'wait', condition: 'delay', completed: true },
          observation: { targetPresent: null },
        };
      }
    }
    const snapshot = await this.#dependencies.sessions.ensure(tabId, signal);
    let data: Readonly<Record<string, unknown>>;
    let targetPresent: boolean | null = null;
    let targetState: readonly string[] | undefined;
    let observedTarget: ObservedElementRefState | undefined;
    let stateChanges: readonly Readonly<{ ref: string; state: readonly string[] }>[] | undefined;
    let actionFailure: BrowserActionResult['failure'];

    switch (call.operation) {
      case 'paste_image': {
        const value = input<{ tabId: number; ref: string; assetId: string }>(call);
        const attachments = this.#dependencies.attachments;
        if (!attachments) {
          throw new BrowserActionError(
            'ASSET_NOT_AVAILABLE',
            'Browser image delivery is unavailable.',
          );
        }
        const attachment = await attachments.get(value.assetId);
        const mimeType = attachment?.mimeType.toLowerCase() ?? '';
        if (
          !attachment ||
          !IMAGE_POLICY.acceptedMimeTypes.some((accepted) => accepted === mimeType) ||
          attachment.byteSize <= 0 ||
          attachment.byteSize > IMAGE_POLICY.maxBytesPerImage ||
          attachment.byteSize !== attachment.blob.size ||
          attachment.blob.type.toLowerCase() !== mimeType
        ) {
          throw new BrowserActionError(
            'ASSET_NOT_AVAILABLE',
            'The requested image asset is unavailable or invalid.',
          );
        }
        throwIfAborted(signal);
        const target = await this.#prepareElementTarget(snapshot, value.ref, tabId);
        await this.#showPointer(tabId, target.point, target.point, 'click');
        const bytes = new Uint8Array(await attachment.blob.arrayBuffer());
        throwIfAborted(signal);
        const base64 = encodeBase64(bytes);
        const extension =
          mimeType === 'image/jpeg'
            ? 'jpg'
            : mimeType === 'image/webp'
              ? 'webp'
              : mimeType === 'image/gif'
                ? 'gif'
                : 'png';
        const fileName =
          attachment.fileName?.trim().slice(0, 200) || `chatbrowserx-screenshot.${extension}`;
        const resolved = await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
          target.session,
          'DOM.resolveNode',
          { backendNodeId: target.reference.backendNodeId },
        );
        const objectId = resolved.object.objectId;
        if (!objectId) {
          throw new BrowserActionError('UNSUPPORTED_ACTION', 'The paste target is unavailable.');
        }
        try {
          const response =
            await this.#dependencies.transport.send<Protocol.Runtime.CallFunctionOnResponse>(
              target.session,
              'Runtime.callFunctionOn',
              {
                objectId,
                functionDeclaration: PASTE_IMAGE_FUNCTION,
                arguments: [{ value: base64 }, { value: mimeType }, { value: fileName }],
                awaitPromise: true,
                returnByValue: true,
                silent: true,
                userGesture: true,
              },
            );
          const pasted = response.result.value as
            | {
                readonly dispatched?: unknown;
                readonly strategy?: unknown;
                readonly fileCount?: unknown;
                readonly handled?: unknown;
                readonly verified?: unknown;
                readonly mutations?: unknown;
                readonly addedElements?: unknown;
                readonly localChanged?: unknown;
                readonly previewCount?: unknown;
              }
            | undefined;
          if (
            response.exceptionDetails !== undefined ||
            pasted?.dispatched !== true ||
            pasted.fileCount !== 1 ||
            (pasted.strategy !== 'clipboard_event' && pasted.strategy !== 'file_input')
          ) {
            throw new BrowserActionError(
              'UNSUPPORTED_ACTION',
              'The target did not accept the pasted image.',
            );
          }
          if (pasted.verified !== true) {
            throw new BrowserActionError(
              'ATTACHMENT_VERIFICATION_FAILED',
              'The editor handled the image paste, but no attachment preview change was measured.',
            );
          }
          data = {
            action: 'paste_image',
            dispatched: true,
            strategy: pasted.strategy,
            fileCount: 1,
            handled: pasted.handled === true,
            verified: true,
            mutations:
              typeof pasted.mutations === 'number' && Number.isSafeInteger(pasted.mutations)
                ? pasted.mutations
                : 0,
            previewCount:
              typeof pasted.previewCount === 'number' && Number.isSafeInteger(pasted.previewCount)
                ? pasted.previewCount
                : 0,
          };
        } finally {
          await this.#dependencies.transport
            .send(target.session, 'Runtime.releaseObject', { objectId })
            .catch(() => undefined);
        }
        targetPresent = true;
        break;
      }
      case 'click': {
        const value = input<{
          tabId: number;
          ref: string;
          button: 'left' | 'right' | 'middle';
          count: 1 | 2;
        }>(call);
        const target = await this.#prepareElementTarget(snapshot, value.ref, tabId);
        const selectableBefore =
          value.button === 'left' &&
          value.count === 1 &&
          target.reference.actions.includes('set_checked')
            ? await this.#readRefStates(target, tabId, value.ref)
            : undefined;
        const selectedBefore = readSelectionState(
          selectableBefore?.target?.state ?? target.reference.state,
        );
        const actionPoint = await this.#actionablePoint(target);
        await this.#showPointer(
          tabId,
          actionPoint,
          actionPoint,
          value.count === 2 ? 'double_click' : 'click',
        );
        await this.#click(target.session, actionPoint, value.button, value.count);
        const expectedSelection =
          selectableBefore !== undefined && selectedBefore !== undefined
            ? expectedSelectionAfterClick(
                selectableBefore.target?.role ?? target.reference.role,
                selectedBefore,
              )
            : undefined;
        let strategy = 'pointer';
        let observed: RefStateObservation =
          expectedSelection === undefined
            ? await this.#readRefStates(target, tabId, value.ref).catch(() => ({
                rebound: false,
                changes: [],
              }))
            : await this.#waitForSelectionState(
                target,
                tabId,
                value.ref,
                expectedSelection,
                signal,
              );
        const afterPointerState = readSelectionState(observed.target?.state ?? []);
        if (
          expectedSelection !== undefined &&
          afterPointerState !== undefined &&
          afterPointerState !== expectedSelection &&
          !observed.rebound &&
          (await this.#clickElementByRef(snapshot, tabId, value.ref))
        ) {
          strategy = 'dom_fallback';
          observed = await this.#waitForSelectionState(
            target,
            tabId,
            value.ref,
            expectedSelection,
            signal,
          );
        }
        if (
          expectedSelection !== undefined &&
          readSelectionState(observed.target?.state ?? []) !== expectedSelection
        ) {
          throw new BrowserActionError(
            'ACTION_STATE_MISMATCH',
            'The clicked selection state did not settle.',
          );
        }
        observedTarget = observed.target;
        stateChanges = observed.changes;
        targetState = observed.target?.state;
        data = {
          action: 'click',
          dispatched: true,
          button: value.button,
          count: value.count,
          verified: 'target_remeasured',
          ...(expectedSelection === undefined
            ? {}
            : {
                strategy,
                selectionVerified:
                  readSelectionState(observed.target?.state ?? []) === expectedSelection,
              }),
        };
        targetPresent = true;
        break;
      }
      case 'set_checked': {
        const value = input<{ tabId: number; ref: string; checked: boolean }>(call);
        const selected = await this.#setChecked(snapshot, tabId, value.ref, value.checked, signal);
        observedTarget = selected.target;
        stateChanges = selected.changes;
        targetState = selected.state;
        data = {
          action: 'set_checked',
          dispatched: selected.dispatched,
          requested: selected.requested,
          verified: true,
          strategy: selected.strategy,
        };
        targetPresent = true;
        break;
      }
      case 'set_checked_many': {
        const value = input<{
          tabId: number;
          items: readonly { readonly ref: string; readonly checked: boolean }[];
        }>(call);
        const completedItems: SetCheckedExecutionResult[] = [];
        const changesByRef = new Map<string, readonly string[]>();
        let failedIndex: number | undefined;
        for (const [index, item] of value.items.entries()) {
          throwIfAborted(signal);
          try {
            const selected = await this.#setChecked(
              snapshot,
              tabId,
              item.ref,
              item.checked,
              signal,
            );
            completedItems.push(selected);
            observedTarget = selected.target;
            targetState = selected.state;
            for (const change of selected.changes) changesByRef.set(change.ref, change.state);
          } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
              throw error;
            }
            failedIndex = index;
            actionFailure = {
              code:
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                typeof error.code === 'string'
                  ? error.code
                  : 'BROWSER_OPERATION_FAILED',
              ...(error instanceof BrowserActionError && error.stage !== undefined
                ? { stage: error.stage }
                : {}),
            };
            break;
          }
        }
        stateChanges = [...changesByRef].map(([ref, state]) => ({ ref, state }));
        data = {
          action: 'set_checked_many',
          complete: actionFailure === undefined,
          completedItems: completedItems.map((item) => ({
            ref: item.ref,
            requested: item.requested,
            actual: item.actual,
            dispatched: item.dispatched,
            strategy: item.strategy,
            state: item.state,
            changes: item.changes,
          })),
          ...(failedIndex === undefined ? {} : { failedIndex }),
          ...(actionFailure === undefined ? {} : { failure: actionFailure }),
        };
        targetPresent = completedItems.length > 0;
        break;
      }
      case 'type': {
        const value = input<{
          tabId: number;
          ref: string;
          text: string;
          replace: boolean;
          submit: boolean;
        }>(call);
        const fallbackPoint = trustedInputPoint(pageResult);
        const target = fallbackPoint
          ? null
          : await this.#prepareElementTarget(snapshot, value.ref, tabId);
        const targetSession = target?.session ?? snapshot.root;
        const editorInfo = target ? await this.#editorTargetInfo(target) : null;
        const trustedInput = fallbackPoint !== null || editorInfo?.editor === true;
        let verifiedValue = '';
        if (fallbackPoint) {
          await this.#validatePoint(snapshot.root, fallbackPoint);
          await this.#showPointer(tabId, fallbackPoint, fallbackPoint, 'click');
          await this.#click(snapshot.root, fallbackPoint, 'left', 1);
        } else if (target) {
          await this.#showPointer(tabId, target.point, target.point, 'click');
          await this.#dependencies.transport.send(target.session, 'DOM.focus', {
            backendNodeId: target.reference.backendNodeId,
          });
        }
        if (value.replace) {
          await this.#selectAll(targetSession);
          if (value.text.length === 0) {
            await this.#dispatchKey(targetSession, {
              kind: 'key',
              key: 'Backspace',
              code: 'Backspace',
              modifiers: 0,
            });
          }
        }
        if (value.text.length > 0) {
          if (fallbackPoint || editorInfo?.custom === true) {
            await this.#insertFocusedText(
              targetSession,
              value.text,
              value.replace,
              editorInfo?.custom ?? true,
              target,
            );
          } else {
            await this.#dependencies.transport.send(targetSession, 'Input.insertText', {
              text: value.text,
            });
          }
        }
        if (trustedInput) {
          const before = fallbackPoint
            ? typeof pageResult?.value === 'string'
              ? pageResult.value
              : ''
            : (editorInfo?.value ?? '');
          verifiedValue = await this.#verifyTrustedInput(
            targetSession,
            value.text,
            value.replace,
            before.replace(/\r\n?/g, '\n'),
            signal,
            target,
          );
        } else if (target) {
          const before = editorInfo?.value.replace(/\r\n?/g, '\n') ?? '';
          const observed = await this.#editorTargetInfo(target);
          verifiedValue = normalizeInputValue(observed.value);
          if (!verifiesInput(verifiedValue, value.text, value.replace, before)) {
            throw new BrowserActionError(
              'TYPE_VERIFICATION_FAILED',
              'The target did not retain the requested text.',
              'readback',
            );
          }
        }
        if (value.submit) {
          await this.#dispatchKey(targetSession, {
            kind: 'key',
            key: 'Enter',
            code: 'Enter',
            modifiers: 0,
          });
          await this.#verifySubmittedInput(targetSession, value.text, signal, target);
        }
        data = {
          action: 'type',
          dispatched: true,
          replaced: value.replace,
          submitted: value.submit,
          ...(value.submit ? { submissionVerified: true } : {}),
          strategy: trustedInput ? 'trusted_input' : 'cdp_ref',
          verified: true,
          verification: inputVerification(verifiedValue, value.text),
        };
        targetPresent = true;
        break;
      }
      case 'keypress': {
        const value = input<{ tabId: number; keys: string }>(call);
        const chord = parseKeyChord(value.keys);
        if (chord.kind === 'history') await this.#navigateHistory(snapshot.root, chord.direction);
        else await this.#dispatchKey(snapshot.root, chord);
        data = { action: 'keypress', dispatched: true, keys: value.keys };
        break;
      }
      case 'scroll': {
        const value = input<{
          tabId: number;
          target: string;
          deltaX: number;
          deltaY: number;
        }>(call);
        const viewport = await this.#viewport(snapshot.root);
        const prepared =
          value.target === 'viewport'
            ? null
            : await this.#prepareElementTarget(snapshot, value.target, tabId);
        const point = prepared?.point ?? {
          x: viewport.width / 2,
          y: viewport.height / 2,
        };
        if (prepared) {
          await this.#showPointer(tabId, point, point, 'move');
          const elementScroll = await this.#scrollElement(prepared, value.deltaX, value.deltaY);
          if (elementScroll) {
            const actualDeltaX = elementScroll.afterX - elementScroll.beforeX;
            const actualDeltaY = elementScroll.afterY - elementScroll.beforeY;
            data = {
              action: 'scroll',
              dispatched: true,
              strategy: 'element',
              deltaX: value.deltaX,
              deltaY: value.deltaY,
              moved: actualDeltaX !== 0 || actualDeltaY !== 0,
              actualDeltaX,
              actualDeltaY,
              position: {
                x: elementScroll.afterX,
                y: elementScroll.afterY,
                maxX: elementScroll.maxX,
                maxY: elementScroll.maxY,
              },
            };
            targetPresent = true;
            break;
          }
        }
        const scrollSession = prepared?.session ?? snapshot.root;
        const before =
          scrollSession === snapshot.root
            ? { x: viewport.pageX, y: viewport.pageY }
            : await this.#scrollPosition(scrollSession);
        await this.#showPointer(tabId, point, point, 'move');
        await this.#dependencies.transport.send(scrollSession, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX: value.deltaX,
          deltaY: value.deltaY,
        });
        const after = await this.#waitForScrollPosition(scrollSession, before, signal);
        const actualDeltaX = after.x - before.x;
        const actualDeltaY = after.y - before.y;
        data = {
          action: 'scroll',
          dispatched: true,
          deltaX: value.deltaX,
          deltaY: value.deltaY,
          moved: actualDeltaX !== 0 || actualDeltaY !== 0,
          actualDeltaX,
          actualDeltaY,
        };
        break;
      }
      case 'hover': {
        const value = input<{ tabId: number; ref: string }>(call);
        const target = await this.#prepareElementTarget(snapshot, value.ref, tabId);
        await this.#showPointer(tabId, target.point, target.point, 'move');
        await this.#dependencies.transport.send(target.session, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: target.point.x,
          y: target.point.y,
          button: 'none',
        });
        data = { action: 'hover', dispatched: true };
        targetPresent = true;
        break;
      }
      case 'select': {
        const value = input<{ tabId: number; ref: string; value: string }>(call);
        const target = await this.#prepareElementTarget(snapshot, value.ref, tabId);
        const resolved = await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
          target.session,
          'DOM.resolveNode',
          { backendNodeId: target.reference.backendNodeId },
        );
        if (!resolved.object.objectId) {
          throw new BrowserActionError('UNSUPPORTED_ACTION', 'The select target is unavailable.');
        }
        const objectId = resolved.object.objectId;
        try {
          const response =
            await this.#dependencies.transport.send<Protocol.Runtime.CallFunctionOnResponse>(
              target.session,
              'Runtime.callFunctionOn',
              {
                objectId,
                functionDeclaration: SELECT_FUNCTION,
                arguments: [{ value: value.value }],
                awaitPromise: false,
                returnByValue: true,
                userGesture: true,
              },
            );
          const result = response.result.value as
            { readonly ok?: unknown; readonly value?: unknown } | undefined;
          if (
            response.exceptionDetails !== undefined ||
            result?.ok !== true ||
            result.value !== value.value
          ) {
            throw new BrowserActionError(
              'ACTION_STATE_MISMATCH',
              'The select element did not retain the requested value.',
            );
          }
        } finally {
          await this.#dependencies.transport
            .send(target.session, 'Runtime.releaseObject', { objectId })
            .catch(() => undefined);
        }
        data = { action: 'select', dispatched: true, verified: true };
        targetPresent = true;
        break;
      }
      case 'drag': {
        const value = input<{ tabId: number; fromRef: string; toRef: string }>(call);
        const from = await this.#prepareElementTarget(snapshot, value.fromRef, tabId);
        const to = await this.#prepareElementTarget(snapshot, value.toRef, tabId);
        if (from.session.sessionId !== to.session.sessionId) {
          throw new BrowserActionError(
            'UNSUPPORTED_ACTION',
            'A drag cannot cross browser frame targets.',
          );
        }
        await this.#showPointer(tabId, to.point, from.point, 'drag');
        await this.#drag(from.session, from.point, to.point);
        data = { action: 'drag', dispatched: true };
        targetPresent = true;
        break;
      }
      case 'wait': {
        const value = input<{
          tabId: number;
          condition: 'load' | 'network_idle' | 'dom_stable' | 'delay';
          timeoutMs: number;
        }>(call);
        await this.#wait(snapshot, value.condition, value.timeoutMs, signal);
        data = { action: 'wait', condition: value.condition, completed: true };
        break;
      }
      case 'click_point': {
        const value = input<{
          tabId: number;
          x: number;
          y: number;
          button: 'left' | 'right';
          count: 1 | 2;
        }>(call);
        const point = { x: value.x, y: value.y };
        await this.#validatePoint(snapshot.root, point);
        await this.#showPointer(tabId, point, point, value.count === 2 ? 'double_click' : 'click');
        await this.#click(snapshot.root, point, value.button, value.count);
        data = {
          action: 'click_point',
          dispatched: true,
          button: value.button,
          count: value.count,
        };
        break;
      }
      case 'drag_point': {
        const value = input<{
          tabId: number;
          fromX: number;
          fromY: number;
          toX: number;
          toY: number;
        }>(call);
        const from = { x: value.fromX, y: value.fromY };
        const to = { x: value.toX, y: value.toY };
        await this.#validatePoint(snapshot.root, from);
        await this.#validatePoint(snapshot.root, to);
        await this.#showPointer(tabId, to, from, 'drag');
        await this.#drag(snapshot.root, from, to);
        data = { action: 'drag_point', dispatched: true };
        break;
      }
      default:
        throw new BrowserActionError('UNSUPPORTED_ACTION', 'This browser action is unsupported.');
    }

    throwIfAborted(signal);
    const url = await this.#currentUrl(snapshot.root);
    return {
      tabId,
      url,
      data,
      observation: {
        targetPresent,
        ...(targetState === undefined ? {} : { state: targetState }),
        ...(observedTarget === undefined
          ? {}
          : {
              target: {
                ref: observedTarget.ref,
                role: observedTarget.role,
                state: observedTarget.state,
              },
            }),
        ...(stateChanges === undefined ? {} : { changes: stateChanges }),
      },
      ...(actionFailure === undefined ? {} : { failure: actionFailure }),
    };
  }

  async #setChecked(
    snapshot: BrowserSessionSnapshot,
    tabId: number,
    ref: string,
    checked: boolean,
    signal: AbortSignal,
  ): Promise<SetCheckedExecutionResult> {
    const target = await this.#prepareElementTarget(snapshot, ref, tabId);
    const before = await this.#readRefStates(target, tabId, ref);
    const beforeTarget = before.target;
    const role = beforeTarget?.role ?? target.reference.role;
    if (!target.reference.actions.includes('set_checked')) {
      throw new BrowserActionError('UNSUPPORTED_ACTION', 'The ref does not advertise set_checked.');
    }
    if (role === 'radio' && !checked) {
      throw new BrowserActionError(
        'UNSUPPORTED_ACTION',
        'A radio target can only be selected; choose another radio to clear it.',
      );
    }
    const current = readSelectionState(beforeTarget?.state ?? target.reference.state);
    let dispatched = false;
    let strategy = 'already_set';
    let after = before;
    if (current !== checked && !(current === undefined && !checked)) {
      const actionPoint = await this.#actionablePoint(target);
      await this.#showPointer(tabId, actionPoint, actionPoint, 'click');
      await this.#click(target.session, actionPoint, 'left', 1);
      dispatched = true;
      strategy = 'pointer';
      after = await this.#waitForSelectionState(target, tabId, ref, checked, signal);
      const afterPointerState = readSelectionState(after.target?.state ?? []);
      if (
        afterPointerState !== undefined &&
        afterPointerState !== checked &&
        !after.rebound &&
        (await this.#clickElementByRef(snapshot, tabId, ref))
      ) {
        strategy = 'dom_fallback';
        after = await this.#waitForSelectionState(target, tabId, ref, checked, signal);
      }
    }
    const observedTarget = after.target ?? beforeTarget;
    const state = observedTarget?.state ?? [];
    const actual = readSelectionState(state);
    if (actual !== checked || observedTarget === undefined) {
      throw new BrowserActionError(
        'ACTION_STATE_MISMATCH',
        actual === undefined
          ? 'The requested selection state could not be observed.'
          : 'The requested selection state did not settle.',
      );
    }
    return {
      ref,
      requested: checked,
      actual,
      dispatched,
      strategy,
      state,
      target: observedTarget,
      changes: after.changes,
    };
  }

  async #readRefStates(
    target: PreparedElementTarget,
    tabId: number,
    ref: string,
  ): Promise<RefStateObservation> {
    let targetedError: unknown;
    try {
      const targeted = await this.#readTargetRefState(target, tabId, ref);
      if (targeted !== undefined) return targeted;
    } catch (error) {
      targetedError = error;
    }

    try {
      const refreshed = await this.#refreshRefStates(target, tabId, ref);
      if (refreshed.target !== undefined) return refreshed;
      throw new ElementRefStoreError(
        'STALE_REF',
        'The element was replaced and could not be identified unambiguously.',
      );
    } catch (error) {
      if (error instanceof ElementRefStoreError) throw error;
      if (error instanceof BrowserActionError) throw error;
      void targetedError;
      throw new BrowserActionError(
        'ACTION_STATE_UNAVAILABLE',
        'The browser could not read the current element state.',
      );
    }
  }

  async #readTargetRefState(
    target: PreparedElementTarget,
    tabId: number,
    ref: string,
  ): Promise<RefStateObservation | undefined> {
    const reference = this.#dependencies.refs.resolve(ref, tabId);
    const stateBackendNodeId = reference.stateBackendNodeId ?? reference.backendNodeId;
    const partial =
      await this.#dependencies.transport.send<Protocol.Accessibility.GetPartialAXTreeResponse>(
        target.session,
        'Accessibility.getPartialAXTree',
        {
          backendNodeId: stateBackendNodeId,
          fetchRelatives: false,
        },
      );
    if (!Array.isArray(partial.nodes)) return undefined;

    let selected = partialAxSelectionState(partial, stateBackendNodeId, reference.role);
    if (selected === undefined) {
      const resolved = await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
        target.session,
        'DOM.resolveNode',
        { backendNodeId: stateBackendNodeId },
      );
      const objectId = resolved.object.objectId;
      if (!objectId) return undefined;
      try {
        const runtime =
          await this.#dependencies.transport.send<Protocol.Runtime.CallFunctionOnResponse>(
            target.session,
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: READ_SELECTION_STATE_FUNCTION,
              arguments: [{ value: reference.role }],
              returnByValue: true,
              silent: true,
            },
          );
        selected = runtimeSelectionState(runtime);
      } finally {
        await this.#dependencies.transport
          .send(target.session, 'Runtime.releaseObject', { objectId })
          .catch(() => undefined);
      }
    }
    if (selected === undefined) return undefined;

    const observations = this.#dependencies.refs.updateObservedStates(tabId, [
      {
        frameTargetId: reference.frameTargetId,
        documentFrameId: reference.documentFrameId,
        loaderId: reference.loaderId,
        backendNodeId: reference.backendNodeId,
        ...(reference.stateBackendNodeId === undefined
          ? {}
          : { stateBackendNodeId: reference.stateBackendNodeId }),
        role: reference.role,
        name: reference.name,
        ...(reference.semanticLocator === undefined
          ? {}
          : { semanticLocator: reference.semanticLocator }),
        state: selectionState(reference.state, reference.role, selected),
        actions: reference.actions,
        frame: reference.frameTargetId ?? 'main',
      },
    ]);
    const targetObservation = observations.find((observation) => observation.ref === ref);
    return {
      ...(targetObservation === undefined ? {} : { target: targetObservation }),
      rebound: false,
      changes: observations
        .filter(({ changed }) => changed)
        .map(({ ref: changedRef, state }) => ({ ref: changedRef, state })),
    };
  }

  async #refreshRefStates(
    target: PreparedElementTarget,
    tabId: number,
    ref: string,
  ): Promise<RefStateObservation> {
    const beforeBackendNodeId = this.#dependencies.refs.resolve(ref, tabId).backendNodeId;
    const [tree, domSnapshot] = await Promise.all([
      this.#dependencies.transport.send<Protocol.Accessibility.GetFullAXTreeResponse>(
        target.session,
        'Accessibility.getFullAXTree',
      ),
      this.#dependencies.transport.send<Protocol.DOMSnapshot.CaptureSnapshotResponse>(
        target.session,
        'DOMSnapshot.captureSnapshot',
        { computedStyles: [...SEMANTIC_SNAPSHOT_STYLES] },
      ),
    ]);
    const semantic = buildSemanticPageSnapshot({
      axNodes: tree.nodes,
      domSnapshot,
      frame: target.reference.frameTargetId ?? 'main',
    });
    const observedTargets: ObservedElementTarget[] = semantic.targets
      .filter(({ documentFrameId }) => documentFrameId === target.reference.documentFrameId)
      .map((observed) => ({
        frameTargetId: target.reference.frameTargetId,
        documentFrameId: observed.documentFrameId,
        loaderId: target.reference.loaderId,
        backendNodeId: observed.backendNodeId,
        ...(observed.stateBackendNodeId === undefined
          ? {}
          : { stateBackendNodeId: observed.stateBackendNodeId }),
        role: observed.role,
        name: observed.name,
        semanticLocator: observed.semanticLocator,
        state: observed.state,
        actions: observed.actions,
        frame: target.reference.frameTargetId ?? 'main',
      }));
    const observations = this.#dependencies.refs.updateObservedStates(tabId, observedTargets);
    const targetObservation = observations.find((observation) => observation.ref === ref);
    const currentBackendNodeId =
      targetObservation === undefined
        ? beforeBackendNodeId
        : this.#dependencies.refs.resolve(ref, tabId).backendNodeId;
    return {
      ...(targetObservation === undefined ? {} : { target: targetObservation }),
      rebound: currentBackendNodeId !== beforeBackendNodeId,
      changes: observations
        .filter(({ changed }) => changed)
        .map(({ ref: changedRef, state }) => ({ ref: changedRef, state })),
    };
  }

  async #waitForSelectionState(
    target: PreparedElementTarget,
    tabId: number,
    ref: string,
    expected: boolean,
    signal: AbortSignal,
  ): Promise<RefStateObservation> {
    let observed = await this.#readRefStates(target, tabId, ref);
    const settleDeadline = Date.now() + SELECTION_SETTLE_TIMEOUT_MS;
    while (
      readSelectionState(observed.target?.state ?? []) !== expected &&
      Date.now() < settleDeadline
    ) {
      await this.#delay(Math.min(SELECTION_POLL_INTERVAL_MS, settleDeadline - Date.now()), signal);
      observed = await this.#readRefStates(target, tabId, ref);
    }
    if (readSelectionState(observed.target?.state ?? []) !== expected) {
      throwIfAborted(signal);
      try {
        const refreshed = await this.#refreshRefStates(target, tabId, ref);
        if (refreshed.target !== undefined) observed = refreshed;
      } catch {
        // The targeted observation is still useful when an optional full refresh is unavailable.
      }
    }
    return observed;
  }

  async #clickElementByRef(
    snapshot: BrowserSessionSnapshot,
    tabId: number,
    ref: string,
  ): Promise<boolean> {
    let objectId: string | undefined;
    let session: DebuggerSession | undefined;
    try {
      const reference = this.#dependencies.refs.resolve(ref, tabId);
      session = this.#sessionForReference(snapshot, reference);
      const resolved = await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
        session,
        'DOM.resolveNode',
        { backendNodeId: reference.backendNodeId },
      );
      objectId = resolved.object.objectId;
      if (!objectId) return false;
      const response =
        await this.#dependencies.transport.send<Protocol.Runtime.CallFunctionOnResponse>(
          session,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: CLICK_ELEMENT_FUNCTION,
            awaitPromise: false,
            returnByValue: true,
            userGesture: true,
          },
        );
      const result = response.result.value as { readonly dispatched?: unknown } | undefined;
      return response.exceptionDetails === undefined && result?.dispatched === true;
    } catch {
      return false;
    } finally {
      if (objectId && session) {
        await this.#dependencies.transport
          .send(session, 'Runtime.releaseObject', { objectId })
          .catch(() => undefined);
      }
    }
  }

  async #actionablePoint(target: PreparedElementTarget): Promise<Point> {
    const candidates: readonly Point[] = [
      target.point,
      { x: target.rect.x + target.rect.width * 0.25, y: target.point.y },
      { x: target.rect.x + target.rect.width * 0.75, y: target.point.y },
      { x: target.point.x, y: target.rect.y + target.rect.height * 0.25 },
      { x: target.point.x, y: target.rect.y + target.rect.height * 0.75 },
    ];
    let objectId: string | undefined;
    try {
      const resolved = await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
        target.session,
        'DOM.resolveNode',
        { backendNodeId: target.reference.backendNodeId },
      );
      objectId = resolved.object.objectId;
      if (!objectId) return target.point;
      const response =
        await this.#dependencies.transport.send<Protocol.Runtime.CallFunctionOnResponse>(
          target.session,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: FIND_ACTIONABLE_POINT_FUNCTION,
            arguments: [{ value: candidates }],
            returnByValue: true,
            silent: true,
          },
        );
      const index = response.exceptionDetails === undefined ? response.result.value : undefined;
      if (index === -1) {
        throw new BrowserActionError(
          'ACTION_TARGET_OBSCURED',
          'Every measured point inside the target is covered by another element.',
        );
      }
      return typeof index === 'number' && Number.isInteger(index) && candidates[index]
        ? candidates[index]
        : target.point;
    } catch (error) {
      if (error instanceof BrowserActionError) throw error;
      return target.point;
    } finally {
      if (objectId) {
        await this.#dependencies.transport
          .send(target.session, 'Runtime.releaseObject', { objectId })
          .catch(() => undefined);
      }
    }
  }

  async #prepareElementTarget(
    snapshot: BrowserSessionSnapshot,
    ref: string,
    tabId: number,
    allowRefresh = true,
  ): Promise<PreparedElementTarget> {
    const reference = this.#dependencies.refs.resolve(ref, tabId);
    const session = this.#sessionForReference(snapshot, reference);
    let frameTree: Protocol.Page.GetFrameTreeResponse;
    try {
      frameTree = await this.#dependencies.transport.send<Protocol.Page.GetFrameTreeResponse>(
        session,
        'Page.getFrameTree',
      );
    } catch {
      throw new ElementRefStoreError('STALE_REF', 'The element ref is stale.');
    }
    const loaderId = this.#loaderForFrame(frameTree.frameTree, reference.documentFrameId);
    if (loaderId !== reference.loaderId) {
      throw new ElementRefStoreError('STALE_REF', 'The element ref is stale.');
    }
    try {
      await this.#dependencies.transport.send(session, 'DOM.scrollIntoViewIfNeeded', {
        backendNodeId: reference.backendNodeId,
      });
      const [model, metrics] = await Promise.all([
        this.#dependencies.transport.send<Protocol.DOM.GetBoxModelResponse>(
          session,
          'DOM.getBoxModel',
          { backendNodeId: reference.backendNodeId },
        ),
        this.#dependencies.transport.send<Protocol.Page.GetLayoutMetricsResponse>(
          session,
          'Page.getLayoutMetrics',
        ),
      ]);
      const pageBounds = quadRect(model.model.border);
      if (!pageBounds) throw new Error('The element has no visible box.');
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
      const point = {
        x: pageBounds.x + pageBounds.width / 2,
        y: pageBounds.y + pageBounds.height / 2,
      };
      if (
        point.x < 0 ||
        point.y < 0 ||
        point.x > viewport.clientWidth ||
        point.y > viewport.clientHeight
      ) {
        throw new Error('The element is outside the frame viewport.');
      }
      return { reference, session, point, rect: pageBounds };
    } catch (error) {
      if (error instanceof ElementRefStoreError) throw error;
      if (
        allowRefresh &&
        reference.semanticLocator &&
        (await this.#refreshElementReference(session, reference, ref, tabId))
      ) {
        return this.#prepareElementTarget(snapshot, ref, tabId, false);
      }
      throw new ElementRefStoreError('STALE_REF', 'The element ref is stale.');
    }
  }

  async #refreshElementReference(
    session: DebuggerSession,
    reference: ResolvedElementRef,
    ref: string,
    tabId: number,
  ): Promise<boolean> {
    try {
      const [tree, domSnapshot] = await Promise.all([
        this.#dependencies.transport.send<Protocol.Accessibility.GetFullAXTreeResponse>(
          session,
          'Accessibility.getFullAXTree',
        ),
        this.#dependencies.transport.send<Protocol.DOMSnapshot.CaptureSnapshotResponse>(
          session,
          'DOMSnapshot.captureSnapshot',
          {
            computedStyles: [...SEMANTIC_SNAPSHOT_STYLES],
            includeDOMRects: true,
          },
        ),
      ]);
      const semantic = buildSemanticPageSnapshot({
        axNodes: tree.nodes,
        domSnapshot,
        frame: reference.frameTargetId ?? 'main',
      });
      const matches = semantic.targets.filter(
        (target) =>
          target.documentFrameId === reference.documentFrameId &&
          target.semanticLocator === reference.semanticLocator,
      );
      if (matches.length !== 1) return false;
      const [match] = matches;
      if (!match) return false;
      const observations = this.#dependencies.refs.updateObservedStates(tabId, [
        {
          frameTargetId: reference.frameTargetId,
          documentFrameId: match.documentFrameId,
          loaderId: reference.loaderId,
          backendNodeId: match.backendNodeId,
          ...(match.stateBackendNodeId === undefined
            ? {}
            : { stateBackendNodeId: match.stateBackendNodeId }),
          role: match.role,
          name: match.name,
          semanticLocator: match.semanticLocator,
          state: match.state,
          actions: match.actions,
          frame: reference.frameTargetId ?? 'main',
        },
      ]);
      return observations.some((observation) => observation.ref === ref);
    } catch {
      return false;
    }
  }

  #sessionForReference(
    snapshot: BrowserSessionSnapshot,
    reference: ResolvedElementRef,
  ): DebuggerSession {
    if (reference.frameTargetId === null) return snapshot.root;
    const session = snapshot.children.get(reference.frameTargetId)?.session;
    if (!session) throw new ElementRefStoreError('STALE_REF', 'The element ref is stale.');
    return session;
  }

  #loaderForFrame(frameTree: Protocol.Page.FrameTree, frameId: string): string | undefined {
    if (frameTree.frame.id === frameId) return frameTree.frame.loaderId;
    for (const child of frameTree.childFrames ?? []) {
      const loaderId = this.#loaderForFrame(child, frameId);
      if (loaderId) return loaderId;
    }
    return undefined;
  }

  async #editorTargetInfo(target: PreparedElementTarget): Promise<EditorTargetInfo> {
    let objectId: string | undefined;
    try {
      const resolved = await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
        target.session,
        'DOM.resolveNode',
        { backendNodeId: target.reference.backendNodeId },
      );
      objectId = resolved.object.objectId;
      if (!objectId) return { editor: false, custom: false, value: '' };
      const response =
        await this.#dependencies.transport.send<Protocol.Runtime.CallFunctionOnResponse>(
          target.session,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: EDITOR_TARGET_INFO_FUNCTION,
            awaitPromise: false,
            returnByValue: true,
          },
        );
      const value = response.result.value as
        | {
            readonly editor?: unknown;
            readonly custom?: unknown;
            readonly value?: unknown;
          }
        | undefined;
      return {
        editor: response.exceptionDetails === undefined && value?.editor === true,
        custom: response.exceptionDetails === undefined && value?.custom === true,
        value: typeof value?.value === 'string' ? value.value.slice(0, 20_000) : '',
      };
    } catch {
      return { editor: false, custom: false, value: '' };
    } finally {
      if (objectId) {
        await this.#dependencies.transport
          .send(target.session, 'Runtime.releaseObject', { objectId })
          .catch(() => undefined);
      }
    }
  }

  async #scrollElement(
    target: PreparedElementTarget,
    deltaX: number,
    deltaY: number,
  ): Promise<
    | {
        readonly beforeX: number;
        readonly beforeY: number;
        readonly afterX: number;
        readonly afterY: number;
        readonly maxX: number;
        readonly maxY: number;
      }
    | undefined
  > {
    let objectId: string | undefined;
    try {
      const resolved = await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
        target.session,
        'DOM.resolveNode',
        { backendNodeId: target.reference.backendNodeId },
      );
      objectId = resolved.object.objectId;
      if (!objectId) return undefined;
      const response =
        await this.#dependencies.transport.send<Protocol.Runtime.CallFunctionOnResponse>(
          target.session,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: SCROLL_ELEMENT_FUNCTION,
            arguments: [{ value: deltaX }, { value: deltaY }],
            awaitPromise: false,
            returnByValue: true,
            silent: true,
          },
        );
      const result = response.result.value as
        | {
            readonly found?: unknown;
            readonly beforeX?: unknown;
            readonly beforeY?: unknown;
            readonly afterX?: unknown;
            readonly afterY?: unknown;
            readonly maxX?: unknown;
            readonly maxY?: unknown;
          }
        | undefined;
      if (response.exceptionDetails !== undefined || result?.found !== true) return undefined;
      const values = [
        result.beforeX,
        result.beforeY,
        result.afterX,
        result.afterY,
        result.maxX,
        result.maxY,
      ];
      if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        return undefined;
      }
      return {
        beforeX: result.beforeX as number,
        beforeY: result.beforeY as number,
        afterX: result.afterX as number,
        afterY: result.afterY as number,
        maxX: result.maxX as number,
        maxY: result.maxY as number,
      };
    } catch {
      return undefined;
    } finally {
      if (objectId) {
        await this.#dependencies.transport
          .send(target.session, 'Runtime.releaseObject', { objectId })
          .catch(() => undefined);
      }
    }
  }

  async #performPageAction(
    call: ParsedBrowserToolCall,
    tabId: number,
  ): Promise<Awaited<ReturnType<BrowserPageActionPort['performAction']>> | null> {
    const page = this.#dependencies.page;
    if (!page) return null;
    switch (call.operation) {
      case 'click': {
        const { ref, button, count } = input<{
          ref: string;
          button: 'left' | 'right' | 'middle';
          count: 1 | 2;
        }>(call);
        if (!ref.startsWith('page_')) return null;
        return page.performAction(tabId, {
          action: 'click',
          ref,
          button,
          count,
        });
      }
      case 'type': {
        const { ref, text, replace, submit } = input<{
          ref: string;
          text: string;
          replace: boolean;
          submit: boolean;
        }>(call);
        if (!ref.startsWith('page_')) return null;
        return page.performAction(tabId, {
          action: 'type',
          ref,
          text,
          replace,
          submit,
        });
      }
      case 'scroll': {
        const { target, deltaX, deltaY } = input<{
          target: string;
          deltaX: number;
          deltaY: number;
        }>(call);
        if (target !== 'viewport' && !target.startsWith('page_')) return null;
        return page.performAction(tabId, {
          action: 'scroll',
          target,
          deltaX,
          deltaY,
        });
      }
      case 'select': {
        const { ref, value } = input<{ ref: string; value: string }>(call);
        if (!ref.startsWith('page_')) return null;
        return page.performAction(tabId, { action: 'select', ref, value });
      }
      default:
        return null;
    }
  }

  async #showPointer(tabId: number, to: Point, from: Point, effect: PointerEffect): Promise<void> {
    try {
      const feedback = this.#dependencies.pointer
        .show(tabId, {
          x: to.x,
          y: to.y,
          fromX: from.x,
          fromY: from.y,
          effect,
        })
        .catch(() => undefined);
      let deadline: ReturnType<typeof globalThis.setTimeout> | undefined;
      try {
        await Promise.race([
          feedback,
          new Promise<void>((resolve) => {
            deadline = globalThis.setTimeout(resolve, POINTER_FEEDBACK_DEADLINE_MS);
          }),
        ]);
      } finally {
        if (deadline !== undefined) globalThis.clearTimeout(deadline);
      }
    } catch {
      // Pointer feedback is best-effort and must never cause an action retry.
    }
  }

  #getPrimaryModifier(): Promise<number> {
    this.#primaryModifier ??= this.#dependencies.platform
      .getOs()
      .then((os) => (os === 'mac' ? 4 : 2));
    return this.#primaryModifier;
  }

  async #selectAll(session: DebuggerSession): Promise<void> {
    const modifiers = await this.#getPrimaryModifier();
    await this.#dependencies.transport.send(session, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      modifiers,
      windowsVirtualKeyCode: 65,
      commands: ['selectAll'],
    });
    await this.#dependencies.transport.send(session, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers,
      windowsVirtualKeyCode: 65,
    });
  }

  async #insertFocusedText(
    session: DebuggerSession,
    text: string,
    replace: boolean,
    customEditor: boolean,
    target: PreparedElementTarget | null,
  ): Promise<void> {
    const objectId = target
      ? (
          await this.#dependencies.transport.send<Protocol.DOM.ResolveNodeResponse>(
            target.session,
            'DOM.resolveNode',
            { backendNodeId: target.reference.backendNodeId },
          )
        ).object.objectId
      : (
          await this.#dependencies.transport.send<Protocol.Runtime.EvaluateResponse>(
            session,
            'Runtime.evaluate',
            { expression: 'globalThis' },
          )
        ).result.objectId;
    if (!objectId) {
      throw new BrowserActionError(
        'TYPE_VERIFICATION_FAILED',
        'The focused editor could not receive the requested text.',
        'insert',
      );
    }
    try {
      const response =
        await this.#dependencies.transport.send<Protocol.Runtime.CallFunctionOnResponse>(
          session,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: INSERT_FOCUSED_TEXT_FUNCTION,
            arguments: [{ value: text }, { value: replace }, { value: customEditor }],
            awaitPromise: false,
            returnByValue: true,
            userGesture: true,
          },
        );
      const result = response.result.value as { readonly dispatched?: unknown } | undefined;
      if (response.exceptionDetails || result?.dispatched !== true) {
        throw new BrowserActionError(
          'TYPE_VERIFICATION_FAILED',
          'The focused editor could not receive the requested text.',
          'insert',
        );
      }
    } finally {
      await this.#dependencies.transport
        .send(session, 'Runtime.releaseObject', { objectId })
        .catch(() => undefined);
    }
  }

  async #verifyTrustedInput(
    session: DebuggerSession,
    text: string,
    replace: boolean,
    before: string,
    signal: AbortSignal,
    target: PreparedElementTarget | null,
  ): Promise<string> {
    await this.#selectAll(session);
    const expected = normalizeInputValue(text);
    let verified = false;
    let verifiedValue: string | null = null;
    const settleDeadline = Date.now() + INPUT_SETTLE_TIMEOUT_MS;
    try {
      do {
        if (target) {
          const exact = await this.#editorTargetInfo(target);
          const candidate = normalizeInputValue(exact.value);
          verified = verifiesInput(candidate, expected, replace, before);
          if (verified) verifiedValue = candidate;
        }
        try {
          if (!verified) {
            const response =
              await this.#dependencies.transport.send<Protocol.Runtime.EvaluateResponse>(
                session,
                'Runtime.evaluate',
                {
                  expression: FOCUSED_EDITABLE_VALUE_EXPRESSION,
                  returnByValue: true,
                },
              );
            const candidate = evaluatedEditableValue(response);
            verified = verifiesInput(candidate, expected, replace, before);
            if (verified) verifiedValue = candidate ?? before;
          }
        } catch {
          // Some targets do not expose a usable main execution context; AX remains the fallback.
        }
        if (!verified) {
          const tree =
            await this.#dependencies.transport.send<Protocol.Accessibility.GetFullAXTreeResponse>(
              session,
              'Accessibility.getFullAXTree',
            );
          const candidate = focusedEditableValue(tree.nodes);
          verified = verifiesInput(candidate, expected, replace, before);
          if (verified) verifiedValue = candidate ?? before;
        }
        if (verified || Date.now() >= settleDeadline) break;
        await this.#delay(Math.min(INPUT_POLL_INTERVAL_MS, settleDeadline - Date.now()), signal);
      } while (!verified);
      if (!verified) {
        throwIfAborted(signal);
      }
    } finally {
      await this.#dispatchKey(session, {
        kind: 'key',
        key: 'ArrowRight',
        code: 'ArrowRight',
        modifiers: 0,
      });
    }
    if (!verified) {
      throw new BrowserActionError(
        'TYPE_VERIFICATION_FAILED',
        'The focused editable value did not contain the requested input.',
        'readback',
      );
    }
    return verifiedValue ?? before;
  }

  /** Requires submitted text to leave the editable surface before reporting mutation success. */
  async #verifySubmittedInput(
    session: DebuggerSession,
    text: string,
    signal: AbortSignal,
    target: PreparedElementTarget | null,
  ): Promise<void> {
    if (text.length === 0) return;
    const expected = text.replace(/\r\n?/g, '\n');
    const settleDeadline = Date.now() + INPUT_SETTLE_TIMEOUT_MS;
    let polling = true;
    do {
      throwIfAborted(signal);
      let observed: string | null = null;
      let observable = false;
      if (target) {
        try {
          const exact = await this.#editorTargetInfo(target);
          if (exact.connected === false) return;
          observed = exact.value.replace(/\r\n?/g, '\n');
          observable = true;
        } catch {
          return;
        }
      } else {
        try {
          const response =
            await this.#dependencies.transport.send<Protocol.Runtime.EvaluateResponse>(
              session,
              'Runtime.evaluate',
              {
                expression: FOCUSED_EDITABLE_VALUE_EXPRESSION,
                returnByValue: true,
              },
            );
          observed = evaluatedEditableValue(response);
          observable = observed !== null;
        } catch {
          // The focused AX editable remains the fallback when the page realm is unavailable.
        }
        if (!observable) {
          try {
            const tree =
              await this.#dependencies.transport.send<Protocol.Accessibility.GetFullAXTreeResponse>(
                session,
                'Accessibility.getFullAXTree',
              );
            observed = focusedEditableValue(tree.nodes);
            observable = observed !== null;
          } catch {
            return;
          }
        }
      }
      if (!observable || !verifiesReplacement(observed, expected)) return;
      if (Date.now() >= settleDeadline) {
        polling = false;
      } else {
        await this.#delay(Math.min(INPUT_POLL_INTERVAL_MS, settleDeadline - Date.now()), signal);
      }
    } while (polling);
    throw new BrowserActionError(
      'ACTION_STATE_MISMATCH',
      'The submitted editable still contains the requested text.',
      'submit',
    );
  }

  async #click(
    session: DebuggerSession,
    point: Point,
    button: 'left' | 'right' | 'middle',
    count: 1 | 2,
  ): Promise<void> {
    await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
    });
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
      await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        clickCount,
      });
    }
  }

  async #drag(session: DebuggerSession, from: Point, to: Point): Promise<void> {
    await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x,
      y: from.y,
      button: 'none',
    });
    await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      clickCount: 1,
    });
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
        button: 'left',
        buttons: 1,
      });
    }
    await this.#dependencies.transport.send(session, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      clickCount: 1,
    });
  }

  async #dispatchKey(
    session: DebuggerSession,
    chord: Extract<ParsedKeyChord, { readonly kind: 'key' }>,
  ): Promise<void> {
    const virtualKeyCode = (() => {
      if (chord.code === 'Enter') return 13;
      if (chord.code === 'Tab') return 9;
      if (chord.code === 'Escape') return 27;
      if (chord.code === 'Space') return 32;
      if (chord.code === 'Backspace') return 8;
      if (chord.code === 'Delete') return 46;
      if (chord.code.startsWith('Key') && chord.code.length === 4) {
        return chord.code.charCodeAt(3);
      }
      if (chord.code.startsWith('Digit') && chord.code.length === 6) {
        return chord.code.charCodeAt(5);
      }
      return undefined;
    })();
    const text = chord.modifiers === 0 && chord.key === 'Enter' ? '\r' : undefined;
    await this.#dependencies.transport.send(session, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: chord.key,
      code: chord.code,
      modifiers: chord.modifiers,
      ...(virtualKeyCode === undefined
        ? {}
        : {
            windowsVirtualKeyCode: virtualKeyCode,
            nativeVirtualKeyCode: virtualKeyCode,
          }),
      ...(text === undefined ? {} : { text, unmodifiedText: text }),
    });
    await this.#dependencies.transport.send(session, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: chord.key,
      code: chord.code,
      modifiers: chord.modifiers,
      ...(virtualKeyCode === undefined
        ? {}
        : {
            windowsVirtualKeyCode: virtualKeyCode,
            nativeVirtualKeyCode: virtualKeyCode,
          }),
    });
  }

  async #navigateHistory(session: DebuggerSession, direction: 'back' | 'forward'): Promise<void> {
    const history =
      await this.#dependencies.transport.send<Protocol.Page.GetNavigationHistoryResponse>(
        session,
        'Page.getNavigationHistory',
      );
    const index = history.currentIndex + (direction === 'back' ? -1 : 1);
    const entry = history.entries[index];
    if (!entry)
      throw new BrowserActionError('HISTORY_UNAVAILABLE', 'Browser history is unavailable.');
    await this.#dependencies.transport.send(session, 'Page.navigateToHistoryEntry', {
      entryId: entry.id,
    });
  }

  async #viewport(
    session: DebuggerSession,
  ): Promise<{ width: number; height: number; pageX: number; pageY: number }> {
    const metrics = await this.#dependencies.transport.send<Protocol.Page.GetLayoutMetricsResponse>(
      session,
      'Page.getLayoutMetrics',
    );
    return {
      width: metrics.visualViewport.clientWidth,
      height: metrics.visualViewport.clientHeight,
      pageX: metrics.visualViewport.pageX,
      pageY: metrics.visualViewport.pageY,
    };
  }

  async #scrollPosition(session: DebuggerSession): Promise<Point> {
    const viewport = await this.#viewport(session);
    return { x: viewport.pageX, y: viewport.pageY };
  }

  async #waitForScrollPosition(
    session: DebuggerSession,
    before: Point,
    signal: AbortSignal,
  ): Promise<Point> {
    let current = await this.#scrollPosition(session);
    for (
      let attempt = 0;
      attempt < 4 && current.x === before.x && current.y === before.y;
      attempt += 1
    ) {
      await this.#delay(25, signal);
      current = await this.#scrollPosition(session);
    }
    return current;
  }

  async #validatePoint(session: DebuggerSession, point: Point): Promise<void> {
    const viewport = await this.#viewport(session);
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) {
      throw new BrowserActionError(
        'POINT_OUT_OF_VIEWPORT',
        'The screenshot point is outside the current viewport.',
      );
    }
  }

  async #wait(
    snapshot: BrowserSessionSnapshot,
    condition: 'load' | 'network_idle' | 'dom_stable' | 'delay',
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (condition === 'delay') {
      await this.#delay(timeoutMs, signal);
      return;
    }
    if (condition === 'load') {
      const ready = await this.#dependencies.transport.send<Protocol.Runtime.EvaluateResponse>(
        snapshot.root,
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
      );
      if (ready.result.value === 'complete') return;
      await this.#waitForEvents(snapshot.root, timeoutMs, signal, ['Page.loadEventFired'], 0);
      return;
    }
    const network = condition === 'network_idle';
    if (network) {
      await this.#waitForNetworkIdle(
        [snapshot.root, ...[...snapshot.children.values()].map(({ session }) => session)],
        timeoutMs,
        signal,
      );
      return;
    }
    await this.#waitForEvents(
      snapshot.root,
      timeoutMs,
      signal,
      [
        'DOM.documentUpdated',
        'DOM.attributeModified',
        'DOM.childNodeInserted',
        'DOM.childNodeRemoved',
      ],
      500,
    );
  }

  #waitForNetworkIdle(
    sessions: readonly DebuggerSession[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionKey = ({ tabId, sessionId }: DebuggerSession): string =>
      `${String(tabId)}:${sessionId ?? 'root'}`;
    const sessionKeys = new Set(sessions.map(sessionKey));
    const inFlight = new Set<string>();
    return new Promise((resolve, reject) => {
      let done = false;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timeoutTimer);
        if (quietTimer) clearTimeout(quietTimer);
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const scheduleQuiet = (): void => {
        if (inFlight.size > 0 || done) return;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), 500);
      };
      const unsubscribe = this.#dependencies.transport.onEvent((source, method, params) => {
        const sourceKey = sessionKey(source);
        if (!sessionKeys.has(sourceKey)) return;
        const requestId = params.requestId;
        if (typeof requestId !== 'string' || requestId.length === 0) return;
        const requestKey = `${sourceKey}:${requestId}`;
        if (method === 'Network.requestWillBeSent') {
          inFlight.add(requestKey);
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = undefined;
          return;
        }
        if (method !== 'Network.loadingFinished' && method !== 'Network.loadingFailed') return;
        inFlight.delete(requestKey);
        scheduleQuiet();
      });
      const onAbort = (): void =>
        finish(new DOMException('Browser wait was aborted.', 'AbortError'));
      const timeoutTimer = setTimeout(
        () => finish(new BrowserActionError('WAIT_TIMEOUT', 'The browser wait timed out.')),
        timeoutMs,
      );
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.all(
        sessions.map((session) => this.#dependencies.transport.send(session, 'Network.enable')),
      ).then(scheduleQuiet, finish);
    });
  }

  #waitForEvents(
    session: DebuggerSession,
    timeoutMs: number,
    signal: AbortSignal,
    methods: readonly string[],
    quietMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        clearTimeout(timeoutTimer);
        if (quietTimer) clearTimeout(quietTimer);
        unsubscribe();
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const scheduleQuiet = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), quietMs);
      };
      const unsubscribe = this.#dependencies.transport.onEvent((source, method) => {
        if (
          source.tabId === session.tabId &&
          source.sessionId === session.sessionId &&
          methods.includes(method)
        ) {
          if (quietMs === 0) finish();
          else scheduleQuiet();
        }
      });
      const onAbort = () => finish(new DOMException('Browser wait was aborted.', 'AbortError'));
      const timeoutTimer = setTimeout(
        () => finish(new BrowserActionError('WAIT_TIMEOUT', 'The browser wait timed out.')),
        timeoutMs,
      );
      signal.addEventListener('abort', onAbort, { once: true });
      if (quietMs > 0) scheduleQuiet();
    });
  }

  #delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Browser delay was aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async #currentUrl(session: DebuggerSession): Promise<string | null> {
    try {
      const history =
        await this.#dependencies.transport.send<Protocol.Page.GetNavigationHistoryResponse>(
          session,
          'Page.getNavigationHistory',
        );
      return history.entries[history.currentIndex]?.url.slice(0, 4_096) ?? null;
    } catch {
      return null;
    }
  }
}
