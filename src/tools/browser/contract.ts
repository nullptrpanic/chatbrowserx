import { z } from 'zod';
import { strictFunctionTool, type ModelToolDefinition } from '../model-tool';
import { parseToolCallArguments, type ModelToolCallSource } from '../tool-call-envelope';

const MAX_TAB_ID = 2_147_483_647;
const MAX_COORDINATE = 1_000_000;
const MAX_SCROLL_DELTA = 10_000;
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
    cursor: z.string().max(512),
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

type FlatProperty = Readonly<Record<string, unknown>>;

function browserToolSpec<const TName extends `browser_${string}`, TSchema extends z.ZodType>(
  name: TName,
  schema: TSchema,
  description: string,
  properties: Readonly<Record<string, FlatProperty>>,
) {
  return { name, schema, definition: strictFunctionTool(name, description, properties) } as const;
}

const TAB_ID_PROPERTY = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_TAB_ID,
} as const;
const TASK_TAB_ID_PROPERTY = {
  ...TAB_ID_PROPERTY,
  description:
    'Required. Use 0 for the task-bound current tab, even when task page metadata is absent. Use a nonzero ID only to target a specific background tab.',
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

function taskBrowserToolSpec<const TName extends `browser_${string}`, TSchema extends z.ZodType>(
  name: TName,
  schema: TSchema,
  description: string,
  properties: Readonly<Record<string, FlatProperty>>,
) {
  return browserToolSpec(name, schema, description, {
    tabId: TASK_TAB_ID_PROPERTY,
    ...properties,
  });
}

export const BROWSER_TOOL_SPECS = [
  browserToolSpec(
    'browser_get_current_tab',
    browserGetCurrentTabSchema,
    'Return the browser tab currently bound to this task. Use it for requests about this or the current page.',
    {},
  ),
  browserToolSpec(
    'browser_list_tabs',
    browserListTabsSchema,
    'List browser tabs with IDs, titles, URLs, and active state.',
    {},
  ),
  browserToolSpec(
    'browser_open_tab',
    browserOpenTabSchema,
    'Open one HTTP(S) URL or about:blank and make it the task current tab. Keep activate false for background work; use true only when the user asks to foreground it.',
    {
      url: URL_PROPERTY,
      activate: { type: 'boolean' },
    },
  ),
  browserToolSpec(
    'browser_switch_tab',
    browserSwitchTabSchema,
    'Set the task current tab without activating it.',
    { tabId: TAB_ID_PROPERTY },
  ),
  browserToolSpec(
    'browser_close_tab',
    browserCloseTabSchema,
    'Close one existing browser tab by ID.',
    { tabId: TAB_ID_PROPERTY },
  ),
  taskBrowserToolSpec(
    'browser_navigate',
    browserNavigateSchema,
    'Navigate one task page to an HTTP(S) URL.',
    {
      url: URL_PROPERTY,
    },
  ),
  taskBrowserToolSpec(
    'browser_reload',
    browserReloadSchema,
    'Reload one task page and wait for stability.',
    {},
  ),
  taskBrowserToolSpec(
    'browser_inspect',
    browserInspectSchema,
    'Inspect the task current webpage for requests to read, locate, summarize, or interact with its content. It returns mounted readable DOM content, a compact native accessibility tree with cross-frame actionable refs, or a viewport screenshot. Content mode does not prove offscreen or virtualized completeness; use interactive for page-wide requests. Interactive is viewport-prioritized and bounded. A click verification showing the requested heading and content satisfies scoped inspection. Use interactive_deep only after interactive truncates or lacks needed offscreen content. Always inspect interactive before requesting a screenshot. Reuse refs and interactive deltas while the accessibility tree has the needed controls. For lists or timelines, use the scrollable ref that advertises scroll; passive text is not pagination. Do not use screenshots to verify semantic form state. Screenshot fallback is for missing actionable targets, visual surfaces, or a still-missing control after deep inspection. After a successful screenshot inspection, browser_click_point becomes available on the next model turn. since="" returns a full result; otherwise reuse only the latest snapshot whose base remains in context. Delta upsert contains identity k and replacement e; remove contains deleted identities.',
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
  taskBrowserToolSpec(
    'browser_capture_screenshot',
    browserCaptureScreenshotSchema,
    'Capture the current webpage viewport as a task-owned image asset. After success, browser_paste_image appears on the next model turn with the returned assetId; reread tools rather than report it missing. For visual inspection use browser_inspect mode screenshot instead.',
    {},
  ),
  taskBrowserToolSpec(
    'browser_paste_image',
    browserPasteImageSchema,
    'Paste a task-owned screenshot into a recent semantic editable message or file-input ref. This tool becomes available after capture returns an assetId. It first uses bounded page-local delivery and may fall back to staging the image on the system clipboard plus a native browser paste; clipboardChanged=true reports that fallback. Captured assets remain valid across context compaction within the current task, and currently available IDs are listed in the assetId enum. Continue only when the result reports verified=true; that means a real editor or attachment-preview change was measured, not merely a retained hidden file input. After sending, inspect again to verify remote delivery. Never paste the same asset twice after an ambiguous result.',
    {
      ref: REF_PROPERTY,
      assetId: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_ATTACHMENT_ID_CHARACTERS,
      },
    },
  ),
  taskBrowserToolSpec(
    'browser_click',
    browserClickSchema,
    'Automatically scroll a recent semantic element ref into view, click it, and return its latest readable state when available. For page-wide reading, never click same-page or table-of-contents links; answer after boundary traversal. When an inspected ref advertises set_checked in its actions, use browser_set_checked instead for an idempotent action.',
    {
      ref: REF_PROPERTY,
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      count: { type: 'integer', enum: [1, 2] },
    },
  ),
  taskBrowserToolSpec(
    'browser_set_checked',
    browserSetCheckedSchema,
    'Idempotently set a recent ref that advertises set_checked to the requested state. Use checked=true for one-way selections such as radio controls. Returns the target state and every other known selection state changed by the action.',
    {
      ref: REF_PROPERTY,
      checked: { type: 'boolean' },
    },
  ),
  taskBrowserToolSpec(
    'browser_set_checked_many',
    browserSetCheckedManySchema,
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
  taskBrowserToolSpec(
    'browser_type',
    browserTypeSchema,
    'Automatically reveal and type into a recent semantic ref.',
    {
      ref: REF_PROPERTY,
      text: { type: 'string', maxLength: 20_000 },
      replace: { type: 'boolean' },
      submit: { type: 'boolean' },
    },
  ),
  taskBrowserToolSpec(
    'browser_keypress',
    browserKeypressSchema,
    'Send a normalized key or chord. Named keys include ENTER, TAB, ESC/ESCAPE, arrows, navigation, editing keys, and F1-F12; browser history uses BROWSER_BACK or BROWSER_FORWARD.',
    {
      keys: { type: 'string', minLength: 1, maxLength: 100 },
    },
  ),
  taskBrowserToolSpec(
    'browser_scroll',
    browserScrollSchema,
    'Scroll a viewport or recent semantic scroll ref. For finite page-wide reading, verify the upper boundary once, then use maxSegments=24 downward until boundaryVerified=true. Navigation keys only reposition; prove the upper boundary with a negative scroll. A verified lower boundary completes coverage: answer; never call another browser tool, reverse, or restore position. Visible top content alone is not boundary evidence. maxSegments=1 with stopText="" requests one exact CSS-pixel distance; maxSegments>1 or non-empty stopText requests bounded traversal with per-segment deltaX/deltaY. For lists or timelines, scroll their ref; never click passive content. Negative deltaY reads earlier content; positive reads later. Consume observations chronologically instead of inspecting again. A stopText match proves only that its marker was seen. For an interval, continue until evidence is outside it or at a verified boundary. Empty stopText permits boundary, cycle, or open-feed sampling; sampleComplete=true is a bounded sample, not a physical end. For exact distance, continue remainingDelta when requestedDeltaApplied=false. loadedMore=true means content changed; needsBoundaryProbe=true requires a same-direction probe; only boundaryVerified=true proves an edge. continuationRequired=true requires fresh evidence; continuationAvailable=true permits but does not require another call.',
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
      maxSegments: { type: 'integer', minimum: 1, maximum: 24 },
      stopText: { type: 'string', maxLength: 500 },
    },
  ),
  taskBrowserToolSpec(
    'browser_hover',
    browserHoverSchema,
    'Move the virtual pointer over a recent semantic element ref.',
    {
      ref: REF_PROPERTY,
    },
  ),
  taskBrowserToolSpec(
    'browser_select',
    browserSelectSchema,
    'Choose a value only on a ref that advertises select. For a custom dropdown, click its trigger and then click the desired option ref.',
    {
      ref: REF_PROPERTY,
      value: { type: 'string', maxLength: 2_000 },
    },
  ),
  taskBrowserToolSpec(
    'browser_drag',
    browserDragSchema,
    'Drag from one recent semantic ref to another.',
    { fromRef: REF_PROPERTY, toRef: REF_PROPERTY },
  ),
  taskBrowserToolSpec(
    'browser_wait',
    browserWaitSchema,
    'Wait for load, 500 ms of network quiet, DOM stability, or a bounded delay. Network quiet does not prove that asynchronous application work is complete; verify the requested user-visible outcome separately.',
    {
      condition: {
        type: 'string',
        enum: ['load', 'network_idle', 'dom_stable', 'delay'],
      },
      timeoutMs: { type: 'integer', minimum: 250, maximum: 10_000 },
    },
  ),
  taskBrowserToolSpec(
    'browser_click_point',
    browserClickPointSchema,
    'Click screenshot coordinates only after inspecting a current viewport screenshot.',
    {
      x: COORDINATE_PROPERTY,
      y: COORDINATE_PROPERTY,
      button: { type: 'string', enum: ['left', 'right'] },
      count: { type: 'integer', enum: [1, 2] },
    },
  ),
  taskBrowserToolSpec(
    'browser_drag_point',
    browserDragPointSchema,
    'Drag between screenshot coordinates only after inspecting a current viewport screenshot.',
    {
      fromX: COORDINATE_PROPERTY,
      fromY: COORDINATE_PROPERTY,
      toX: COORDINATE_PROPERTY,
      toY: COORDINATE_PROPERTY,
    },
  ),
  taskBrowserToolSpec(
    'browser_network_start',
    browserNetworkStartSchema,
    'Start future-traffic capture, replacing any frozen snapshot. Call first for network evidence. Complete and verify the user-visible workflow, wait for final network quiet, then freeze it with browser_network_stop. Request readers are introduced only after stop. Reload after starting when initial page traffic is required.',
    {},
  ),
  taskBrowserToolSpec(
    'browser_network_list',
    browserNetworkListSchema,
    'Page through one frozen capture after browser_network_stop. Counts distinguish captured, retained, matched, total result, and current-page requests; follow nextCursor until hasMore=false. Small sanitized structured request bodies may be included as bounded previews. Use recent for complete retained metadata or endpoint_sample for a compact newest-per-endpoint sample. After the first successful list, inspect selected IDs with browser_network_get.',
    {
      urlPattern: { type: 'string', maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      mode: { type: 'string', enum: ['recent', 'endpoint_sample'] },
      cursor: { type: 'string', maxLength: 512 },
    },
  ),
  taskBrowserToolSpec(
    'browser_network_get',
    browserNetworkGetSchema,
    'After browser_network_list, read sanitized details for 1 to 5 listed request IDs. Request and response bodies are separate and fetched only when their per-ID flags are true. Duplicate IDs use the first item. If any ID is absent from the frozen capture, list again with cursor="" and copy requestId values exactly before retrying.',
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
  taskBrowserToolSpec(
    'browser_network_stop',
    browserNetworkStopSchema,
    'After verifying business completion and final network quiet, stop accepting events and freeze the capture. The next model turn introduces browser_network_list. Frozen request IDs and bodies remain readable until the next browser_network_start, task-run release, or debugger loss. Stop itself never waits for business completion.',
    {},
  ),
] as const;

export type BrowserToolSpec = (typeof BROWSER_TOOL_SPECS)[number];
export type BrowserToolName = BrowserToolSpec['name'];
type BrowserToolSpecMap = {
  readonly [Spec in BrowserToolSpec as Spec['name']]: Spec;
};
export const BROWSER_TOOL_SPEC_BY_NAME = Object.fromEntries(
  BROWSER_TOOL_SPECS.map((spec) => [spec.name, spec]),
) as BrowserToolSpecMap;

type BrowserOperationForName<TName extends BrowserToolName> =
  TName extends `browser_${infer Operation}` ? Operation : never;
export type BrowserOperation = BrowserOperationForName<BrowserToolName>;

/** Derives the internal browser executor discriminator from its validated tool name. */
export function browserOperationForName<TName extends BrowserToolName>(
  name: TName,
): BrowserOperationForName<TName> {
  return name.slice('browser_'.length) as BrowserOperationForName<TName>;
}

export type BrowserToolInput = z.infer<BrowserToolSpec['schema']>;
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

export const SAFE_TO_REPLAY_BROWSER_TOOLS = new Set<BrowserToolName>([
  'browser_get_current_tab',
  'browser_list_tabs',
  'browser_switch_tab',
  'browser_inspect',
  'browser_capture_screenshot',
  'browser_wait',
  'browser_network_list',
  'browser_network_get',
]);

export const BROWSER_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = BROWSER_TOOL_SPECS.map(
  ({ definition }) => definition,
);

/** Parses one trusted browser-domain call; model-boundary redaction belongs to the planner. */
export function parseBrowserToolCall(input: BrowserToolCallSource): ParsedBrowserToolCall {
  try {
    if (!Object.hasOwn(BROWSER_TOOL_SPEC_BY_NAME, input.name)) {
      throw new Error('Invalid browser tool call envelope.');
    }
    const name = input.name as BrowserToolName;
    const spec = BROWSER_TOOL_SPEC_BY_NAME[name];
    return {
      family: 'browser',
      operation: browserOperationForName(name),
      callId: input.callId,
      name,
      argumentsJson: input.argumentsJson,
      arguments: spec.schema.parse(parseToolCallArguments(input)) as BrowserToolInput,
      replay: SAFE_TO_REPLAY_BROWSER_TOOLS.has(name) ? 'safe' : 'mutation',
    };
  } catch {
    throw Object.assign(new Error('Browser tool call is invalid.'), {
      code: 'INVALID_RESPONSE' as const,
    });
  }
}
