import type { ModelToolDefinition } from '../../providers/provider-types';
import type { Checkpoint } from '../../tasks/checkpoint-types';
import type { ContinuationItem } from '../../tasks/continuation-types';
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_DEFINITION_BY_NAME,
  type BrowserToolName,
} from './browser-tool-schema';

const CORE_TOOL_NAMES = new Set<BrowserToolName>([
  'browser_get_current_tab',
  'browser_list_tabs',
  'browser_open_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_reload',
  'browser_inspect',
  'browser_capture_screenshot',
  'browser_click',
  'browser_set_checked',
  'browser_type',
  'browser_keypress',
  'browser_scroll',
  'browser_hover',
  'browser_select',
  'browser_drag',
  'browser_wait',
  'browser_network_start',
]);

const VISUAL_INVALIDATING_TOOLS = new Set<BrowserToolName>([
  'browser_open_tab',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_reload',
  'browser_paste_image',
  'browser_click',
  'browser_set_checked',
  'browser_set_checked_many',
  'browser_type',
  'browser_keypress',
  'browser_scroll',
  'browser_hover',
  'browser_select',
  'browser_drag',
  'browser_wait',
  'browser_click_point',
  'browser_drag_point',
]);

interface CapabilityState {
  visualSnapshotCurrent: boolean;
  networkActive: boolean;
  selectableRefs: Set<string>;
  readonly usedTools: Set<BrowserToolName>;
}

function successfulRecord(output: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Readonly<Record<string, unknown>>;
    return record.ok === true ? record : null;
  } catch {
    return null;
  }
}

function browserToolName(value: string): BrowserToolName | null {
  return Object.hasOwn(BROWSER_TOOL_DEFINITION_BY_NAME, value) ? (value as BrowserToolName) : null;
}

function selectableRefFromEntry(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entry = value as Readonly<Record<string, unknown>>;
  const actions = Array.isArray(entry.a)
    ? entry.a
    : Array.isArray(entry.actions)
      ? entry.actions
      : [];
  return typeof entry.ref === 'string' && actions.includes('set_checked') ? entry.ref : null;
}

function applySemanticState(data: unknown, refs: Set<string>): void {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  const record = data as Readonly<Record<string, unknown>>;
  if (record.mode === 'interactive' && Array.isArray(record.elements)) {
    refs.clear();
    for (const entry of record.elements) {
      const ref = selectableRefFromEntry(entry);
      if (ref) refs.add(ref);
    }
  }
  if (Array.isArray(record.remove)) {
    for (const identity of record.remove) {
      if (typeof identity === 'string' && identity.startsWith('ref:'))
        refs.delete(identity.slice(4));
    }
  }
  if (Array.isArray(record.upsert)) {
    for (const item of record.upsert) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const value = item as Readonly<Record<string, unknown>>;
      const identity = typeof value.k === 'string' ? value.k : '';
      if (identity.startsWith('ref:')) refs.delete(identity.slice(4));
      const ref = selectableRefFromEntry(value.e);
      if (ref) refs.add(ref);
    }
  }
}

function applySuccessfulBrowserResult(
  name: BrowserToolName,
  result: Readonly<Record<string, unknown>>,
  state: CapabilityState,
): void {
  const data =
    typeof result.data === 'object' && result.data !== null && !Array.isArray(result.data)
      ? (result.data as Readonly<Record<string, unknown>>)
      : null;
  if (name === 'browser_inspect') {
    state.visualSnapshotCurrent = data?.mode === 'screenshot';
    applySemanticState(data, state.selectableRefs);
    return;
  }
  if (VISUAL_INVALIDATING_TOOLS.has(name)) state.visualSnapshotCurrent = false;
  if (
    name === 'browser_navigate' ||
    name === 'browser_reload' ||
    name === 'browser_switch_tab' ||
    name === 'browser_close_tab'
  ) {
    state.selectableRefs.clear();
  }
  if (name === 'browser_network_start') state.networkActive = true;
  else if (name === 'browser_network_stop') state.networkActive = false;
  applySemanticState(data?.verification, state.selectableRefs);
}

function successfulCommit(call: ContinuationItem, output: ContinuationItem): boolean {
  return (
    call.type === 'function_call' &&
    call.name === 'commit_context' &&
    output.type === 'function_call_output' &&
    successfulRecord(output.output) !== null
  );
}

/** Selects only tools justified by durable executor state, while keeping replay compatibility. */
export function browserToolDefinitionsForCheckpoint(
  checkpoint: Pick<Checkpoint, 'continuationItems' | 'completedToolResults'>,
): readonly ModelToolDefinition[] {
  const state: CapabilityState = {
    visualSnapshotCurrent: false,
    networkActive: false,
    selectableRefs: new Set(),
    usedTools: new Set(),
  };
  const pendingCalls = new Map<
    string,
    Extract<ContinuationItem, { readonly type: 'function_call' }>
  >();
  for (const item of checkpoint.continuationItems) {
    if (item.type === 'function_call') {
      pendingCalls.set(item.callId, item);
      continue;
    }
    if (item.type !== 'function_call_output') continue;
    const call = pendingCalls.get(item.callId);
    pendingCalls.delete(item.callId);
    if (!call) continue;
    if (successfulCommit(call, item)) {
      state.visualSnapshotCurrent = false;
      state.networkActive = false;
      state.selectableRefs.clear();
      state.usedTools.clear();
      continue;
    }
    const name = browserToolName(call.name);
    if (!name) continue;
    state.usedTools.add(name);
    const output = successfulRecord(item.output);
    if (output) applySuccessfulBrowserResult(name, output, state);
  }

  const enabled = new Set<BrowserToolName>([...CORE_TOOL_NAMES, ...state.usedTools]);
  if (state.visualSnapshotCurrent) {
    enabled.add('browser_click_point');
    enabled.add('browser_drag_point');
  }
  if (state.networkActive) {
    enabled.add('browser_network_list');
    enabled.add('browser_network_get');
    enabled.add('browser_network_stop');
  }
  if (
    checkpoint.completedToolResults.some(
      (result) => result.toolName.startsWith('browser_') && (result.attachmentIds?.length ?? 0) > 0,
    )
  ) {
    enabled.add('browser_paste_image');
  }
  if (state.selectableRefs.size >= 2) enabled.add('browser_set_checked_many');

  return BROWSER_TOOL_DEFINITIONS.filter(({ name }) => enabled.has(name as BrowserToolName));
}
