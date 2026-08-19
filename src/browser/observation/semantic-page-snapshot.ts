import type { Protocol } from 'devtools-protocol';

export const SEMANTIC_SNAPSHOT_STYLES = [
  'cursor',
  'display',
  'visibility',
  'pointer-events',
] as const;

export type SemanticAction = 'click' | 'set_checked' | 'type' | 'select';

export interface SemanticPageEntry {
  readonly depth: number;
  readonly role: string;
  readonly name: string;
  readonly targetIndex?: number;
  readonly state?: readonly string[];
  readonly actions?: readonly SemanticAction[];
  readonly frame?: string;
}

export interface SemanticPageTarget {
  readonly backendNodeId: number;
  readonly documentFrameId: string;
  readonly role: string;
  readonly name: string;
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
}

interface SnapshotDomNode {
  readonly backendNodeId: number;
  readonly documentFrameId: string;
  readonly nodeName: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly clickable: boolean;
  readonly inputChecked: boolean;
  readonly optionSelected: boolean;
  readonly cursor: string;
  readonly visible: boolean;
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
const MODEL_AX_STATES = new Set([...STATE_ATTRIBUTES, 'busy', 'invalid', 'readonly', 'required']);
const CLASS_STATE_PATTERN = /^(checked|selected|active|disabled)(?:$|[-_])/i;
const SELECTABLE_ROLES = new Set(['checkbox', 'option', 'radio', 'switch']);
const SELECTABLE_CLASS_PATTERN = /(?:^|[-_])(checkbox|radio|switch)(?:$|[-_])/i;
const SELECTABLE_ITEM_CLASS_PATTERN = /(?:^|[-_])(answer|choice|option)(?:$|[-_])/i;
const DIRECT_VISUAL_SURFACE_NODE_NAMES = new Set(['CANVAS', 'VIDEO']);
const LARGE_VISUAL_SURFACE_NODE_NAMES = new Set(['IMG', 'SVG']);

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
    const existing = byName.get(name);
    if (existing === undefined || existing.endsWith('=false')) byName.set(name, value);
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
      }
    >();
    document_.layout.nodeIndex.forEach((nodeIndex, layoutIndex) => {
      const bounds = tupleBounds(document_.layout.bounds[layoutIndex]);
      layoutByNodeIndex.set(nodeIndex, {
        styles: document_.layout.styles[layoutIndex] ?? [],
        ...(bounds ? { bounds } : {}),
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
      const node: SnapshotDomNode = {
        backendNodeId,
        documentFrameId,
        nodeName: stringAt(snapshot.strings, nodeTable.nodeName?.[nodeIndex]).toUpperCase(),
        attributes: parseAttributes(snapshot.strings, nodeTable.attributes?.[nodeIndex]),
        clickable: clickable.has(nodeIndex),
        inputChecked: inputChecked.has(nodeIndex),
        optionSelected: optionSelected.has(nodeIndex),
        cursor: styles.cursor ?? '',
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
    .filter((token) => !CLASS_STATE_PATTERN.test(token));
}

function classState(node: SnapshotDomNode): readonly string[] {
  const tokens = (node.attributes.get('class') ?? '').split(/\s+/).filter(Boolean);
  const structural = new Set(structuralClassTokens(node));
  if (structural.size === 0 || !node.parent) return [];
  const siblings = node.parent.children.filter(
    (sibling) =>
      sibling !== node &&
      sibling.nodeName === node.nodeName &&
      structuralClassTokens(sibling).some((token) => structural.has(token)),
  );
  if (siblings.length === 0) return [];
  const result: string[] = [];
  for (const token of tokens) {
    const matched = CLASS_STATE_PATTERN.exec(token);
    const stateName = matched?.[1]?.toLowerCase();
    if (
      stateName &&
      siblings.some((sibling) =>
        (sibling.attributes.get('class') ?? '')
          .split(/\s+/)
          .every((siblingToken) => !siblingToken.toLowerCase().startsWith(stateName)),
      )
    ) {
      result.push(stateName);
    }
  }
  return result;
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
  if (
    node.parent &&
    structural.some((token) => SELECTABLE_ITEM_CLASS_PATTERN.test(token)) &&
    hasSiblingSelectionEvidence(node, structural) &&
    node.parent.children.some(
      (sibling) =>
        sibling !== node &&
        sibling.nodeName === node.nodeName &&
        structuralClassTokens(sibling).some((token) => structural.includes(token)),
    )
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
  if (node.inputChecked) state.push('checked');
  if (node.optionSelected) state.push('selected');
  if (node.attributes.has('disabled')) state.push('disabled');
  for (const name of STATE_ATTRIBUTES) {
    const value = node.attributes.get(`aria-${name}`);
    if (value === undefined) continue;
    const normalized = normalizedStateValue(name, value.toLowerCase());
    if (normalized) state.push(normalized);
  }
  state.push(...classState(node));
  if (role === 'option') {
    const selected = state.some((value) => ['active', 'checked', 'selected'].includes(value));
    const remaining = state.filter(
      (value) =>
        !['active', 'checked', 'checked=false', 'selected', 'selected=false'].includes(value),
    );
    return uniqueState([selected ? 'selected' : 'selected=false', ...remaining]);
  }
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    const checked = state.some((value) => ['active', 'checked', 'selected'].includes(value));
    const remaining = state.filter(
      (value) =>
        !['active', 'checked', 'checked=false', 'selected', 'selected=false'].includes(value),
    );
    return uniqueState([checked ? 'checked' : 'checked=false', ...remaining]);
  }
  return uniqueState(state);
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
    const name = axText(node.name);
    if (!role || !name || OMITTED_ROLES.has(role)) continue;
    const backendNodeId = node.backendDOMNodeId;
    const domNode =
      backendNodeId !== undefined && Number.isInteger(backendNodeId)
        ? domByBackendId.get(backendNodeId)
        : undefined;
    let actions = actionsFor(node, role, domNode);
    let targetDomNode = actions.length > 0 && domNode?.visible ? domNode : undefined;
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
    const effectiveRole = selectable?.role ?? role;

    let targetIndex: number | undefined;
    let state = axState(node);
    if (targetDomNode && actions.length > 0) {
      state = uniqueState([
        ...state,
        ...(selectable ? domState(selectable.node, effectiveRole) : []),
        ...domState(targetDomNode, effectiveRole),
      ]);
      if (actions.includes('click') && hasObservableSelectionState(state)) {
        actions = [...actions, 'set_checked'];
      }
      const existing = targetIndexes.get(targetDomNode.backendNodeId);
      if (existing !== undefined) targetIndex = existing;
      else {
        targetIndex = targets.length;
        targetIndexes.set(targetDomNode.backendNodeId, targetIndex);
        targets.push({
          backendNodeId: targetDomNode.backendNodeId,
          documentFrameId: targetDomNode.documentFrameId,
          role: effectiveRole,
          name,
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
    entries.push({
      depth: depthOf(node, axById),
      role: effectiveRole,
      name,
      ...(targetIndex === undefined ? {} : { targetIndex }),
      ...(state.length === 0 ? {} : { state }),
      ...(actions.length === 0 ? {} : { actions }),
      ...(input.frame === 'main' ? {} : { frame: input.frame }),
    });
  }

  return {
    ...compactTargetEntries(entries, targets),
    hasVisualSurface: [...domByBackendId.values()].some(isVisualSurface),
  };
}
