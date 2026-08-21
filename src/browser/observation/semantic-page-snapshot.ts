import type { Protocol } from 'devtools-protocol';
import { readSelectionState } from '../selection-state';

export const SEMANTIC_SNAPSHOT_STYLES = [
  'cursor',
  'display',
  'visibility',
  'pointer-events',
  'overflow-x',
  'overflow-y',
] as const;

export type SemanticAction = 'click' | 'set_checked' | 'type' | 'select' | 'scroll';

export interface SemanticPageEntry {
  readonly depth: number;
  readonly role: string;
  readonly name: string;
  readonly targetIndex?: number;
  readonly state?: readonly string[];
  readonly actions?: readonly SemanticAction[];
  readonly frame?: string;
  /** Internal selection evidence only; compact model entries never serialize geometry. */
  readonly inViewport?: boolean;
}

export interface SemanticPageTarget {
  readonly backendNodeId: number;
  readonly stateBackendNodeId?: number;
  readonly documentFrameId: string;
  readonly role: string;
  readonly name: string;
  readonly semanticLocator: string;
  readonly state: readonly string[];
  readonly actions: readonly SemanticAction[];
}

export interface SemanticPageSnapshot {
  readonly entries: readonly SemanticPageEntry[];
  readonly targets: readonly SemanticPageTarget[];
  readonly hasVisualSurface: boolean;
}

interface BuildSemanticPageSnapshotInput {
  readonly axNodes: readonly Protocol.Accessibility.AXNode[];
  readonly domSnapshot: Protocol.DOMSnapshot.CaptureSnapshotResponse;
  readonly frame: string;
  readonly viewport?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

interface SnapshotDomNode {
  readonly backendNodeId: number;
  readonly documentFrameId: string;
  readonly nodeName: string;
  readonly ownText: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly clickable: boolean;
  readonly inputChecked: boolean;
  readonly optionSelected: boolean;
  readonly cursor: string;
  readonly visible: boolean;
  readonly scrollableX: boolean;
  readonly scrollableY: boolean;
  readonly bounds?: readonly [number, number, number, number];
  parent: SnapshotDomNode | null;
  readonly children: SnapshotDomNode[];
}

const CLICK_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'option',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
]);
const EDITABLE_ROLES = new Set(['searchbox', 'textbox']);
const OMITTED_ROLES = new Set(['inlinetextbox', 'none', 'presentation', 'rootwebarea', 'webarea']);
const UNSAFE_CLICK_NODE_NAMES = new Set(['#DOCUMENT', 'HTML', 'BODY', 'HEAD']);
const STATE_ATTRIBUTES = ['checked', 'selected', 'expanded', 'pressed', 'disabled'] as const;
const ARIA_STATE_ATTRIBUTES = [...STATE_ATTRIBUTES, 'readonly'] as const;
const MODEL_AX_STATES = new Set([
  ...STATE_ATTRIBUTES,
  'busy',
  'focused',
  'invalid',
  'readonly',
  'required',
]);
const PURE_CLASS_STATE_PATTERN =
  /^(?:(?:is|state)[-_])?(checked|selected|active|disabled)(?:$|[-_])/i;
const EXPLICIT_CLASS_STATE_PATTERN = /(?:^|[-_])(checked|selected|disabled)(?:$|[-_])/i;
const ACTIVE_CLASS_STATE_PATTERN = /(?:^|[-_])active(?:$|[-_])/i;
const SELECTABLE_ROLES = new Set(['checkbox', 'option', 'radio', 'switch']);
const SELECTABLE_CLASS_PATTERN = /(?:^|[-_])(checkbox|radio|switch)(?:$|[-_])/i;
const EXPLICIT_OPTION_CLASS_PATTERN = /(?:^|[-_])(choice|option)(?:$|[-_])/i;
const AMBIGUOUS_OPTION_CLASS_PATTERN = /(?:^|[-_])answer(?:$|[-_])/i;
const DIRECT_VISUAL_SURFACE_NODE_NAMES = new Set(['CANVAS', 'VIDEO']);
const LARGE_VISUAL_SURFACE_NODE_NAMES = new Set(['IMG', 'SVG']);
const MAX_SEMANTIC_LOCATOR_CHARACTERS = 2_048;

function normalizedText(value: unknown, maximum = 500): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
}

function axText(value: Protocol.Accessibility.AXValue | undefined): string {
  return normalizedText(value?.value);
}

function axBoolean(value: Protocol.Accessibility.AXValue | undefined): boolean {
  return value?.value === true;
}

function normalizedStateValue(name: string, value: unknown): string | undefined {
  if (value === true || value === 'true' || value === 1) return name;
  if (value === false || value === 'false' || value === 0) return `${name}=false`;
  return typeof value === 'string' || typeof value === 'number'
    ? `${name}=${String(value).slice(0, 100)}`
    : undefined;
}

function axState(node: Protocol.Accessibility.AXNode): readonly string[] {
  const state: string[] = [];
  for (const property of node.properties ?? []) {
    if (!MODEL_AX_STATES.has(property.name)) continue;
    if (axBoolean(property.value)) {
      state.push(property.name);
      continue;
    }
    if (STATE_ATTRIBUTES.includes(property.name as (typeof STATE_ATTRIBUTES)[number])) {
      const value = normalizedStateValue(property.name, property.value.value);
      if (value) state.push(value);
    }
  }
  return uniqueState(state);
}

function uniqueState(values: readonly string[]): readonly string[] {
  const byName = new Map<string, string>();
  for (const value of values) {
    const name = value.split('=', 1)[0];
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, value);
  }
  return [...byName.values()].slice(0, 20);
}

function hasObservableSelectionState(state: readonly string[]): boolean {
  return state.some(
    (value) =>
      value === 'checked' ||
      value === 'checked=false' ||
      value === 'selected' ||
      value === 'selected=false',
  );
}

function mergedEntryName(current: string, incoming: string): string {
  if (current === incoming || current.includes(incoming)) return current;
  if (incoming.includes(current)) return incoming;
  return normalizedText(`${current} ${incoming}`);
}

function preferredEntryRole(current: string, incoming: string): string {
  const rank = (role: string): number => {
    if (role === 'statictext') return 0;
    if (role === 'generic') return 1;
    return 2;
  };
  return rank(incoming) > rank(current) ? incoming : current;
}

function compactTargetEntries(
  entries: readonly SemanticPageEntry[],
  targets: readonly SemanticPageTarget[],
): Pick<SemanticPageSnapshot, 'entries' | 'targets'> {
  const compactedEntries: SemanticPageEntry[] = [];
  const entryIndexByTarget = new Map<number, number>();

  for (const entry of entries) {
    const targetIndex = entry.targetIndex;
    if (targetIndex === undefined) {
      compactedEntries.push(entry);
      continue;
    }
    const existingIndex = entryIndexByTarget.get(targetIndex);
    if (existingIndex === undefined) {
      entryIndexByTarget.set(targetIndex, compactedEntries.length);
      compactedEntries.push(entry);
      continue;
    }
    const existing = compactedEntries[existingIndex];
    if (!existing) continue;
    compactedEntries[existingIndex] = {
      depth: Math.min(existing.depth, entry.depth),
      role: preferredEntryRole(existing.role, entry.role),
      name: mergedEntryName(existing.name, entry.name),
      targetIndex,
      ...((existing.state?.length ?? 0) + (entry.state?.length ?? 0) === 0
        ? {}
        : { state: uniqueState([...(existing.state ?? []), ...(entry.state ?? [])]) }),
      ...((existing.actions?.length ?? 0) + (entry.actions?.length ?? 0) === 0
        ? {}
        : {
            actions: [...new Set([...(existing.actions ?? []), ...(entry.actions ?? [])])],
          }),
      ...(existing.frame === undefined && entry.frame === undefined
        ? {}
        : { frame: existing.frame ?? entry.frame }),
      ...(existing.inViewport === undefined && entry.inViewport === undefined
        ? {}
        : { inViewport: existing.inViewport === true || entry.inViewport === true }),
    };
  }

  const compactedTargets = targets.map((target, targetIndex) => {
    const entryIndex = entryIndexByTarget.get(targetIndex);
    const entry = entryIndex === undefined ? undefined : compactedEntries[entryIndex];
    return entry === undefined
      ? target
      : {
          ...target,
          role: entry.role,
          name: entry.name,
          state: [...(entry.state ?? [])],
          actions: [...(entry.actions ?? [])],
        };
  });
  return { entries: compactedEntries, targets: compactedTargets };
}

function viewportMembership(
  node: SnapshotDomNode | undefined,
  viewport: BuildSemanticPageSnapshotInput['viewport'],
): boolean | undefined {
  if (!node?.bounds || !viewport) return undefined;
  const [x, y, width, height] = node.bounds;
  if (width <= 0 || height <= 0 || viewport.width <= 0 || viewport.height <= 0) return false;
  return (
    x + width > viewport.x &&
    y + height > viewport.y &&
    x < viewport.x + viewport.width &&
    y < viewport.y + viewport.height
  );
}

function isVisualSurface(node: SnapshotDomNode): boolean {
  if (!node.visible || node.bounds === undefined) return false;
  const [, , width, height] = node.bounds;
  if (DIRECT_VISUAL_SURFACE_NODE_NAMES.has(node.nodeName)) return width >= 8 && height >= 8;
  return LARGE_VISUAL_SURFACE_NODE_NAMES.has(node.nodeName) && width >= 240 && height >= 160;
}

function rareBooleanIndexes(value: Protocol.DOMSnapshot.RareBooleanData | undefined): Set<number> {
  return new Set(value?.index ?? []);
}

function stringAt(strings: readonly string[], index: number | undefined): string {
  return index === undefined ? '' : (strings[index] ?? '');
}

function tupleBounds(value: Protocol.DOMSnapshot.Rectangle | undefined) {
  if (
    !value ||
    value.length < 4 ||
    value.slice(0, 4).some((coordinate) => !Number.isFinite(coordinate))
  ) {
    return undefined;
  }
  const [x = 0, y = 0, width = 0, height = 0] = value;
  return [x, y, width, height] as const;
}

function parseAttributes(
  strings: readonly string[],
  encoded: Protocol.DOMSnapshot.ArrayOfStrings | undefined,
): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  for (let index = 0; index + 1 < (encoded?.length ?? 0); index += 2) {
    const name = stringAt(strings, encoded?.[index]).toLowerCase();
    if (name) attributes.set(name, stringAt(strings, encoded?.[index + 1]));
  }
  return attributes;
}

function snapshotDomNodes(
  snapshot: Protocol.DOMSnapshot.CaptureSnapshotResponse,
): ReadonlyMap<number, SnapshotDomNode> {
  const nodesByBackendId = new Map<number, SnapshotDomNode>();
  for (const document_ of snapshot.documents) {
    const documentFrameId = stringAt(snapshot.strings, document_.frameId);
    const nodeTable = document_.nodes;
    const backendNodeIds = nodeTable.backendNodeId ?? [];
    const clickable = rareBooleanIndexes(nodeTable.isClickable);
    const inputChecked = rareBooleanIndexes(nodeTable.inputChecked);
    const optionSelected = rareBooleanIndexes(nodeTable.optionSelected);
    const layoutByNodeIndex = new Map<
      number,
      {
        readonly styles: readonly number[];
        readonly bounds?: readonly [number, number, number, number];
        readonly text: string;
        readonly scrollRect?: readonly [number, number, number, number];
        readonly clientRect?: readonly [number, number, number, number];
      }
    >();
    document_.layout.nodeIndex.forEach((nodeIndex, layoutIndex) => {
      const bounds = tupleBounds(document_.layout.bounds[layoutIndex]);
      const scrollRect = tupleBounds(document_.layout.scrollRects?.[layoutIndex]);
      const clientRect = tupleBounds(document_.layout.clientRects?.[layoutIndex]);
      layoutByNodeIndex.set(nodeIndex, {
        styles: document_.layout.styles[layoutIndex] ?? [],
        text: stringAt(snapshot.strings, document_.layout.text[layoutIndex]),
        ...(bounds ? { bounds } : {}),
        ...(scrollRect ? { scrollRect } : {}),
        ...(clientRect ? { clientRect } : {}),
      });
    });
    const documentNodes: SnapshotDomNode[] = [];
    for (let nodeIndex = 0; nodeIndex < backendNodeIds.length; nodeIndex += 1) {
      const backendNodeId = backendNodeIds[nodeIndex];
      if (backendNodeId === undefined || !Number.isInteger(backendNodeId)) continue;
      const layout = layoutByNodeIndex.get(nodeIndex);
      const styles = Object.fromEntries(
        SEMANTIC_SNAPSHOT_STYLES.map((property, styleIndex) => [
          property,
          stringAt(snapshot.strings, layout?.styles[styleIndex]),
        ]),
      );
      const bounds = layout?.bounds;
      const overflowX = styles['overflow-x']?.trim().toLowerCase() ?? '';
      const overflowY = styles['overflow-y']?.trim().toLowerCase() ?? '';
      const scrollRect = layout?.scrollRect;
      const clientRect = layout?.clientRect;
      const scrollableOverflow = (value: string): boolean =>
        value === 'auto' || value === 'scroll' || value === 'overlay';
      const node: SnapshotDomNode = {
        backendNodeId,
        documentFrameId,
        nodeName: stringAt(snapshot.strings, nodeTable.nodeName?.[nodeIndex]).toUpperCase(),
        ownText: normalizedText(
          layout?.text || stringAt(snapshot.strings, nodeTable.nodeValue?.[nodeIndex]),
        ),
        attributes: parseAttributes(snapshot.strings, nodeTable.attributes?.[nodeIndex]),
        clickable: clickable.has(nodeIndex),
        inputChecked: inputChecked.has(nodeIndex),
        optionSelected: optionSelected.has(nodeIndex),
        cursor: styles.cursor ?? '',
        scrollableX:
          scrollableOverflow(overflowX) &&
          scrollRect !== undefined &&
          clientRect !== undefined &&
          scrollRect[2] > clientRect[2] + 1,
        scrollableY:
          scrollableOverflow(overflowY) &&
          scrollRect !== undefined &&
          clientRect !== undefined &&
          scrollRect[3] > clientRect[3] + 1,
        visible:
          layout !== undefined &&
          (bounds === undefined || (bounds[2] > 0 && bounds[3] > 0)) &&
          styles.display !== 'none' &&
          styles.visibility !== 'hidden' &&
          styles.visibility !== 'collapse' &&
          styles['pointer-events'] !== 'none',
        ...(bounds ? { bounds } : {}),
        parent: null,
        children: [],
      };
      documentNodes[nodeIndex] = node;
      nodesByBackendId.set(backendNodeId, node);
    }
    for (let nodeIndex = 0; nodeIndex < documentNodes.length; nodeIndex += 1) {
      const node = documentNodes[nodeIndex];
      const parentIndex = nodeTable.parentIndex?.[nodeIndex] ?? -1;
      const parent = parentIndex >= 0 ? documentNodes[parentIndex] : undefined;
      if (!node || !parent) continue;
      node.parent = parent;
      parent.children.push(node);
    }
  }
  return nodesByBackendId;
}

function structuralClassTokens(node: SnapshotDomNode): readonly string[] {
  return (node.attributes.get('class') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !PURE_CLASS_STATE_PATTERN.test(token));
}

function classState(node: SnapshotDomNode): readonly string[] {
  const tokens = (node.attributes.get('class') ?? '').split(/\s+/).filter(Boolean);
  const result: string[] = [];
  for (const token of tokens) {
    const explicit = EXPLICIT_CLASS_STATE_PATTERN.exec(token)?.[1]?.toLowerCase();
    if (explicit) result.push(explicit);
  }
  if (!tokens.some((token) => ACTIVE_CLASS_STATE_PATTERN.test(token))) return uniqueState(result);

  const structural = new Set(structuralClassTokens(node));
  if (structural.size === 0 || !node.parent) return uniqueState(result);
  const hasInactiveSibling = node.parent.children
    .filter(
      (sibling) =>
        sibling !== node &&
        sibling.nodeName === node.nodeName &&
        structuralClassTokens(sibling).some((token) => structural.has(token)),
    )
    .some((sibling) =>
      (sibling.attributes.get('class') ?? '')
        .split(/\s+/)
        .every((token) => !ACTIVE_CLASS_STATE_PATTERN.test(token)),
    );
  if (hasInactiveSibling) result.push('active');
  return result;
}

function dataState(node: SnapshotDomNode): readonly string[] {
  const state: string[] = [];
  const booleanAttributes = [
    ['data-checked', 'checked'],
    ['data-selected', 'selected'],
    ['data-disabled', 'disabled'],
  ] as const;
  for (const [attribute, name] of booleanAttributes) {
    const value = node.attributes.get(attribute);
    if (value === undefined) continue;
    const normalized = normalizedStateValue(name, value === '' ? true : value.toLowerCase());
    if (normalized) state.push(normalized);
  }
  switch (node.attributes.get('data-state')?.trim().toLowerCase()) {
    case 'checked':
    case 'on':
      state.push('checked');
      break;
    case 'unchecked':
    case 'off':
      state.push('checked=false');
      break;
    case 'selected':
      state.push('selected');
      break;
    case 'unselected':
      state.push('selected=false');
      break;
    case 'disabled':
      state.push('disabled');
      break;
    case 'open':
      state.push('expanded');
      break;
    case 'closed':
      state.push('expanded=false');
      break;
  }
  return uniqueState(state);
}

function hasSiblingSelectionEvidence(
  node: SnapshotDomNode,
  structural: readonly string[],
): boolean {
  if (!node.parent) return false;
  return node.parent.children
    .filter(
      (candidate) =>
        candidate.nodeName === node.nodeName &&
        structuralClassTokens(candidate).some((token) => structural.includes(token)),
    )
    .some((candidate) =>
      classState(candidate).some((state) =>
        ['active', 'checked', 'selected'].includes(state.split('=', 1)[0] ?? ''),
      ),
    );
}

function selectableRole(node: SnapshotDomNode): string | undefined {
  const explicitRole = normalizedText(node.attributes.get('role')).toLowerCase();
  if (SELECTABLE_ROLES.has(explicitRole)) return explicitRole;
  if (node.nodeName === 'INPUT') {
    const type = normalizedText(node.attributes.get('type')).toLowerCase();
    if (type === 'checkbox' || type === 'radio') return type;
  }
  for (const token of (node.attributes.get('class') ?? '').split(/\s+/)) {
    if (token.toLowerCase().includes('group')) continue;
    const role = SELECTABLE_CLASS_PATTERN.exec(token)?.[1]?.toLowerCase();
    if (role) return role;
  }
  const structural = structuralClassTokens(node);
  const hasSimilarSibling =
    node.parent?.children.some(
      (sibling) =>
        sibling !== node &&
        sibling.nodeName === node.nodeName &&
        structuralClassTokens(sibling).some((token) => structural.includes(token)),
    ) ?? false;
  if (
    node.parent &&
    hasSimilarSibling &&
    (structural.some((token) => EXPLICIT_OPTION_CLASS_PATTERN.test(token)) ||
      (structural.some((token) => AMBIGUOUS_OPTION_CLASS_PATTERN.test(token)) &&
        hasSiblingSelectionEvidence(node, structural)))
  ) {
    return 'option';
  }
  return undefined;
}

function boundedDescendants(start: SnapshotDomNode): readonly SnapshotDomNode[] {
  const result: SnapshotDomNode[] = [];
  const queue = [...start.children];
  while (queue.length > 0 && result.length < 100) {
    const current = queue.shift();
    if (!current) continue;
    result.push(current);
    queue.push(...current.children);
  }
  return result;
}

function associatedSelectableControl(
  target: SnapshotDomNode,
  domByBackendId: ReadonlyMap<number, SnapshotDomNode>,
): { readonly node: SnapshotDomNode; readonly role: string } | undefined {
  const directRole = selectableRole(target);
  if (directRole) return { node: target, role: directRole };

  let current: SnapshotDomNode | null = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const role = selectableRole(current);
    if (role) return { node: current, role };
    if (current.nodeName === 'LABEL') {
      const controlId = current.attributes.get('for');
      if (controlId) {
        for (const candidate of domByBackendId.values()) {
          if (
            candidate.documentFrameId === current.documentFrameId &&
            candidate.attributes.get('id') === controlId
          ) {
            const candidateRole = selectableRole(candidate);
            if (candidateRole) return { node: candidate, role: candidateRole };
          }
        }
      }
      for (const candidate of boundedDescendants(current)) {
        const candidateRole = selectableRole(candidate);
        if (candidateRole) return { node: candidate, role: candidateRole };
      }
    }
    current = current.parent;
  }

  for (const candidate of boundedDescendants(target)) {
    const role = selectableRole(candidate);
    if (role) return { node: candidate, role };
  }
  return undefined;
}

function domState(node: SnapshotDomNode, role?: string): readonly string[] {
  const state: string[] = [];
  const inputType = normalizedText(node.attributes.get('type')).toLowerCase();
  if (node.nodeName === 'INPUT' && (inputType === 'checkbox' || inputType === 'radio')) {
    state.push(node.inputChecked ? 'checked' : 'checked=false');
  } else if (node.inputChecked) {
    state.push('checked');
  }
  if (node.nodeName === 'OPTION') {
    state.push(node.optionSelected ? 'selected' : 'selected=false');
  } else if (node.optionSelected) {
    state.push('selected');
  }
  if (node.attributes.has('disabled')) state.push('disabled');
  if (node.attributes.has('readonly')) state.push('readonly');
  for (const name of ARIA_STATE_ATTRIBUTES) {
    const value = node.attributes.get(`aria-${name}`);
    if (value === undefined) continue;
    const normalized = normalizedStateValue(name, value.toLowerCase());
    if (normalized) state.push(normalized);
  }
  state.push(...dataState(node));
  state.push(...classState(node));
  const normalized = uniqueState(state);
  if (role === 'option') {
    const direct = readSelectionState(normalized);
    const selected = direct ?? normalized.includes('active');
    const remaining = normalized.filter(
      (value) =>
        !['active', 'checked', 'checked=false', 'selected', 'selected=false'].includes(value),
    );
    return uniqueState([selected ? 'selected' : 'selected=false', ...remaining]);
  }
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    const checked = readSelectionState(normalized) ?? false;
    const remaining = normalized.filter(
      (value) =>
        !['active', 'checked', 'checked=false', 'selected', 'selected=false'].includes(value),
    );
    return uniqueState([checked ? 'checked' : 'checked=false', ...remaining]);
  }
  return normalized;
}

function hasAxBoolean(node: Protocol.Accessibility.AXNode, name: string): boolean {
  return (node.properties ?? []).some(
    (property) => property.name === name && axBoolean(property.value),
  );
}

function actionsFor(
  node: Protocol.Accessibility.AXNode,
  role: string,
  domNode: SnapshotDomNode | undefined,
): readonly SemanticAction[] {
  const actions: SemanticAction[] = [];
  if (CLICK_ROLES.has(role) || hasAxBoolean(node, 'focusable')) actions.push('click');
  if (EDITABLE_ROLES.has(role) || hasAxBoolean(node, 'editable')) {
    if (!actions.includes('click')) actions.push('click');
    actions.push('type');
  }
  if (domNode?.nodeName === 'SELECT') actions.push('select');
  return actions;
}

function safePointerTarget(start: SnapshotDomNode): SnapshotDomNode | undefined {
  if (!start.visible || UNSAFE_CLICK_NODE_NAMES.has(start.nodeName)) return undefined;
  let target: SnapshotDomNode | undefined;
  let current: SnapshotDomNode | null = start;
  while (
    current &&
    current.visible &&
    current.cursor === 'pointer' &&
    !UNSAFE_CLICK_NODE_NAMES.has(current.nodeName)
  ) {
    target = current;
    current = current.parent;
  }
  if (target) return target;
  return start.clickable ? start : undefined;
}

function depthOf(
  node: Protocol.Accessibility.AXNode,
  byId: ReadonlyMap<string, Protocol.Accessibility.AXNode>,
): number {
  let depth = 0;
  let current = node;
  const visited = new Set<string>();
  while (current.parentId && !visited.has(current.parentId)) {
    visited.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return Math.min(depth, 40);
}

function semanticAncestorPath(
  node: Protocol.Accessibility.AXNode,
  byId: ReadonlyMap<string, Protocol.Accessibility.AXNode>,
): readonly (readonly [string, string])[] {
  const path: [string, string][] = [];
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId) && path.length < 6) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const role = axText(parent.role).toLowerCase().slice(0, 100);
    const name = axText(parent.name);
    if (role && name && !OMITTED_ROLES.has(role)) path.push([role, name]);
    parentId = parent.parentId;
  }
  return path.reverse();
}

function stableDomAttributes(node: SnapshotDomNode): readonly (readonly [string, string])[] {
  const attributes: [string, string][] = [];
  for (const name of ['id', 'data-testid', 'data-test-id', 'name', 'role', 'type'] as const) {
    const value = normalizedText(node.attributes.get(name), 120);
    if (value) attributes.push([name, value]);
  }
  const structural = structuralClassTokens(node).slice(0, 4).join(' ');
  if (structural) attributes.push(['class', structural]);
  return attributes;
}

function domSemanticPath(node: SnapshotDomNode): readonly unknown[] {
  const path: unknown[] = [];
  let current: SnapshotDomNode | null = node;
  while (current && path.length < 10) {
    if (!UNSAFE_CLICK_NODE_NAMES.has(current.nodeName)) {
      const siblings = current.parent?.children.filter(
        (candidate) => candidate.nodeName === current?.nodeName,
      );
      const ordinal = siblings?.indexOf(current) ?? 0;
      path.push([current.nodeName, stableDomAttributes(current), Math.max(0, ordinal)]);
    }
    current = current.parent;
  }
  return path.reverse();
}

function domDepth(node: SnapshotDomNode): number {
  let depth = 0;
  let current = node.parent;
  while (current && depth < 40) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function domSubtreeText(node: SnapshotDomNode, maximum = 500): string {
  const parts: string[] = [];
  let characters = 0;
  const visit = (current: SnapshotDomNode): void => {
    if (characters >= maximum) return;
    const text = normalizedText(current.ownText, maximum - characters);
    if (text) {
      parts.push(text);
      characters += text.length + 1;
    }
    for (const child of current.children) visit(child);
  };
  visit(node);
  return normalizedText(parts.join(' '), maximum);
}

function syntheticNameText(value: unknown, maximum = 200): string {
  return normalizedText(
    typeof value === 'string' ? value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, ' ') : value,
    maximum,
  );
}

function syntheticTargetName(node: SnapshotDomNode, fallback: string): string {
  for (const attribute of ['aria-label', 'placeholder', 'data-placeholder', 'title', 'name']) {
    const value = syntheticNameText(node.attributes.get(attribute));
    if (value) return value;
  }
  const own = syntheticNameText(domSubtreeText(node, 200));
  if (own) return own;
  const parent = node.parent;
  if (parent?.bounds && node.bounds) {
    const parentArea = parent.bounds[2] * parent.bounds[3];
    const nodeArea = Math.max(1, node.bounds[2] * node.bounds[3]);
    if (parentArea <= nodeArea * 6) {
      const context = syntheticNameText(domSubtreeText(parent, 200));
      if (context) return context;
    }
  }
  return fallback;
}

function domEditableRole(node: SnapshotDomNode): 'searchbox' | 'textbox' | undefined {
  const role = node.attributes.get('role')?.trim().toLowerCase();
  if (role === 'searchbox') return 'searchbox';
  if (role === 'textbox') return 'textbox';
  if (node.nodeName === 'TEXTAREA') return 'textbox';
  if (node.nodeName === 'INPUT') {
    const type = node.attributes.get('type')?.trim().toLowerCase() ?? 'text';
    if (type === 'search') return 'searchbox';
    if (
      !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(type)
    ) {
      return 'textbox';
    }
  }
  const contentEditable = node.attributes.get('contenteditable')?.trim().toLowerCase();
  return contentEditable === '' ||
    contentEditable === 'true' ||
    contentEditable === 'plaintext-only'
    ? 'textbox'
    : undefined;
}

function nearestEditableDomNode(
  start: SnapshotDomNode,
): { readonly node: SnapshotDomNode; readonly role: 'searchbox' | 'textbox' } | undefined {
  let current: SnapshotDomNode | null = start;
  while (current) {
    const role = domEditableRole(current);
    if (role && current.visible) return { node: current, role };
    current = current.parent;
  }
  return undefined;
}

function syntheticSemanticLocator(node: SnapshotDomNode, role: string, name: string): string {
  return JSON.stringify([[], domSemanticPath(node), role, name]).slice(
    0,
    MAX_SEMANTIC_LOCATOR_CHARACTERS,
  );
}

function semanticLocatorFor(
  node: Protocol.Accessibility.AXNode,
  target: SnapshotDomNode,
  role: string,
  name: string,
  byId: ReadonlyMap<string, Protocol.Accessibility.AXNode>,
): string {
  return JSON.stringify([
    semanticAncestorPath(node, byId),
    domSemanticPath(target),
    role,
    name,
  ]).slice(0, MAX_SEMANTIC_LOCATOR_CHARACTERS);
}

function orderedAxNodes(
  nodes: readonly Protocol.Accessibility.AXNode[],
): readonly Protocol.Accessibility.AXNode[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childrenByParent = new Map<string, Protocol.Accessibility.AXNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }

  const ordered: Protocol.Accessibility.AXNode[] = [];
  const visited = new Set<string>();
  const visit = (node: Protocol.Accessibility.AXNode): void => {
    if (visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    ordered.push(node);
    const explicitChildren = new Set(node.childIds ?? []);
    for (const childId of explicitChildren) {
      const child = byId.get(childId);
      if (child) visit(child);
    }
    for (const child of childrenByParent.get(node.nodeId) ?? []) {
      if (!explicitChildren.has(child.nodeId)) visit(child);
    }
  };

  for (const node of nodes) {
    if (!node.parentId || !byId.has(node.parentId)) visit(node);
  }
  for (const node of nodes) visit(node);
  return ordered;
}

/** Joins native AX semantics with bounded DOMSnapshot action evidence. */
export function buildSemanticPageSnapshot(
  input: BuildSemanticPageSnapshotInput,
): SemanticPageSnapshot {
  const domByBackendId = snapshotDomNodes(input.domSnapshot);
  const axById = new Map(input.axNodes.map((node) => [node.nodeId, node]));
  const entries: SemanticPageEntry[] = [];
  const targets: SemanticPageTarget[] = [];
  const targetIndexes = new Map<number, number>();
  const seenEntries = new Set<string>();

  for (const node of orderedAxNodes(input.axNodes)) {
    if (node.ignored) continue;
    const role = axText(node.role).toLowerCase().slice(0, 100);
    if (!role || OMITTED_ROLES.has(role)) continue;
    const backendNodeId = node.backendDOMNodeId;
    const domNode =
      backendNodeId !== undefined && Number.isInteger(backendNodeId)
        ? domByBackendId.get(backendNodeId)
        : undefined;
    let actions = actionsFor(node, role, domNode);
    const editableTarget =
      actions.includes('type') && domNode ? nearestEditableDomNode(domNode) : undefined;
    let targetDomNode =
      editableTarget?.node ?? (actions.length > 0 && domNode?.visible ? domNode : undefined);
    if (actions.length === 0 && domNode) {
      const customTarget = safePointerTarget(domNode);
      if (customTarget) {
        actions = ['click'];
        targetDomNode = customTarget;
      }
    }
    if (!targetDomNode) actions = [];

    const selectable = targetDomNode
      ? associatedSelectableControl(targetDomNode, domByBackendId)
      : undefined;
    const effectiveRole =
      selectable?.role ??
      (editableTarget ? (EDITABLE_ROLES.has(role) ? role : editableTarget.role) : role);
    const name =
      syntheticNameText(axText(node.name)) ||
      (targetDomNode && actions.includes('type')
        ? syntheticTargetName(
            targetDomNode,
            effectiveRole === 'searchbox' ? 'Search' : 'Editable field',
          )
        : '');
    if (!name) continue;

    let targetIndex: number | undefined;
    let state = axState(node);
    if (targetDomNode) {
      state = uniqueState([
        ...state,
        ...(selectable ? domState(selectable.node, effectiveRole) : []),
        ...domState(targetDomNode, effectiveRole),
      ]);
      if (state.includes('disabled')) actions = [];
      else if (state.includes('readonly')) actions = actions.filter((action) => action !== 'type');
      if (actions.includes('click') && hasObservableSelectionState(state)) {
        actions = [...actions, 'set_checked'];
      }
    }
    if (targetDomNode && actions.length > 0) {
      const existing = targetIndexes.get(targetDomNode.backendNodeId);
      if (existing !== undefined) targetIndex = existing;
      else {
        targetIndex = targets.length;
        targetIndexes.set(targetDomNode.backendNodeId, targetIndex);
        targets.push({
          backendNodeId: targetDomNode.backendNodeId,
          ...(selectable === undefined ||
          selectable.node.backendNodeId === targetDomNode.backendNodeId
            ? {}
            : { stateBackendNodeId: selectable.node.backendNodeId }),
          documentFrameId: targetDomNode.documentFrameId,
          role: effectiveRole,
          name,
          semanticLocator: semanticLocatorFor(node, targetDomNode, effectiveRole, name, axById),
          state,
          actions,
        });
      }
    }

    const dedupeKey =
      targetIndex === undefined
        ? `passive:${node.parentId ?? 'root'}:${effectiveRole}:${name}`
        : `target:${String(targetIndex)}:${name}`;
    if (seenEntries.has(dedupeKey)) continue;
    seenEntries.add(dedupeKey);
    const inViewport = viewportMembership(targetDomNode ?? domNode, input.viewport);
    entries.push({
      depth: depthOf(node, axById),
      role: effectiveRole,
      name,
      ...(targetIndex === undefined ? {} : { targetIndex }),
      ...(state.length === 0 ? {} : { state }),
      ...(actions.length === 0 ? {} : { actions }),
      ...(input.frame === 'main' ? {} : { frame: input.frame }),
      ...(inViewport === undefined ? {} : { inViewport }),
    });
  }

  for (const domNode of domByBackendId.values()) {
    if (!domNode.visible || targetIndexes.has(domNode.backendNodeId)) continue;
    const editableRole = domEditableRole(domNode);
    const scrollable = domNode.scrollableX || domNode.scrollableY;
    if (!editableRole && !scrollable) continue;
    const declaredRole = normalizedText(domNode.attributes.get('role'), 100).toLowerCase();
    const role =
      editableRole ?? (declaredRole && !OMITTED_ROLES.has(declaredRole) ? declaredRole : 'region');
    const state = domState(domNode, role);
    if (state.includes('disabled')) continue;
    const actions: SemanticAction[] = [];
    if (editableRole) {
      actions.push('click');
      if (!state.includes('readonly')) actions.push('type');
    }
    if (scrollable) actions.push('scroll');
    const fallback = editableRole
      ? role === 'searchbox'
        ? 'Search'
        : 'Editable field'
      : 'Scrollable area';
    const name = syntheticTargetName(domNode, fallback);
    const inViewport = viewportMembership(domNode, input.viewport);
    const targetIndex = targets.length;
    targetIndexes.set(domNode.backendNodeId, targetIndex);
    targets.push({
      backendNodeId: domNode.backendNodeId,
      documentFrameId: domNode.documentFrameId,
      role,
      name,
      semanticLocator: syntheticSemanticLocator(domNode, role, name),
      state,
      actions,
    });
    entries.push({
      depth: domDepth(domNode),
      role,
      name,
      targetIndex,
      ...(state.length === 0 ? {} : { state }),
      actions,
      ...(input.frame === 'main' ? {} : { frame: input.frame }),
      ...(inViewport === undefined ? {} : { inViewport }),
    });
  }

  return {
    ...compactTargetEntries(entries, targets),
    hasVisualSurface: [...domByBackendId.values()].some(isVisualSurface),
  };
}
