import { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import { strictFunctionTool, type ModelToolDefinition } from '../../tools/contracts/model-tool';
import {
  parseToolCallArguments,
  type ModelToolCallSource,
} from '../../tools/contracts/tool-call-envelope';

const MAX_TAB_ID = 2_147_483_647;
const MAX_COORDINATE = 1_000_000;
const MAX_SCROLL_DELTA = 10_000;
const MAX_SCROLL_UNTIL_DELTA = 1_200;
const MAX_SNAPSHOT_ID_CHARACTERS = 64;
const MAX_ATTACHMENT_ID_CHARACTERS = 256;

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
export const browserGetCurrentTabSchema = z.object({}).strict();
export const browserOpenTabSchema = z
  .object({ url: browserUrlSchema, activate: z.boolean() })
  .strict();
export const browserSwitchTabSchema = z.object({ tabId: tabIdSchema }).strict();
export const browserCloseTabSchema = z.object({ tabId: tabIdSchema }).strict();
export const browserNavigateSchema = z
  .object({ tabId: tabIdSchema.optional(), url: browserUrlSchema })
  .strict();
export const browserReloadSchema = z.object({ tabId: tabIdSchema.optional() }).strict();
export const browserInspectSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    mode: z.enum(['content', 'interactive', 'interactive_deep', 'screenshot']),
    since: z
      .string()
      .max(MAX_SNAPSHOT_ID_CHARACTERS)
      .refine((value) => value.trim() === value)
      .optional(),
  })
  .strict();
export const browserCaptureScreenshotSchema = z.object({ tabId: tabIdSchema.optional() }).strict();
export const browserPasteImageSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    ref: refSchema,
    assetId: z
      .string()
      .min(1)
      .max(MAX_ATTACHMENT_ID_CHARACTERS)
      .refine((value) => value.trim() === value),
  })
  .strict();
export const browserClickSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    ref: refSchema,
    button: z.enum(['left', 'right', 'middle']),
    count: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();
export const browserSetCheckedSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    ref: refSchema,
    checked: z.boolean(),
  })
  .strict();
const browserSetCheckedItemSchema = z.object({ ref: refSchema, checked: z.boolean() }).strict();
export const browserSetCheckedManySchema = z
  .object({
    tabId: tabIdSchema.optional(),
    items: z.array(browserSetCheckedItemSchema).min(1).max(20),
  })
  .strict()
  .refine(({ items }) => new Set(items.map(({ ref }) => ref)).size === items.length);
export const browserTypeSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    ref: refSchema,
    text: z.string().max(20_000),
    replace: z.boolean(),
    submit: z.boolean(),
  })
  .strict();
export const browserKeypressSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    keys: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => value.trim() === value),
  })
  .strict();
export const browserScrollSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    target: refSchema,
    deltaX: z.number().int().min(-MAX_SCROLL_DELTA).max(MAX_SCROLL_DELTA),
    deltaY: z.number().int().min(-MAX_SCROLL_DELTA).max(MAX_SCROLL_DELTA),
  })
  .strict()
  .refine(({ deltaX, deltaY }) => deltaX !== 0 || deltaY !== 0);
export const browserScrollUntilSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    target: refSchema,
    deltaX: z.number().int().min(-MAX_SCROLL_UNTIL_DELTA).max(MAX_SCROLL_UNTIL_DELTA),
    deltaY: z.number().int().min(-MAX_SCROLL_UNTIL_DELTA).max(MAX_SCROLL_UNTIL_DELTA),
    maxSegments: z.number().int().min(1).max(24),
    stopText: z.string().max(500),
  })
  .strict()
  .refine(({ deltaX, deltaY }) => deltaX !== 0 || deltaY !== 0);
export const browserHoverSchema = z
  .object({ tabId: tabIdSchema.optional(), ref: refSchema })
  .strict();
export const browserSelectSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    ref: refSchema,
    value: z.string().max(2_000),
  })
  .strict();
export const browserDragSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    fromRef: refSchema,
    toRef: refSchema,
  })
  .strict();
export const browserWaitSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    condition: z.enum(['load', 'network_idle', 'dom_stable', 'delay']),
    timeoutMs: z.number().int().min(250).max(10_000),
  })
  .strict();
export const browserClickPointSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    x: coordinateSchema,
    y: coordinateSchema,
    button: z.enum(['left', 'right']),
    count: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();
export const browserDragPointSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    fromX: coordinateSchema,
    fromY: coordinateSchema,
    toX: coordinateSchema,
    toY: coordinateSchema,
  })
  .strict();
export const browserNetworkStartSchema = z.object({ tabId: tabIdSchema.optional() }).strict();
export const browserNetworkListSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    urlPattern: z.string().max(500),
    limit: z.number().int().min(1).max(100),
    mode: z.enum(['recent', 'endpoint_sample']),
  })
  .strict();
const browserNetworkGetItemSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => value.trim() === value),
    includeRequestBody: z.boolean(),
    includeResponseBody: z.boolean(),
  })
  .strict();
export const browserNetworkGetSchema = z
  .object({
    tabId: tabIdSchema.optional(),
    requests: z.array(browserNetworkGetItemSchema).min(1).max(5),
  })
  .strict();
export const browserNetworkStopSchema = z.object({ tabId: tabIdSchema.optional() }).strict();

const BROWSER_SCHEMAS = {
  browser_get_current_tab: browserGetCurrentTabSchema,
  browser_list_tabs: browserListTabsSchema,
  browser_open_tab: browserOpenTabSchema,
  browser_switch_tab: browserSwitchTabSchema,
  browser_close_tab: browserCloseTabSchema,
  browser_navigate: browserNavigateSchema,
  browser_reload: browserReloadSchema,
  browser_inspect: browserInspectSchema,
  browser_capture_screenshot: browserCaptureScreenshotSchema,
  browser_paste_image: browserPasteImageSchema,
  browser_click: browserClickSchema,
  browser_set_checked: browserSetCheckedSchema,
  browser_set_checked_many: browserSetCheckedManySchema,
  browser_type: browserTypeSchema,
  browser_keypress: browserKeypressSchema,
  browser_scroll: browserScrollSchema,
  browser_scroll_until: browserScrollUntilSchema,
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
  | 'get_current_tab'
  | 'list_tabs'
  | 'open_tab'
  | 'switch_tab'
  | 'close_tab'
  | 'navigate'
  | 'reload'
  | 'inspect'
  | 'capture_screenshot'
  | 'paste_image'
  | 'click'
  | 'set_checked'
  | 'set_checked_many'
  | 'type'
  | 'keypress'
  | 'scroll'
  | 'scroll_until'
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

export type BrowserToolCallSource = ModelToolCallSource;

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
  browser_get_current_tab: 'get_current_tab',
  browser_list_tabs: 'list_tabs',
  browser_open_tab: 'open_tab',
  browser_switch_tab: 'switch_tab',
  browser_close_tab: 'close_tab',
  browser_navigate: 'navigate',
  browser_reload: 'reload',
  browser_inspect: 'inspect',
  browser_capture_screenshot: 'capture_screenshot',
  browser_paste_image: 'paste_image',
  browser_click: 'click',
  browser_set_checked: 'set_checked',
  browser_set_checked_many: 'set_checked_many',
  browser_type: 'type',
  browser_keypress: 'keypress',
  browser_scroll: 'scroll',
  browser_scroll_until: 'scroll_until',
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
  'browser_get_current_tab',
  'browser_list_tabs',
  'browser_switch_tab',
  'browser_inspect',
  'browser_capture_screenshot',
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
  return strictFunctionTool(name, description, properties);
}

const TAB_ID_PROPERTY = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_TAB_ID,
} as const;
const TASK_TAB_ID_PROPERTY = {
  ...TAB_ID_PROPERTY,
  description: 'Use 0 for the task current tab; a nonzero ID targets that background tab.',
} as const;
const URL_PROPERTY = {
  type: 'string',
  minLength: 1,
  maxLength: 4_096,
} as const;
const REF_PROPERTY = { type: 'string', minLength: 1, maxLength: 128 } as const;
const COORDINATE_PROPERTY = {
  type: 'number',
  minimum: 0,
  maximum: MAX_COORDINATE,
} as const;

function taskToolDefinition(
  name: BrowserToolName,
  description: string,
  properties: Readonly<Record<string, FlatProperty>>,
): ModelToolDefinition {
  return toolDefinition(name, description, {
    tabId: TASK_TAB_ID_PROPERTY,
    ...properties,
  });
}

export const BROWSER_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  toolDefinition(
    'browser_get_current_tab',
    'Return the browser tab currently bound to this task. Use it for requests about this or the current page.',
    {},
  ),
  toolDefinition(
    'browser_list_tabs',
    'List browser tabs with IDs, titles, URLs, and active state.',
    {},
  ),
  toolDefinition(
    'browser_open_tab',
    'Open one HTTP(S) URL or about:blank and make it the task current tab. Keep activate false for background work; use true only when the user asks to foreground it.',
    {
      url: URL_PROPERTY,
      activate: { type: 'boolean' },
    },
  ),
  toolDefinition('browser_switch_tab', 'Set the task current tab without activating it.', {
    tabId: TAB_ID_PROPERTY,
  }),
  toolDefinition('browser_close_tab', 'Close one existing browser tab by ID.', {
    tabId: TAB_ID_PROPERTY,
  }),
  taskToolDefinition('browser_navigate', 'Navigate one task page to an HTTP(S) URL.', {
    url: URL_PROPERTY,
  }),
  taskToolDefinition('browser_reload', 'Reload one task page and wait for stability.', {}),
  taskToolDefinition(
    'browser_inspect',
    'Inspect readable content, a compact native accessibility tree with actionable refs across frames, or a viewport screenshot. Interactive coverage is page-scoped; traversalRequiredFor is exhaustive, so incomplete page coverage mandates scrolling only for those page-wide objectives, never merely to locate, open, or view a named section. Content mode reads only the currently mounted DOM and never proves complete offscreen or virtualized coverage; use interactive before answering a whole-document, all-items, date-range, or page-summary request. Use interactive for a viewport-prioritized bounded tree. For whole-document, all-items, date-range, or page-summary objectives, interactive coverage.complete=false means the relevant coverage target must be traversed before answering. This is page-global coverage: page-global coverage.complete=false does not by itself make a named-section objective incomplete. Treat a terse named-section command such as Chinese “看下/看看/打开/定位/跳到/选择 + 章节名” as locate/view only. When the user asks only to locate, open, or view a named section, same-page navigation or a table-of-contents link may be used; inspect the destination heading and requested content, then answer without traversing unrelated content below it. A click verification that exposes the requested heading and visible content satisfies this inspection; do not scroll the document or click subsection links. For whole-document reading or summarization, traverse the primary scrollable content before using same-page navigation or table-of-contents links. For whole-document, all-items, date-range, or page-summary coverage, do not click same-page navigation or table-of-contents links before or after traversal. Such links do not by themselves prove whole-document content coverage. Only when the user explicitly requests reading, analyzing, or summarizing an entire named section, cover only that section and stop at the next same-level or higher-level heading when one is available. For a finite document or virtual list, first establish one directional boundary and then traverse toward the opposite boundary; for an endless feed, collect a bounded representative sample and disclose its observed range. Use interactive_deep only when the needed offscreen target or context was truncated or remains unavailable after interactive inspection. Always inspect interactive before requesting a screenshot. Continue with refs and interactive deltas whenever the accessibility tree contains the needed content or controls. When reading more items from a list or timeline, use the scrollable ref that advertises scroll; passive text refs are content, not pagination controls. Do not use screenshots to verify semantic form state. Screenshot fallback is accepted when interactive inspection lacks actionable targets, detects a visual surface such as canvas, or interactive_deep still does not expose the required control. After a successful screenshot inspection, browser_click_point becomes available on the next model turn; its absence before the screenshot is expected. Set since to an empty string for a full result. Reuse only the latest interactive snapshot ID when its base elements remain in context. A keyed delta applies to that base: upsert items contain identity k and replacement element e; remove contains deleted identities.',
    {
      mode: {
        type: 'string',
        enum: ['content', 'interactive', 'interactive_deep', 'screenshot'],
      },
      since: {
        type: 'string',
        maxLength: MAX_SNAPSHOT_ID_CHARACTERS,
      },
    },
  ),
  taskToolDefinition(
    'browser_capture_screenshot',
    'Capture the current webpage viewport as a task-owned image asset for later delivery through the page. This is not a visual inspection: use browser_inspect mode screenshot when the model must see pixels. The returned assetId can be passed only to browser_paste_image in this WorkSession.',
    {},
  ),
  taskToolDefinition(
    'browser_paste_image',
    'Paste a task-owned screenshot into a recent semantic editable message or file-input ref. This tool becomes available after capture returns an assetId. It first uses bounded page-local delivery and may fall back to staging the image on the system clipboard plus a native browser paste; clipboardChanged=true reports that fallback. Captured assets remain valid across context compaction within the current WorkSession, and currently available IDs are listed in the assetId enum. Continue only when the result reports verified=true; that means a real editor or attachment-preview change was measured, not merely a retained hidden file input. After sending, inspect again to verify remote delivery. Never paste the same asset twice after an ambiguous result.',
    {
      ref: REF_PROPERTY,
      assetId: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_ATTACHMENT_ID_CHARACTERS,
      },
    },
  ),
  taskToolDefinition(
    'browser_click',
    'Automatically scroll a recent semantic element ref into view, click it, and return its latest readable state when available. When an inspected ref advertises set_checked in its actions, use browser_set_checked instead for an idempotent action.',
    {
      ref: REF_PROPERTY,
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      count: { type: 'integer', enum: [1, 2] },
    },
  ),
  taskToolDefinition(
    'browser_set_checked',
    'Idempotently set a recent ref that advertises set_checked to the requested state. Use checked=true for one-way selections such as radio controls. Returns the target state and every other known selection state changed by the action.',
    {
      ref: REF_PROPERTY,
      checked: { type: 'boolean' },
    },
  ),
  taskToolDefinition(
    'browser_set_checked_many',
    'Set 1 to 20 distinct recent refs to requested selection states in order. Each item is idempotently re-resolved and verified before the next item. The result keeps the verified prefix and stops at the first failure; never replay completed items.',
    {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            ref: REF_PROPERTY,
            checked: { type: 'boolean' },
          },
          required: ['ref', 'checked'],
          additionalProperties: false,
        },
      },
    },
  ),
  taskToolDefinition('browser_type', 'Automatically reveal and type into a recent semantic ref.', {
    ref: REF_PROPERTY,
    text: { type: 'string', maxLength: 20_000 },
    replace: { type: 'boolean' },
    submit: { type: 'boolean' },
  }),
  taskToolDefinition(
    'browser_keypress',
    'Send a normalized key or chord. Named keys include ENTER, TAB, ESC/ESCAPE, arrows, navigation, editing keys, and F1-F12; browser history uses BROWSER_BACK or BROWSER_FORWARD.',
    {
      keys: { type: 'string', minLength: 1, maxLength: 100 },
    },
  ),
  taskToolDefinition(
    'browser_scroll',
    'Scroll the viewport or a recent semantic element ref by exact CSS-pixel deltas. For a list or timeline, target the scroll ref whose name contains the relevant visible items. Do not click passive content to reveal more items. Negative deltaY reads earlier or upper content; positive deltaY reads later or lower content. One call may consume the distance in multiple virtualized segments; verification is one resulting AX observation and observations is the chronological sequence when multiple batches were exposed. Read that evidence directly instead of immediately inspecting it again. When collecting a requested time or item interval, continue until the returned evidence observes content outside the requested interval or an actual list boundary; seeing the first in-range item does not prove complete coverage. If requestedDeltaApplied=false, continue with remainingDeltaX and remainingDeltaY. continuationLimited only explains why internal batching stopped; inspect first only when verificationUnavailable=true or continuationFailure is present. Do not infer an element boundary from position 0 alone: loadedMore=true means virtualized content changed or its extent grew, while needsBoundaryProbe=true means the call only just reached the edge and needs another same-direction probe. Stop only when boundaryVerified=true. moved=true can include content or extent changes without a final position change.',
    {
      target: REF_PROPERTY,
      deltaX: {
        type: 'integer',
        minimum: -MAX_SCROLL_DELTA,
        maximum: MAX_SCROLL_DELTA,
      },
      deltaY: {
        type: 'integer',
        minimum: -MAX_SCROLL_DELTA,
        maximum: MAX_SCROLL_DELTA,
      },
    },
  ),
  taskToolDefinition(
    'browser_scroll_until',
    'Use only when the user objective requires evidence beyond the current observation. Never call this after locating, opening, or viewing a named section merely because page coverage is incomplete. Treat a terse request to look at, open, locate, or jump to a named section as locate/view, not complete-section reading; Chinese examples include “看下/看看/打开/定位/跳到/选择 + 章节名”. Once same-page navigation exposes the requested heading and visible content, answer without calling this tool or clicking subsection links. For whole-document reading or page-summary objectives, regardless of the current viewport, first traverse upward with negative deltaY until the upper boundary is verified; only then traverse downward from that boundary. Traverse a long document, virtual list, timeline, or feed by repeatedly scrolling one current coverage target and returning every newly exposed interactive AX batch in order. Prefer traversal before using anchors, headings, or table-of-contents items only for whole-document, all-items, date-range, or page-summary coverage. For those page-wide objectives, do not click anchors, headings, or table-of-contents items before or after traversal. Same-page navigation may instead locate a named section when that is the user objective. Only when the user explicitly requests reading, analyzing, or summarizing an entire named section, stop at the next same-level or higher-level heading by passing its normalized text as a non-empty stopText when available. Do not use an empty stopText merely to continue to the document boundary for a named section unless inspection establishes that it is the final section. deltaX and deltaY are requested per-segment strides, not the total traversal distance; execution reduces either stride when needed to at most 80% of the current CSS-pixel scroll-target size so adjacent observations overlap. Use the target named by coverage when it is unambiguous; otherwise choose the scroll ref whose semantic name matches the requested content. It performs no clicks, typing, date interpretation, or page-specific logic. Negative deltaY reads earlier or upper content and positive deltaY reads later or lower content. For complete finite page-wide coverage, reach one boundary and then traverse in the opposite direction until coverage.directionComplete=true; reaching only the first boundary is not full-document proof. stopText is a normalized substring marker; a text match proves only that the marker was seen, not that an entire requested range is complete. Empty stopText permits boundary, cycle, or bounded open-feed detection for page-wide objectives. coverage.mode=open_ended or cyclic with sampleComplete=true is a bounded sample, not a physical end: summarize only the observed range and say so. Read observations directly instead of immediately inspecting again. continuationAvailable=true permits, but never forces, another call; continue only while the current objective still requires that coverage. page-global continuation is not a named-section completion condition.',
    {
      target: REF_PROPERTY,
      deltaX: {
        type: 'integer',
        minimum: -MAX_SCROLL_UNTIL_DELTA,
        maximum: MAX_SCROLL_UNTIL_DELTA,
      },
      deltaY: {
        type: 'integer',
        minimum: -MAX_SCROLL_UNTIL_DELTA,
        maximum: MAX_SCROLL_UNTIL_DELTA,
      },
      maxSegments: { type: 'integer', minimum: 1, maximum: 24 },
      stopText: { type: 'string', maxLength: 500 },
    },
  ),
  taskToolDefinition(
    'browser_hover',
    'Move the virtual pointer over a recent semantic element ref.',
    {
      ref: REF_PROPERTY,
    },
  ),
  taskToolDefinition(
    'browser_select',
    'Choose a value only on a ref that advertises select. For a custom dropdown, click its trigger and then click the desired option ref.',
    {
      ref: REF_PROPERTY,
      value: { type: 'string', maxLength: 2_000 },
    },
  ),
  taskToolDefinition('browser_drag', 'Drag from one recent semantic ref to another.', {
    fromRef: REF_PROPERTY,
    toRef: REF_PROPERTY,
  }),
  taskToolDefinition(
    'browser_wait',
    'Wait for load, network idle, DOM stability, or a bounded delay.',
    {
      condition: {
        type: 'string',
        enum: ['load', 'network_idle', 'dom_stable', 'delay'],
      },
      timeoutMs: { type: 'integer', minimum: 250, maximum: 10_000 },
    },
  ),
  taskToolDefinition(
    'browser_click_point',
    'Click screenshot coordinates only after inspecting a current viewport screenshot.',
    {
      x: COORDINATE_PROPERTY,
      y: COORDINATE_PROPERTY,
      button: { type: 'string', enum: ['left', 'right'] },
      count: { type: 'integer', enum: [1, 2] },
    },
  ),
  taskToolDefinition(
    'browser_drag_point',
    'Drag between screenshot coordinates only after inspecting a current viewport screenshot.',
    {
      fromX: COORDINATE_PROPERTY,
      fromY: COORDINATE_PROPERTY,
      toX: COORDINATE_PROPERTY,
      toY: COORDINATE_PROPERTY,
    },
  ),
  taskToolDefinition(
    'browser_network_start',
    'Start capturing future traffic only. For initial-load traffic, then reload, wait for network_idle, and list requests.',
    {},
  ),
  taskToolDefinition(
    'browser_network_list',
    'List bounded captured request metadata for one tab. Use recent for chronological entries or endpoint_sample to return the newest request ID per method/origin/path/query-name signature with occurrenceCount. For analysis, inspect relevant IDs with browser_network_get before stopping.',
    {
      urlPattern: { type: 'string', maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      mode: { type: 'string', enum: ['recent', 'endpoint_sample'] },
    },
  ),
  taskToolDefinition(
    'browser_network_get',
    'Read sanitized details for 1 to 5 captured request IDs. Request and response bodies are separate and fetched only when their per-ID flags are true. Duplicate IDs use the first item; one missing ID does not fail the batch.',
    {
      requests: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            requestId: { type: 'string', minLength: 1, maxLength: 512 },
            includeRequestBody: { type: 'boolean' },
            includeResponseBody: { type: 'boolean' },
          },
          required: ['requestId', 'includeRequestBody', 'includeResponseBody'],
          additionalProperties: false,
        },
      },
    },
  ),
  taskToolDefinition(
    'browser_network_stop',
    'Stop capturing traffic at any time and release its buffer. Listing and reading relevant requests first is recommended only when analysis evidence is needed.',
    {},
  ),
];

/** Stable registry used to select a checkpoint-safe subset without cloning schemas. */
export const BROWSER_TOOL_DEFINITION_BY_NAME = Object.freeze(
  Object.fromEntries(BROWSER_TOOL_DEFINITIONS.map((definition) => [definition.name, definition])),
) as Readonly<Record<BrowserToolName, ModelToolDefinition>>;

/** Parses one browser call while replacing all unsafe validation details. */
export function parseBrowserToolCall(input: BrowserToolCallSource): ParsedBrowserToolCall {
  try {
    if (!Object.hasOwn(BROWSER_SCHEMAS, input.name)) {
      throw new Error('Invalid browser tool call envelope.');
    }
    const name = input.name as BrowserToolName;
    const value = parseToolCallArguments(input);
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
