import { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import type { ModelToolDefinition } from '../../providers/provider-types';

const MAX_TOOL_CALL_ID_CHARACTERS = 256;
const MAX_TOOL_ARGUMENTS_JSON_CHARACTERS = 32 * 1_024;
const MAX_TAB_ID = 2_147_483_647;
const MAX_COORDINATE = 1_000_000;

const tabIdSchema = z.number().int().min(0).max(MAX_TAB_ID);
const refSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value);
const coordinateSchema = z.number().finite().min(0).max(MAX_COORDINATE);
const browserUrlSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.trim() === value)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'about:') return parsed.href === 'about:blank';
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username.length === 0 &&
        parsed.password.length === 0
      );
    } catch {
      return false;
    }
  });

export const browserListTabsSchema = z.object({}).strict();
export const browserOpenTabSchema = z
  .object({ url: browserUrlSchema, activate: z.boolean() })
  .strict();
export const browserSwitchTabSchema = z.object({ tabId: tabIdSchema }).strict();
export const browserCloseTabSchema = z.object({ tabId: tabIdSchema }).strict();
export const browserNavigateSchema = z
  .object({ tabId: tabIdSchema, url: browserUrlSchema })
  .strict();
export const browserReloadSchema = z.object({ tabId: tabIdSchema }).strict();
export const browserInspectSchema = z
  .object({ tabId: tabIdSchema, mode: z.enum(['content', 'interactive', 'screenshot']) })
  .strict();
export const browserClickSchema = z
  .object({
    tabId: tabIdSchema,
    ref: refSchema,
    button: z.enum(['left', 'right', 'middle']),
    count: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();
export const browserTypeSchema = z
  .object({
    tabId: tabIdSchema,
    ref: refSchema,
    text: z.string().max(20_000),
    replace: z.boolean(),
    submit: z.boolean(),
  })
  .strict();
export const browserKeypressSchema = z
  .object({
    tabId: tabIdSchema,
    keys: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => value.trim() === value),
  })
  .strict();
export const browserScrollSchema = z
  .object({
    tabId: tabIdSchema,
    target: refSchema,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.enum(['small', 'medium', 'page']),
  })
  .strict();
export const browserHoverSchema = z.object({ tabId: tabIdSchema, ref: refSchema }).strict();
export const browserSelectSchema = z
  .object({ tabId: tabIdSchema, ref: refSchema, value: z.string().max(2_000) })
  .strict();
export const browserDragSchema = z
  .object({ tabId: tabIdSchema, fromRef: refSchema, toRef: refSchema })
  .strict();
export const browserWaitSchema = z
  .object({
    tabId: tabIdSchema,
    condition: z.enum(['load', 'network_idle', 'dom_stable', 'delay']),
    timeoutMs: z.number().int().min(250).max(10_000),
  })
  .strict();
export const browserClickPointSchema = z
  .object({
    tabId: tabIdSchema,
    x: coordinateSchema,
    y: coordinateSchema,
    button: z.enum(['left', 'right']),
    count: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();
export const browserDragPointSchema = z
  .object({
    tabId: tabIdSchema,
    fromX: coordinateSchema,
    fromY: coordinateSchema,
    toX: coordinateSchema,
    toY: coordinateSchema,
  })
  .strict();
export const browserNetworkStartSchema = z.object({ tabId: tabIdSchema }).strict();
export const browserNetworkListSchema = z
  .object({
    tabId: tabIdSchema,
    urlPattern: z.string().max(500),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export const browserNetworkGetSchema = z
  .object({
    tabId: tabIdSchema,
    requestId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim() === value),
    includeBody: z.boolean(),
  })
  .strict();
export const browserNetworkStopSchema = z.object({ tabId: tabIdSchema }).strict();

const BROWSER_SCHEMAS = {
  browser_list_tabs: browserListTabsSchema,
  browser_open_tab: browserOpenTabSchema,
  browser_switch_tab: browserSwitchTabSchema,
  browser_close_tab: browserCloseTabSchema,
  browser_navigate: browserNavigateSchema,
  browser_reload: browserReloadSchema,
  browser_inspect: browserInspectSchema,
  browser_click: browserClickSchema,
  browser_type: browserTypeSchema,
  browser_keypress: browserKeypressSchema,
  browser_scroll: browserScrollSchema,
  browser_hover: browserHoverSchema,
  browser_select: browserSelectSchema,
  browser_drag: browserDragSchema,
  browser_wait: browserWaitSchema,
  browser_click_point: browserClickPointSchema,
  browser_drag_point: browserDragPointSchema,
  browser_network_start: browserNetworkStartSchema,
  browser_network_list: browserNetworkListSchema,
  browser_network_get: browserNetworkGetSchema,
  browser_network_stop: browserNetworkStopSchema,
} as const;

export type BrowserToolName = keyof typeof BROWSER_SCHEMAS;
export type BrowserOperation =
  | 'list_tabs'
  | 'open_tab'
  | 'switch_tab'
  | 'close_tab'
  | 'navigate'
  | 'reload'
  | 'inspect'
  | 'click'
  | 'type'
  | 'keypress'
  | 'scroll'
  | 'hover'
  | 'select'
  | 'drag'
  | 'wait'
  | 'click_point'
  | 'drag_point'
  | 'network_start'
  | 'network_list'
  | 'network_get'
  | 'network_stop';

export type BrowserToolInput = z.infer<(typeof BROWSER_SCHEMAS)[BrowserToolName]>;

export interface BrowserToolCallSource {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ParsedBrowserToolCall {
  readonly family: 'browser';
  readonly operation: BrowserOperation;
  readonly callId: string;
  readonly name: BrowserToolName;
  readonly argumentsJson: string;
  readonly arguments: BrowserToolInput;
  readonly replay: 'safe' | 'mutation';
}

const OPERATIONS: Readonly<Record<BrowserToolName, BrowserOperation>> = {
  browser_list_tabs: 'list_tabs',
  browser_open_tab: 'open_tab',
  browser_switch_tab: 'switch_tab',
  browser_close_tab: 'close_tab',
  browser_navigate: 'navigate',
  browser_reload: 'reload',
  browser_inspect: 'inspect',
  browser_click: 'click',
  browser_type: 'type',
  browser_keypress: 'keypress',
  browser_scroll: 'scroll',
  browser_hover: 'hover',
  browser_select: 'select',
  browser_drag: 'drag',
  browser_wait: 'wait',
  browser_click_point: 'click_point',
  browser_drag_point: 'drag_point',
  browser_network_start: 'network_start',
  browser_network_list: 'network_list',
  browser_network_get: 'network_get',
  browser_network_stop: 'network_stop',
};

const SAFE_TO_REPLAY = new Set<BrowserToolName>([
  'browser_list_tabs',
  'browser_inspect',
  'browser_wait',
  'browser_network_list',
  'browser_network_get',
]);

type FlatProperty = Readonly<Record<string, unknown>>;

function toolDefinition(
  name: BrowserToolName,
  description: string,
  properties: Readonly<Record<string, FlatProperty>>,
): ModelToolDefinition {
  return {
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    strict: true,
  };
}

const TAB_ID_PROPERTY = { type: 'integer', minimum: 0, maximum: MAX_TAB_ID } as const;
const URL_PROPERTY = { type: 'string', minLength: 1, maxLength: 4_096 } as const;
const REF_PROPERTY = { type: 'string', minLength: 1, maxLength: 128 } as const;
const COORDINATE_PROPERTY = { type: 'number', minimum: 0, maximum: MAX_COORDINATE } as const;

export const BROWSER_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  toolDefinition(
    'browser_list_tabs',
    'List browser tabs with IDs, titles, URLs, and active state.',
    {},
  ),
  toolDefinition('browser_open_tab', 'Open one HTTP(S) URL or about:blank in a browser tab.', {
    url: URL_PROPERTY,
    activate: { type: 'boolean' },
  }),
  toolDefinition('browser_switch_tab', 'Activate one existing browser tab by ID.', {
    tabId: TAB_ID_PROPERTY,
  }),
  toolDefinition('browser_close_tab', 'Close one existing browser tab by ID.', {
    tabId: TAB_ID_PROPERTY,
  }),
  toolDefinition('browser_navigate', 'Navigate one browser tab to an HTTP(S) URL or about:blank.', {
    tabId: TAB_ID_PROPERTY,
    url: URL_PROPERTY,
  }),
  toolDefinition('browser_reload', 'Reload one browser tab and wait for bounded page stability.', {
    tabId: TAB_ID_PROPERTY,
  }),
  toolDefinition(
    'browser_inspect',
    'Inspect readable content, semantic interactive elements, or a viewport screenshot.',
    {
      tabId: TAB_ID_PROPERTY,
      mode: { type: 'string', enum: ['content', 'interactive', 'screenshot'] },
    },
  ),
  toolDefinition('browser_click', 'Click a recent semantic element ref and verify page state.', {
    tabId: TAB_ID_PROPERTY,
    ref: REF_PROPERTY,
    button: { type: 'string', enum: ['left', 'right', 'middle'] },
    count: { type: 'integer', enum: [1, 2] },
  }),
  toolDefinition('browser_type', 'Type into a recent semantic element ref.', {
    tabId: TAB_ID_PROPERTY,
    ref: REF_PROPERTY,
    text: { type: 'string', maxLength: 20_000 },
    replace: { type: 'boolean' },
    submit: { type: 'boolean' },
  }),
  toolDefinition(
    'browser_keypress',
    'Send a normalized key or chord, including BROWSER_BACK and BROWSER_FORWARD.',
    {
      tabId: TAB_ID_PROPERTY,
      keys: { type: 'string', minLength: 1, maxLength: 100 },
    },
  ),
  toolDefinition('browser_scroll', 'Scroll the viewport or a recent semantic element ref.', {
    tabId: TAB_ID_PROPERTY,
    target: REF_PROPERTY,
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'string', enum: ['small', 'medium', 'page'] },
  }),
  toolDefinition('browser_hover', 'Move the virtual pointer over a recent semantic element ref.', {
    tabId: TAB_ID_PROPERTY,
    ref: REF_PROPERTY,
  }),
  toolDefinition('browser_select', 'Choose an option value in a recent semantic select ref.', {
    tabId: TAB_ID_PROPERTY,
    ref: REF_PROPERTY,
    value: { type: 'string', maxLength: 2_000 },
  }),
  toolDefinition('browser_drag', 'Drag from one recent semantic ref to another.', {
    tabId: TAB_ID_PROPERTY,
    fromRef: REF_PROPERTY,
    toRef: REF_PROPERTY,
  }),
  toolDefinition(
    'browser_wait',
    'Wait for load, network idle, DOM stability, or a bounded delay.',
    {
      tabId: TAB_ID_PROPERTY,
      condition: { type: 'string', enum: ['load', 'network_idle', 'dom_stable', 'delay'] },
      timeoutMs: { type: 'integer', minimum: 250, maximum: 10_000 },
    },
  ),
  toolDefinition(
    'browser_click_point',
    'Click screenshot coordinates only after inspecting a current viewport screenshot.',
    {
      tabId: TAB_ID_PROPERTY,
      x: COORDINATE_PROPERTY,
      y: COORDINATE_PROPERTY,
      button: { type: 'string', enum: ['left', 'right'] },
      count: { type: 'integer', enum: [1, 2] },
    },
  ),
  toolDefinition(
    'browser_drag_point',
    'Drag between screenshot coordinates only after inspecting a current viewport screenshot.',
    {
      tabId: TAB_ID_PROPERTY,
      fromX: COORDINATE_PROPERTY,
      fromY: COORDINATE_PROPERTY,
      toX: COORDINATE_PROPERTY,
      toY: COORDINATE_PROPERTY,
    },
  ),
  toolDefinition(
    'browser_network_start',
    'Start capturing future traffic only. For initial-load traffic, then reload, wait for network_idle, and list requests.',
    { tabId: TAB_ID_PROPERTY },
  ),
  toolDefinition('browser_network_list', 'List bounded captured request metadata for one tab.', {
    tabId: TAB_ID_PROPERTY,
    urlPattern: { type: 'string', maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  toolDefinition('browser_network_get', 'Read sanitized details for one captured request.', {
    tabId: TAB_ID_PROPERTY,
    requestId: { type: 'string', minLength: 1, maxLength: 512 },
    includeBody: { type: 'boolean' },
  }),
  toolDefinition(
    'browser_network_stop',
    'Stop capturing traffic for one tab and release its buffer.',
    {
      tabId: TAB_ID_PROPERTY,
    },
  ),
];

/** Parses one browser call while replacing all unsafe validation details. */
export function parseBrowserToolCall(input: BrowserToolCallSource): ParsedBrowserToolCall {
  try {
    if (
      input.callId.trim().length === 0 ||
      input.callId.length > MAX_TOOL_CALL_ID_CHARACTERS ||
      input.argumentsJson.length > MAX_TOOL_ARGUMENTS_JSON_CHARACTERS ||
      !Object.hasOwn(BROWSER_SCHEMAS, input.name)
    ) {
      throw new Error('Invalid browser tool call envelope.');
    }
    const name = input.name as BrowserToolName;
    const value: unknown = JSON.parse(input.argumentsJson);
    const arguments_ = BROWSER_SCHEMAS[name].parse(value) as BrowserToolInput;
    return {
      family: 'browser',
      operation: OPERATIONS[name],
      callId: input.callId,
      name,
      argumentsJson: input.argumentsJson,
      arguments: arguments_,
      replay: SAFE_TO_REPLAY.has(name) ? 'safe' : 'mutation',
    };
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}
