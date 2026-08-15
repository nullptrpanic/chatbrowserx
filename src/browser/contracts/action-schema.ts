import { z } from 'zod';
import type { BrowserActionRequest } from './action';
import type { ElementTarget } from './target';
import type { ExpectedCondition } from '../verify/expected-condition';

const rectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
  })
  .strict();

const frameSegmentSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().max(200).nullable(),
    title: z.string().max(200).nullable(),
    origin: z.string().max(2_000).nullable(),
  })
  .strict();

const shadowSegmentSchema = z
  .object({
    hostRole: z.string().max(80).nullable(),
    hostName: z.string().max(200).nullable(),
    stableAttributes: z.record(z.string().max(80), z.string().max(200)),
  })
  .strict();

export const elementTargetSchema: z.ZodType<ElementTarget> = z
  .object({
    framePath: z.array(frameSegmentSchema).max(40),
    shadowPath: z.array(shadowSegmentSchema).max(40),
    role: z.string().max(80).nullable(),
    name: z.string().max(500).nullable(),
    label: z.string().max(500).nullable(),
    text: z.string().max(2_000).nullable(),
    stableAttributes: z.record(z.string().max(80), z.string().max(200)),
    ancestorHint: z.string().max(500).nullable(),
    lastKnownRect: rectSchema.nullable(),
  })
  .strict();

export const expectedConditionSchema: z.ZodType<ExpectedCondition> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('url.changed'), from: z.string().max(2_000) }).strict(),
  z.object({ type: z.literal('url.matches'), pattern: z.string().min(1).max(500) }).strict(),
  z
    .object({
      type: z.literal('element.value'),
      target: elementTargetSchema,
      equals: z.string().max(20_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('element.visible'),
      target: elementTargetSchema,
      visible: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('element.checked'),
      target: elementTargetSchema,
      checked: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('text.contains'), text: z.string().min(1).max(2_000) }).strict(),
  z
    .object({
      type: z.literal('element.count'),
      target: elementTargetSchema,
      operator: z.enum(['eq', 'gt', 'lt']),
      value: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ type: z.literal('tab.opened'), openerTabId: z.number().int().nonnegative() }).strict(),
  z
    .object({ type: z.literal('page.stable'), quietMs: z.number().int().min(300).max(2_000) })
    .strict(),
]);

const actionBase = {
  actionId: z.string().trim().min(1).max(256),
  tabId: z.number().int().nonnegative(),
  risk: z.enum(['low', 'high']),
  expected: expectedConditionSchema,
};

export const browserActionRequestSchema: z.ZodType<BrowserActionRequest> = z.discriminatedUnion(
  'type',
  [
    z.object({ ...actionBase, type: z.literal('click'), target: elementTargetSchema }).strict(),
    z
      .object({
        ...actionBase,
        type: z.literal('type'),
        target: elementTargetSchema,
        text: z.string().max(20_000),
        replace: z.boolean(),
      })
      .strict(),
    z.object({ ...actionBase, type: z.literal('clear'), target: elementTargetSchema }).strict(),
    z
      .object({
        ...actionBase,
        type: z.literal('select'),
        target: elementTargetSchema,
        value: z.string().max(2_000),
      })
      .strict(),
    z
      .object({
        ...actionBase,
        type: z.literal('check'),
        target: elementTargetSchema,
        checked: z.boolean(),
      })
      .strict(),
    z.object({ ...actionBase, type: z.literal('hover'), target: elementTargetSchema }).strict(),
    z
      .object({
        ...actionBase,
        type: z.literal('pressKey'),
        target: elementTargetSchema.nullable(),
        key: z.string().min(1).max(100),
      })
      .strict(),
    z
      .object({
        ...actionBase,
        type: z.literal('scroll'),
        target: elementTargetSchema.nullable(),
        deltaX: z.number().finite(),
        deltaY: z.number().finite(),
      })
      .strict(),
    z
      .object({
        ...actionBase,
        type: z.literal('drag'),
        target: elementTargetSchema,
        destination: elementTargetSchema,
      })
      .strict(),
    z
      .object({
        ...actionBase,
        type: z.literal('waitFor'),
        timeoutMs: z.number().int().positive().max(15_000),
      })
      .strict(),
  ],
);
