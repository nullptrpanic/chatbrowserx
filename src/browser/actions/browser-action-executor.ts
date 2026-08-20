import type { Protocol } from 'devtools-protocol';
import type { ParsedBrowserToolCall } from '../../agent/tools/browser-tool-schema';
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
const SELECTION_SETTLE_TIMEOUT_MS = 1_500;
const SELECTION_POLL_INTERVAL_MS = 75;

const SELECT_FUNCTION = `function(value) {
  if (!(this instanceof HTMLSelectElement)) return { ok: false };
  this.value = value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: this.value };
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

const INSERT_FOCUSED_TEXT_FUNCTION = `function(text) {
  let element = this.document?.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  const window_ = element?.ownerDocument?.defaultView;
  if (
    element &&
    typeof window_?.HTMLTextAreaElement === 'function' &&
    element instanceof window_.HTMLTextAreaElement &&
    typeof window_.InputEvent === 'function'
  ) {
    element.value = text;
    const event = new window_.InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertFromPaste',
      data: text,
    });
    element.dispatchEvent(event);
    return {
      dispatched: true,
      strategy: 'input_from_paste',
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
  return { dispatched: true, strategy: 'synthetic_paste', defaultPrevented: event.defaultPrevented };
}`;

const EDITOR_TARGET_INFO_FUNCTION = `function() {
  const __chatbrowserxEditorTargetInfo = true;
  void __chatbrowserxEditorTargetInfo;
  const element = this;
  const window_ = element?.ownerDocument?.defaultView;
  if (!window_?.Element || !(element instanceof window_.Element)) {
    return { editor: false, value: '' };
  }
  let current = element;
  let editor = false;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const role = (current.getAttribute('role') || '').trim().toLowerCase();
    const roleDescription = (current.getAttribute('aria-roledescription') || '')
      .trim()
      .toLowerCase();
    const classHint = current.getAttribute('class') || '';
    if (
      role === 'code' ||
      role === 'application' ||
      roleDescription.includes('editor') ||
      classHint.split(/\\s+/).some((token) =>
        /(?:^|[-_])(editor|monaco|codemirror|ace)(?:$|[-_])/i.test(token)
      )
    ) {
      editor = true;
      break;
    }
    const root = current.getRootNode();
    current = current.parentElement || (window_.ShadowRoot && root instanceof window_.ShadowRoot
      ? root.host
      : null);
  }
  const value = typeof element.value === 'string'
    ? element.value
    : (element.innerText || element.textContent || '');
  return { editor, value };
}`;

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

  constructor(code: BrowserActionErrorCode, message: string) {
    super(message);
    this.name = 'BrowserActionError';
    this.code = code;
  }
}

export interface BrowserActionExecutorDependencies {
  readonly sessions: Pick<TargetSessionRegistry, 'ensure'>;
  readonly transport: DebuggerTransport;
  readonly refs: ElementRefStore;
  readonly pointer: PointerPagePort;
  readonly platform: BrowserPlatformPort;
  readonly page?: BrowserPageActionPort;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Browser action was aborted.', 'AbortError');
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

function focusedEditableValue(nodes: readonly Protocol.Accessibility.AXNode[]): string | null {
  const editable = nodes.filter((node) => {
    if (node.ignored) return false;
    const role = axValue(node.role)?.toLowerCase();
    return (
      role === 'textbox' ||
      role === 'searchbox' ||
      (node.properties ?? []).some(
        (property) => property.name === 'editable' && axBoolean(property.value),
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

function verifiesInput(actual: string | null, expected: string, replace: boolean, before: string) {
  return replace
    ? actual === expected
    : expected.length === 0 || (actual !== null && actual !== before && actual.includes(expected));
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
              valueLength: typeof pageResult.value === 'string' ? pageResult.value.length : 0,
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

    switch (call.operation) {
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
        const target = await this.#prepareElementTarget(snapshot, value.ref, tabId);
        const before = await this.#readRefStates(target, tabId, value.ref);
        const beforeTarget = before.target;
        const role = beforeTarget?.role ?? target.reference.role;
        if (!target.reference.actions.includes('set_checked')) {
          throw new BrowserActionError(
            'UNSUPPORTED_ACTION',
            'The ref does not advertise set_checked.',
          );
        }
        if (role === 'radio' && !value.checked) {
          throw new BrowserActionError(
            'UNSUPPORTED_ACTION',
            'A radio target can only be selected; choose another radio to clear it.',
          );
        }
        const current = readSelectionState(beforeTarget?.state ?? target.reference.state);
        let dispatched = false;
        let strategy = 'already_set';
        let after = before;
        if (current !== value.checked && !(current === undefined && !value.checked)) {
          const actionPoint = await this.#actionablePoint(target);
          await this.#showPointer(tabId, actionPoint, actionPoint, 'click');
          await this.#click(target.session, actionPoint, 'left', 1);
          dispatched = true;
          strategy = 'pointer';
          after = await this.#waitForSelectionState(
            target,
            tabId,
            value.ref,
            value.checked,
            signal,
          );
          const afterPointerState = readSelectionState(after.target?.state ?? []);
          if (
            afterPointerState !== undefined &&
            afterPointerState !== value.checked &&
            !after.rebound &&
            (await this.#clickElementByRef(snapshot, tabId, value.ref))
          ) {
            strategy = 'dom_fallback';
            after = await this.#waitForSelectionState(
              target,
              tabId,
              value.ref,
              value.checked,
              signal,
            );
          }
        }
        observedTarget = after.target ?? beforeTarget;
        stateChanges = after.changes;
        targetState = observedTarget?.state;
        const actual = readSelectionState(targetState ?? []);
        const verified = actual === value.checked;
        if (!verified) {
          throw new BrowserActionError(
            'ACTION_STATE_MISMATCH',
            actual === undefined
              ? 'The requested selection state could not be observed.'
              : 'The requested selection state did not settle.',
          );
        }
        data = {
          action: 'set_checked',
          dispatched,
          requested: value.checked,
          verified,
          strategy,
        };
        targetPresent = observedTarget !== undefined;
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
          if (trustedInput) await this.#insertFocusedText(targetSession, value.text);
          else {
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
          await this.#verifyTrustedInput(
            targetSession,
            value.text,
            value.replace,
            before.replace(/\r\n?/g, '\n'),
          );
        } else if (target) {
          const before = editorInfo?.value.replace(/\r\n?/g, '\n') ?? '';
          const observed = await this.#editorTargetInfo(target);
          if (
            !verifiesInput(
              observed.value.replace(/\r\n?/g, '\n'),
              value.text,
              value.replace,
              before,
            )
          ) {
            throw new BrowserActionError(
              'TYPE_VERIFICATION_FAILED',
              'The target did not retain the requested text.',
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
        }
        data = {
          action: 'type',
          dispatched: true,
          replaced: value.replace,
          submitted: value.submit,
          strategy: trustedInput ? 'trusted_input' : 'cdp_ref',
          verified: true,
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
      throw new ElementRefStoreError('STALE_REF', 'The element ref is stale.');
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
      if (!objectId) return { editor: false, value: '' };
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
        { readonly editor?: unknown; readonly value?: unknown } | undefined;
      return {
        editor: response.exceptionDetails === undefined && value?.editor === true,
        value: typeof value?.value === 'string' ? value.value.slice(0, 20_000) : '',
      };
    } catch {
      return { editor: false, value: '' };
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

  async #insertFocusedText(session: DebuggerSession, text: string): Promise<void> {
    const global = await this.#dependencies.transport.send<Protocol.Runtime.EvaluateResponse>(
      session,
      'Runtime.evaluate',
      { expression: 'globalThis' },
    );
    const objectId = global.result.objectId;
    if (!objectId) {
      throw new BrowserActionError(
        'TYPE_VERIFICATION_FAILED',
        'The focused editor could not receive the requested text.',
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
            arguments: [{ value: text }],
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
  ): Promise<void> {
    await this.#selectAll(session);
    const expected = text.replace(/\r\n?/g, '\n');
    let verified = false;
    try {
      try {
        const response = await this.#dependencies.transport.send<Protocol.Runtime.EvaluateResponse>(
          session,
          'Runtime.evaluate',
          {
            expression: FOCUSED_EDITABLE_VALUE_EXPRESSION,
            returnByValue: true,
          },
        );
        verified = verifiesInput(evaluatedEditableValue(response), expected, replace, before);
      } catch {
        // Some targets do not expose a usable main execution context; AX remains the fallback.
      }
      if (!verified) {
        const tree =
          await this.#dependencies.transport.send<Protocol.Accessibility.GetFullAXTreeResponse>(
            session,
            'Accessibility.getFullAXTree',
          );
        verified = verifiesInput(focusedEditableValue(tree.nodes), expected, replace, before);
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
      );
    }
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
    await this.#dependencies.transport.send(session, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: chord.key,
      code: chord.code,
      modifiers: chord.modifiers,
    });
    await this.#dependencies.transport.send(session, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: chord.key,
      code: chord.code,
      modifiers: chord.modifiers,
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
