import { z } from 'zod';
import { PROTOCOL_VERSION, type ExtensionMessage, type PageCommand } from './message-types';

const requestIdSchema = z.string().trim().min(1).max(128);
const identifierSchema = z.string().trim().min(1).max(256);

const systemPingSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('system.ping'),
    payload: z.object({}).strict(),
  })
  .strict();

const panelGetSnapshotSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('panel.getSnapshot'),
    payload: z
      .object({
        tabId: z.number().int().nonnegative(),
        conversationId: identifierSchema.optional(),
      })
      .strict(),
  })
  .strict();

const chatSubmitSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('chat.submit'),
    payload: z
      .object({
        tabId: z.number().int().nonnegative(),
        conversationId: identifierSchema.optional(),
        text: z.string().max(20_000),
        attachmentIds: z.array(identifierSchema).max(8),
      })
      .strict()
      .refine((value) => value.text.trim().length > 0 || value.attachmentIds.length > 0),
  })
  .strict();

const conversationClearSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('conversation.clear'),
    payload: z.object({ conversationId: identifierSchema }).strict(),
  })
  .strict();

const settingsGetSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('settings.get'),
    payload: z.object({}).strict(),
  })
  .strict();

const settingsSaveSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('settings.save'),
    payload: z
      .object({
        reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
        systemPrompt: z.string().max(20_000),
        language: z.enum(['system', 'zh-CN', 'en', 'ja']),
        codexAccessToken: z.string().trim().min(1).max(20_000).optional(),
        tavilyKey: z.string().trim().min(1).max(4_096).optional(),
      })
      .strict(),
  })
  .strict();

const taskCreateSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('task.create'),
    payload: z
      .object({
        tabId: z.number().int().nonnegative(),
        conversationId: identifierSchema,
        goal: z.string().trim().min(1).max(20_000),
      })
      .strict(),
  })
  .strict();

const taskSnapshotSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('task.getSnapshot'),
    payload: z.object({ taskId: identifierSchema }).strict(),
  })
  .strict();

const taskPauseSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('task.pause'),
    payload: z.object({ taskId: identifierSchema }).strict(),
  })
  .strict();

const taskResumeSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('task.resume'),
    payload: z
      .object({ taskId: identifierSchema, tabId: z.number().int().nonnegative().optional() })
      .strict(),
  })
  .strict();

const taskConfirmSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('task.confirm'),
    payload: z
      .object({
        taskId: identifierSchema,
        actionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
  })
  .strict();

const taskCancelSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('task.cancel'),
    payload: z.object({ taskId: identifierSchema }).strict(),
  })
  .strict();

const screenshotCaptureSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('screenshot.capture'),
    payload: z
      .object({
        tabId: z.number().int().nonnegative(),
        mode: z.enum(['viewport', 'region']),
      })
      .strict(),
  })
  .strict();

const pageFeaturesEnsureSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.features.ensure'),
    payload: z.object({ tabId: z.number().int().nonnegative() }).strict(),
  })
  .strict();

const selectionTextPayloadSchema = z
  .object({
    text: z.string().trim().min(1).max(8_000),
    pageUrl: z.string().max(4_096),
    pageTitle: z.string().max(500),
  })
  .strict();

const selectionTranslateSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('selection.translate'),
    payload: selectionTextPayloadSchema,
  })
  .strict();

const selectionAskSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('selection.ask'),
    payload: selectionTextPayloadSchema.extend({ question: z.string().max(4_000) }).strict(),
  })
  .strict();

export const extensionMessageSchema: z.ZodType<ExtensionMessage> = z.discriminatedUnion('type', [
  systemPingSchema,
  panelGetSnapshotSchema,
  chatSubmitSchema,
  conversationClearSchema,
  settingsGetSchema,
  settingsSaveSchema,
  taskCreateSchema,
  taskSnapshotSchema,
  taskPauseSchema,
  taskResumeSchema,
  taskConfirmSchema,
  taskCancelSchema,
  screenshotCaptureSchema,
  pageFeaturesEnsureSchema,
  selectionTranslateSchema,
  selectionAskSchema,
]);

const pagePingSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.ping'),
    payload: z.object({}).strict(),
  })
  .strict();

const pageObserveSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.observe'),
    payload: z
      .object({
        observationId: identifierSchema,
        tabId: z.number().int().nonnegative(),
        capturedAt: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

const pageScreenshotSelectSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.screenshot.select'),
    payload: z.object({}).strict(),
  })
  .strict();

const pageOverlaysSetHiddenSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.overlays.setHidden'),
    payload: z.object({ hidden: z.boolean() }).strict(),
  })
  .strict();

const pageActionFeedbackSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.actionFeedback'),
    payload: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('move'),
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('click'),
          x: z.number().finite(),
          y: z.number().finite(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('drag'),
          fromX: z.number().finite(),
          fromY: z.number().finite(),
          toX: z.number().finite(),
          toY: z.number().finite(),
        })
        .strict(),
      z.object({ kind: z.literal('hide') }).strict(),
    ]),
  })
  .strict();

export const pageCommandSchema: z.ZodType<PageCommand> = z.discriminatedUnion('type', [
  pagePingSchema,
  pageObserveSchema,
  pageScreenshotSelectSchema,
  pageOverlaysSetHiddenSchema,
  pageActionFeedbackSchema,
]);
