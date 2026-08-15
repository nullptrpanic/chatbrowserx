import type {
  FrameSegment,
  ObservedElement,
  ObservedFrame,
  PageObservation,
  ShadowSegment,
  TextRegion,
  ViewportState,
} from '../contracts/observation';
import {
  createShadowSegment,
  getAccessibleName,
  getAncestorHint,
  getAssociatedLabel,
  getElementRole,
  getElementState,
  getElementValue,
  getStableAttributes,
  normalizeText,
} from './dom-semantics';
import { DEFAULT_OBSERVATION_LIMITS, type ObservationLimits } from './observation-limits';
import { isElementObscured, isElementVisible, toRect } from './visibility';

export interface ObserveDocumentOptions {
  readonly id?: string;
  readonly capturedAt?: number;
  readonly tabId?: number;
  readonly url?: string;
  readonly viewport?: ViewportState;
  readonly limits?: ObservationLimits;
}

interface TraversalState {
  readonly observationId: string;
  readonly viewport: ViewportState;
  readonly limits: ObservationLimits;
  readonly elements: ObservedElement[];
  readonly textRegions: TextRegion[];
  readonly frames: ObservedFrame[];
  readonly ancestorHints: WeakMap<Element, string | null>;
  readonly bindings: Map<string, Element>;
  textCharacters: number;
  truncated: boolean;
}

interface TraversalContext {
  readonly framePath: readonly FrameSegment[];
  readonly shadowPath: readonly ShadowSegment[];
  readonly depth: number;
}

const textRegionTags = new Set([
  'article',
  'blockquote',
  'caption',
  'dd',
  'dt',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
  'td',
  'th',
]);

/**
 * Reads a frame origin without throwing when its URL is absent or opaque.
 */
function readOrigin(url: string | null): string | null {
  if (url === null) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Creates default viewport state from the document window without scrolling it.
 */
function readViewport(document: Document): ViewportState {
  const view = document.defaultView;
  return {
    width: view?.innerWidth ?? 0,
    height: view?.innerHeight ?? 0,
    scrollX: view?.scrollX ?? 0,
    scrollY: view?.scrollY ?? 0,
  };
}

/**
 * Reads an iframe document and URL together while containing cross-origin access failures.
 */
function readFrame(element: HTMLIFrameElement): {
  readonly document: Document | null;
  readonly url: string | null;
} {
  try {
    const frameDocument = element.contentDocument;
    return {
      document: frameDocument,
      url: (frameDocument?.location.href ?? element.src) || null,
    };
  } catch {
    return { document: null, url: element.src || null };
  }
}

/**
 * Appends one bounded text region and records when a count or character cap truncates it.
 */
function collectTextRegion(
  element: Element,
  context: TraversalContext,
  state: TraversalState,
): void {
  if (!textRegionTags.has(element.tagName.toLowerCase())) return;
  const text = normalizeText(element.textContent, state.limits.normalizedTextCharacters);
  if (text.length === 0) return;
  if (state.textRegions.length >= state.limits.textRegions) {
    state.truncated = true;
    return;
  }

  const available = state.limits.normalizedTextCharacters - state.textCharacters;
  if (available <= 0) {
    state.truncated = true;
    return;
  }
  const boundedText = text.slice(0, available);
  if (boundedText.length < text.length) state.truncated = true;
  state.textRegions.push({
    kind: element.tagName.toLowerCase(),
    text: boundedText,
    framePath: context.framePath.map((segment) => ({ ...segment })),
    rect: toRect(element.getBoundingClientRect()),
  });
  state.textCharacters += boundedText.length;
}

/**
 * Appends one visible semantic element while preserving the hard interactive-element cap.
 */
function collectSemanticElement(
  element: Element,
  context: TraversalContext,
  state: TraversalState,
): void {
  const role = getElementRole(element);
  if (role === null) return;
  if (state.elements.length >= state.limits.interactiveElements) {
    state.truncated = true;
    return;
  }

  const label = getAssociatedLabel(element);
  const rect = toRect(element.getBoundingClientRect());
  const observationRef = `${state.observationId}:element:${String(state.elements.length)}`;
  state.elements.push({
    observationRef,
    framePath: context.framePath.map((segment) => ({ ...segment })),
    shadowPath: context.shadowPath.map((segment) => ({
      ...segment,
      stableAttributes: { ...segment.stableAttributes },
    })),
    role,
    name: getAccessibleName(element, label),
    label,
    text: normalizeText(element.textContent) || null,
    value: getElementValue(element),
    stableAttributes: getStableAttributes(element),
    ancestorHint: getAncestorHint(element, state.ancestorHints),
    state: getElementState(element),
    rect,
    visible: true,
    obscured: isElementObscured(element, rect),
    backendNodeId: null,
    cdpSessionId: null,
  });
  state.bindings.set(observationRef, element);
}

/**
 * Traverses an element, its open Shadow Root, and accessible frame document in composed order.
 */
function traverseElement(element: Element, context: TraversalContext, state: TraversalState): void {
  if (context.depth > state.limits.depth) {
    state.truncated = true;
    return;
  }

  const visible = isElementVisible(element, state.viewport);
  if (visible) {
    collectTextRegion(element, context, state);
    collectSemanticElement(element, context, state);
  }

  if (element.tagName === 'IFRAME') {
    const index = state.frames.length;
    const frameElement = element as HTMLIFrameElement;
    const frame = readFrame(frameElement);
    const segment: FrameSegment = {
      index,
      name: normalizeText(frameElement.name) || null,
      title: normalizeText(frameElement.title) || null,
      origin: readOrigin(frame.url),
    };
    const framePath = [...context.framePath, segment];
    state.frames.push({
      path: framePath,
      name: segment.name,
      title: segment.title,
      url: frame.url,
      accessible: frame.document !== null,
      rect: toRect(element.getBoundingClientRect()),
    });
    if (frame.document?.documentElement !== undefined) {
      traverseElement(
        frame.document.documentElement,
        { framePath, shadowPath: [], depth: context.depth + 1 },
        state,
      );
    }
  }

  if (element.shadowRoot !== null) {
    const shadowPath = [...context.shadowPath, createShadowSegment(element)];
    for (const child of element.shadowRoot.children) {
      traverseElement(
        child,
        { framePath: context.framePath, shadowPath, depth: context.depth + 1 },
        state,
      );
    }
  }

  for (const child of element.children) {
    traverseElement(child, { ...context, depth: context.depth + 1 }, state);
  }
}

/**
 * Produces a bounded read-only semantic snapshot of one document and its accessible descendants.
 */
export function observeDocumentWithBindings(
  document: Document,
  options: ObserveDocumentOptions = {},
): { readonly observation: PageObservation; readonly bindings: ReadonlyMap<string, Element> } {
  const observationId = options.id ?? `observation_${crypto.randomUUID()}`;
  const viewport = options.viewport ?? readViewport(document);
  const state: TraversalState = {
    observationId,
    viewport,
    limits: options.limits ?? DEFAULT_OBSERVATION_LIMITS,
    elements: [],
    textRegions: [],
    frames: [],
    ancestorHints: new WeakMap(),
    bindings: new Map(),
    textCharacters: 0,
    truncated: false,
  };

  if (document.documentElement !== null) {
    traverseElement(document.documentElement, { framePath: [], shadowPath: [], depth: 0 }, state);
  }

  return {
    observation: {
      id: observationId,
      capturedAt: options.capturedAt ?? Date.now(),
      tabId: options.tabId ?? -1,
      url: options.url ?? document.location.href,
      title: normalizeText(document.title, 500),
      viewport,
      textRegions: state.textRegions,
      elements: state.elements,
      frames: state.frames,
      truncated: state.truncated,
    },
    bindings: state.bindings,
  };
}

/** Produces the public serializable observation without exposing live DOM element bindings. */
export function observeDocument(
  document: Document,
  options: ObserveDocumentOptions = {},
): PageObservation {
  return observeDocumentWithBindings(document, options).observation;
}
