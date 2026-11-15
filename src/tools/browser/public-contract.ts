import { z } from 'zod';
import {
  strictFunctionTool,
  strictObjectSchema,
  type JsonSchemaProperty,
  type ModelToolDefinition,
} from '../model-tool';
import type { ValidatedToolCall } from '../types';
import {
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_SPEC_BY_NAME as operations,
  browserClickPointSchema,
  browserClickSchema,
  browserCloseTabSchema,
  browserDragPointSchema,
  browserDragSchema,
  browserListTabsSchema,
  browserNetworkStartSchema,
  browserNetworkStopSchema,
  browserOpenTabSchema,
  browserOperationForName,
  browserPasteImageSchema,
  browserSetCheckedManySchema,
  browserSwitchTabSchema,
  type BrowserToolInput,
  type BrowserToolName,
  type ParsedBrowserToolCall,
} from './contract';

export interface BrowserCommand {
  readonly name: BrowserToolName;
  readonly arguments: BrowserToolInput;
}

type Definitions = ReadonlyMap<string, ModelToolDefinition>;

export interface BrowserPublicTool {
  readonly definition: ModelToolDefinition;
  readonly schema: z.ZodType<BrowserCommand>;
  readonly recordedSchemas: ReadonlyMap<string, z.ZodType<BrowserCommand>>;
  model(definitions: Definitions): ModelToolDefinition | null;
}

function commandSchema(
  name: BrowserToolName,
  schema: z.ZodType<BrowserToolInput> = operations[name].schema,
) {
  return schema.transform((arguments_) => ({ name, arguments: arguments_ }));
}

const allDefinitions = new Map(
  BROWSER_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]),
);

function properties(definition: ModelToolDefinition) {
  return definition.parameters.properties as Readonly<Record<string, JsonSchemaProperty>>;
}

function publicTool(
  name: string,
  previousNames: readonly BrowserToolName[],
  schema: z.ZodType<BrowserCommand>,
  build: (definitions: Definitions) => ModelToolDefinition | null,
): BrowserPublicTool {
  const definition = build(allDefinitions);
  if (!definition || definition.name !== name)
    throw new Error(`Missing browser definition: ${name}`);
  return {
    definition,
    schema,
    recordedSchemas: new Map(previousNames.map((oldName) => [oldName, commandSchema(oldName)])),
    model: build,
  };
}

function renamed(name: string, previousName: BrowserToolName): BrowserPublicTool {
  return publicTool(name, [previousName], commandSchema(previousName), (definitions) => {
    const definition = definitions.get(previousName);
    return definition ? { ...definition, name } : null;
  });
}

function actionTool(
  name: string,
  actions: Readonly<Record<string, BrowserToolName>>,
  schema: z.ZodType<BrowserCommand>,
  description: string,
): BrowserPublicTool {
  return publicTool(name, Object.values(actions), schema, (definitions) => {
    const choices = Object.entries(actions).flatMap(([action, previousName]) => {
      const definition = definitions.get(previousName);
      return definition
        ? [
            strictObjectSchema({
              action: { type: 'string', enum: [action] },
              ...properties(definition),
            }),
          ]
        : [];
    });
    return choices.length
      ? strictFunctionTool(name, description, { input: { anyOf: choices } })
      : null;
  });
}

const tabActions = {
  list: 'browser_list_tabs',
  open: 'browser_open_tab',
  switch: 'browser_switch_tab',
  close: 'browser_close_tab',
} as const;
const tabInput = z.discriminatedUnion('action', [
  browserListTabsSchema.extend({ action: z.literal('list') }),
  browserOpenTabSchema.extend({ action: z.literal('open') }),
  browserSwitchTabSchema.extend({ action: z.literal('switch') }),
  browserCloseTabSchema.extend({ action: z.literal('close') }),
]);
const tab = actionTool(
  'browser.tab',
  tabActions,
  z
    .object({ input: tabInput })
    .strict()
    .transform(({ input: { action, ...arguments_ } }) => ({
      name: tabActions[action],
      arguments: arguments_,
    })),
  'Manage browser tabs. list returns tab IDs and the task-bound currentTabId. open accepts HTTP(S) or about:blank; keep activate=false for background work. switch binds the task to a tab without activating it. close closes a tab by ID.',
);

const captureActions = { start: 'browser_network_start', stop: 'browser_network_stop' } as const;
const capture = actionTool(
  'network.capture',
  captureActions,
  z
    .object({
      input: z.discriminatedUnion('action', [
        browserNetworkStartSchema.extend({ action: z.literal('start') }),
        browserNetworkStopSchema.extend({ action: z.literal('stop') }),
      ]),
    })
    .strict()
    .transform(({ input: { action, ...arguments_ } }) => ({
      name: captureActions[action],
      arguments: arguments_,
    })),
  'Start future-traffic capture, replacing any frozen snapshot. Reload after starting if initial page traffic is required. Complete and verify the page workflow, wait for final network quiet, then stop on the capture tab. Stop freezes the snapshot for network.list and network.get.',
);

function pointerTool(
  name: string,
  refName: BrowserToolName,
  pointName: BrowserToolName,
  schema: z.ZodType<BrowserCommand>,
): BrowserPublicTool {
  return publicTool(name, [refName, pointName], schema, (definitions) => {
    const ref = definitions.get(refName);
    const point = definitions.get(pointName);
    const primary = ref ?? point;
    if (!primary) return null;
    const targets = [ref, point].flatMap((definition) => {
      if (!definition) return [];
      const { tabId: _tabId, ...target } = properties(definition);
      void _tabId;
      return [strictObjectSchema(target)];
    });
    const tabId = properties(primary).tabId;
    if (!tabId) throw new Error('Pointer tools require a tab schema.');
    return strictFunctionTool(
      name,
      [ref?.description, point?.description].filter(Boolean).join(' '),
      { tabId, target: targets.length === 1 && targets[0] ? targets[0] : { anyOf: targets } },
    );
  });
}

const click = pointerTool(
  'browser.click',
  'browser_click',
  'browser_click_point',
  z
    .object({
      tabId: browserClickSchema.shape.tabId,
      target: z.union([
        browserClickSchema.omit({ tabId: true }),
        browserClickPointSchema.omit({ tabId: true }),
      ]),
    })
    .strict()
    .transform(({ tabId, target }) => ({
      name: 'ref' in target ? 'browser_click' : 'browser_click_point',
      arguments: { tabId, ...target },
    })),
);
const drag = pointerTool(
  'browser.drag',
  'browser_drag',
  'browser_drag_point',
  z
    .object({
      tabId: browserDragSchema.shape.tabId,
      target: z.union([
        browserDragSchema.omit({ tabId: true }),
        browserDragPointSchema.omit({ tabId: true }),
      ]),
    })
    .strict()
    .transform(({ tabId, target }) => ({
      name: 'fromRef' in target ? 'browser_drag' : 'browser_drag_point',
      arguments: { tabId, ...target },
    })),
);

const paste = publicTool(
  'browser.paste',
  ['browser_paste_image'],
  browserPasteImageSchema
    .extend({ type: z.literal('image') })
    .transform(({ type, ...arguments_ }) => {
      void type;
      return { name: 'browser_paste_image', arguments: arguments_ };
    }),
  (definitions) => {
    const definition = definitions.get('browser_paste_image');
    return definition
      ? strictFunctionTool('browser.paste', definition.description, {
          ...properties(definition),
          type: { type: 'string', enum: ['image'] },
        })
      : null;
  },
);

const checked = publicTool(
  'browser.set_checked',
  ['browser_set_checked', 'browser_set_checked_many'],
  browserSetCheckedManySchema.transform(({ tabId, items }) =>
    items.length === 1 && items[0]
      ? { name: 'browser_set_checked', arguments: { tabId, ...items[0] } }
      : { name: 'browser_set_checked_many', arguments: { tabId, items } },
  ),
  (definitions) => {
    const single = definitions.get('browser_set_checked');
    const batch = definitions.get('browser_set_checked_many');
    const primary = single ?? batch;
    if (!primary) return null;
    const inputs = properties(operations.browser_set_checked_many.definition);
    return strictFunctionTool(
      'browser.set_checked',
      single
        ? `${single.description} ${batch?.description ?? 'Pass one item.'}`
        : primary.description,
      { ...inputs, items: { ...inputs.items, maxItems: batch ? 20 : 1 } },
    );
  },
);

export const BROWSER_PUBLIC_TOOLS = [
  tab,
  renamed('browser.navigate', 'browser_navigate'),
  renamed('browser.reload', 'browser_reload'),
  renamed('browser.inspect', 'browser_inspect'),
  renamed('browser.screenshot', 'browser_capture_screenshot'),
  paste,
  click,
  checked,
  renamed('browser.type', 'browser_type'),
  renamed('browser.keypress', 'browser_keypress'),
  renamed('browser.scroll', 'browser_scroll'),
  renamed('browser.hover', 'browser_hover'),
  renamed('browser.select', 'browser_select'),
  drag,
  renamed('browser.wait', 'browser_wait'),
  capture,
  renamed('network.list', 'browser_network_list'),
  renamed('network.get', 'browser_network_get'),
] as const;

const byName = new Map(BROWSER_PUBLIC_TOOLS.map((tool) => [tool.definition.name, tool]));

export function browserEngineCall(call: ValidatedToolCall<BrowserCommand>): ParsedBrowserToolCall {
  const { name, arguments: arguments_ } = call.arguments;
  return {
    callId: call.callId,
    name,
    operation: browserOperationForName(name),
    arguments: arguments_,
    argumentsJson: JSON.stringify(arguments_),
  };
}

type RecordedCall = { readonly name: string; readonly argumentsJson: string };

/** Projects current and legacy audit records onto the existing browser operation names. */
export function browserHistoryCall<T extends RecordedCall>(call: T): T {
  const tool = byName.get(call.name);
  if (!tool) return call;
  if (tool.recordedSchemas.size === 1 && tool !== paste) {
    const previous = tool.recordedSchemas.keys().next().value;
    if (previous) return { ...call, name: previous };
  }
  try {
    const command = tool.schema.parse(JSON.parse(call.argumentsJson));
    return { ...call, name: command.name, argumentsJson: JSON.stringify(command.arguments) };
  } catch {
    return call;
  }
}

export function isBrowserTool(name: string): boolean {
  return Object.hasOwn(operations, name) || byName.has(name);
}
