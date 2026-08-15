import { z } from 'zod';
import type { BrowserActionRequest } from '../../browser/contracts/action';
import { elementTargetSchema } from '../../browser/contracts/action-schema';
import type { ElementTarget } from '../../browser/contracts/target';
import type { ExpectedCondition } from '../../browser/verify/expected-condition';
import type { ModelToolDefinition } from '../../providers/provider-types';

const attributeSchema = z.object({ name: z.string().max(80), value: z.string().max(200) }).strict();
const modelRectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();
const modelFrameSegmentSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().max(200).nullable(),
    title: z.string().max(200).nullable(),
    origin: z.string().max(2_000).nullable(),
  })
  .strict();
const modelShadowSegmentSchema = z
  .object({
    hostRole: z.string().max(80).nullable(),
    hostName: z.string().max(200).nullable(),
    stableAttributes: z.array(attributeSchema).max(20),
  })
  .strict();
const serializedModelTargetSchema = z
  .object({
    framePath: z.array(modelFrameSegmentSchema).max(40),
    shadowPath: z.array(modelShadowSegmentSchema).max(40),
    role: z.string().max(80).nullable(),
    name: z.string().max(500).nullable(),
    label: z.string().max(500).nullable(),
    text: z.string().max(2_000).nullable(),
    stableAttributes: z.array(attributeSchema).max(20),
    ancestorHint: z.string().max(500).nullable(),
    lastKnownRect: modelRectSchema.nullable(),
  })
  .strict()
  .transform((target): ElementTarget => ({
    ...target,
    stableAttributes: Object.fromEntries(
      target.stableAttributes.map((attribute) => [attribute.name, attribute.value]),
    ),
    shadowPath: target.shadowPath.map((segment) => ({
      ...segment,
      stableAttributes: Object.fromEntries(
        segment.stableAttributes.map((attribute) => [attribute.name, attribute.value]),
      ),
    })),
  }));

const modelElementTargetSchema: z.ZodType<ElementTarget> = z.union([
  serializedModelTargetSchema,
  elementTargetSchema,
]);

const modelExpectedConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url.changed'), from: z.string().max(2_000) }).strict(),
  z.object({ type: z.literal('url.matches'), pattern: z.string().min(1).max(500) }).strict(),
  z
    .object({
      type: z.literal('element.value'),
      target: modelElementTargetSchema,
      equals: z.string().max(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('element.visible'),
      target: modelElementTargetSchema,
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('element.checked'),
      target: modelElementTargetSchema,
      checked: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('text.contains'), text: z.string().min(1).max(2_000) }).strict(),
  z
    .object({
      type: z.literal('element.count'),
      target: modelElementTargetSchema,
      operator: z.enum(['eq', 'gt', 'lt']),
      value: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal('tab.opened') }).strict(),
  z
    .object({ type: z.literal('page.stable'), quietMs: z.number().int().min(300).max(2_000) })
    .strict(),
]);

const actionBase = {
  riskHint: z.enum(['low', 'high']),
  expected: modelExpectedConditionSchema,
};

export const modelBrowserActionSchema = z.discriminatedUnion('type', [
  z.object({ ...actionBase, type: z.literal('click'), target: modelElementTargetSchema }).strict(),
  z
    .object({
      ...actionBase,
      type: z.literal('type'),
      target: modelElementTargetSchema,
      text: z.string().max(20_000),
      replace: z.boolean(),
    })
    .strict(),
  z.object({ ...actionBase, type: z.literal('clear'), target: modelElementTargetSchema }).strict(),
  z
    .object({
      ...actionBase,
      type: z.literal('select'),
      target: modelElementTargetSchema,
      value: z.string().max(2_000),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      type: z.literal('check'),
      target: modelElementTargetSchema,
      checked: z.boolean(),
    })
    .strict(),
  z.object({ ...actionBase, type: z.literal('hover'), target: modelElementTargetSchema }).strict(),
  z
    .object({
      ...actionBase,
      type: z.literal('pressKey'),
      target: modelElementTargetSchema.nullable(),
      key: z.string().min(1).max(100),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      type: z.literal('scroll'),
      target: modelElementTargetSchema.nullable(),
      deltaX: z.number().finite(),
      deltaY: z.number().finite(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      type: z.literal('drag'),
      target: modelElementTargetSchema,
      destination: modelElementTargetSchema,
    })
    .strict(),
  z
    .object({
      ...actionBase,
      type: z.literal('waitFor'),
      timeoutMs: z.number().int().positive().max(15_000),
    })
    .strict(),
]);

export const modelBrowserToolArgumentsSchema = z
  .object({ action: modelBrowserActionSchema })
  .strict();

export type ModelBrowserAction = z.infer<typeof modelBrowserActionSchema>;

const attributeJsonSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, value: { type: 'string' } },
  required: ['name', 'value'],
  additionalProperties: false,
} as const;
const rectJsonSchema = {
  type: 'object',
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', minimum: 0 },
    height: { type: 'number', minimum: 0 },
  },
  required: ['x', 'y', 'width', 'height'],
  additionalProperties: false,
} as const;
const frameSegmentJsonSchema = {
  type: 'object',
  properties: {
    index: { type: 'integer', minimum: 0 },
    name: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    origin: { type: ['string', 'null'] },
  },
  required: ['index', 'name', 'title', 'origin'],
  additionalProperties: false,
} as const;
const shadowSegmentJsonSchema = {
  type: 'object',
  properties: {
    hostRole: { type: ['string', 'null'] },
    hostName: { type: ['string', 'null'] },
    stableAttributes: { type: 'array', items: attributeJsonSchema, maxItems: 20 },
  },
  required: ['hostRole', 'hostName', 'stableAttributes'],
  additionalProperties: false,
} as const;
const semanticTargetJsonSchema = {
  type: 'object',
  properties: {
    framePath: { type: 'array', items: frameSegmentJsonSchema, maxItems: 40 },
    shadowPath: { type: 'array', items: shadowSegmentJsonSchema, maxItems: 40 },
    role: { type: ['string', 'null'] },
    name: { type: ['string', 'null'] },
    label: { type: ['string', 'null'] },
    text: { type: ['string', 'null'] },
    stableAttributes: { type: 'array', items: attributeJsonSchema, maxItems: 20 },
    ancestorHint: { type: ['string', 'null'] },
    lastKnownRect: { anyOf: [rectJsonSchema, { type: 'null' }] },
  },
  required: [
    'framePath',
    'shadowPath',
    'role',
    'name',
    'label',
    'text',
    'stableAttributes',
    'ancestorHint',
    'lastKnownRect',
  ],
  additionalProperties: false,
} as const;

const expectedJsonSchemas = [
  {
    type: 'object',
    properties: { type: { type: 'string', enum: ['url.changed'] }, from: { type: 'string' } },
    required: ['type', 'from'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { type: { type: 'string', enum: ['url.matches'] }, pattern: { type: 'string' } },
    required: ['type', 'pattern'],
    additionalProperties: false,
  },
  ...(['element.value', 'element.visible', 'element.checked', 'element.count'] as const).map(
    (type) => {
      const valueProperty =
        type === 'element.value'
          ? { equals: { type: 'string' } }
          : type === 'element.visible'
            ? { visible: { type: 'boolean' } }
            : type === 'element.checked'
              ? { checked: { type: 'boolean' } }
              : {
                  operator: { type: 'string', enum: ['eq', 'gt', 'lt'] },
                  value: { type: 'integer', minimum: 0 },
                };
      return {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [type] },
          target: semanticTargetJsonSchema,
          ...valueProperty,
        },
        required: ['type', 'target', ...Object.keys(valueProperty)],
        additionalProperties: false,
      };
    },
  ),
  {
    type: 'object',
    properties: { type: { type: 'string', enum: ['text.contains'] }, text: { type: 'string' } },
    required: ['type', 'text'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { type: { type: 'string', enum: ['tab.opened'] } },
    required: ['type'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['page.stable'] },
      quietMs: { type: 'integer', minimum: 300, maximum: 2_000 },
    },
    required: ['type', 'quietMs'],
    additionalProperties: false,
  },
] as const;

const expectedJsonSchema = { anyOf: expectedJsonSchemas } as const;
const actionCommon = {
  riskHint: { type: 'string', enum: ['low', 'high'] },
  expected: expectedJsonSchema,
} as const;

/** Builds one strict action variant for the function-calling JSON schema. */
function actionVariant(
  type: string,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties: { type: { type: 'string', enum: [type] }, ...actionCommon, ...properties },
    required: ['type', 'riskHint', 'expected', ...required],
    additionalProperties: false,
  };
}

const actionJsonSchemas = [
  actionVariant('click', { target: semanticTargetJsonSchema }, ['target']),
  actionVariant(
    'type',
    { target: semanticTargetJsonSchema, text: { type: 'string' }, replace: { type: 'boolean' } },
    ['target', 'text', 'replace'],
  ),
  actionVariant('clear', { target: semanticTargetJsonSchema }, ['target']),
  actionVariant('select', { target: semanticTargetJsonSchema, value: { type: 'string' } }, [
    'target',
    'value',
  ]),
  actionVariant('check', { target: semanticTargetJsonSchema, checked: { type: 'boolean' } }, [
    'target',
    'checked',
  ]),
  actionVariant('hover', { target: semanticTargetJsonSchema }, ['target']),
  actionVariant(
    'pressKey',
    {
      target: { anyOf: [semanticTargetJsonSchema, { type: 'null' }] },
      key: { type: 'string' },
    },
    ['target', 'key'],
  ),
  actionVariant(
    'scroll',
    {
      target: { anyOf: [semanticTargetJsonSchema, { type: 'null' }] },
      deltaX: { type: 'number' },
      deltaY: { type: 'number' },
    },
    ['target', 'deltaX', 'deltaY'],
  ),
  actionVariant(
    'drag',
    { target: semanticTargetJsonSchema, destination: semanticTargetJsonSchema },
    ['target', 'destination'],
  ),
  actionVariant('waitFor', { timeoutMs: { type: 'integer', minimum: 1, maximum: 15_000 } }, [
    'timeoutMs',
  ]),
] as const;

export const BROWSER_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  name: 'browser.act',
  description:
    'Execute exactly one structured browser action against a semantic target copied from the current observation. Never use selectors or executable code.',
  parameters: {
    type: 'object',
    properties: { action: { anyOf: actionJsonSchemas } },
    required: ['action'],
    additionalProperties: false,
  },
  strict: true,
};

/** Serializes an internal semantic target into the strict model-visible attribute-list shape. */
export function serializeModelTarget(target: ElementTarget): Readonly<Record<string, unknown>> {
  const attributes = (values: Readonly<Record<string, string>>) =>
    Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, value }));
  return {
    ...target,
    stableAttributes: attributes(target.stableAttributes),
    shadowPath: target.shadowPath.map((segment) => ({
      ...segment,
      stableAttributes: attributes(segment.stableAttributes),
    })),
  };
}

/** Adds runtime-only IDs and tab binding to one validated model browser action. */
export function bindBrowserToolAction(
  action: ModelBrowserAction,
  input: { readonly actionId: string; readonly tabId: number },
): BrowserActionRequest {
  const { riskHint, expected: modelExpected, ...fields } = action;
  const expected: ExpectedCondition =
    modelExpected.type === 'tab.opened'
      ? { type: 'tab.opened', openerTabId: input.tabId }
      : modelExpected;
  return {
    ...fields,
    actionId: input.actionId,
    tabId: input.tabId,
    risk: riskHint,
    expected,
  } as BrowserActionRequest;
}
