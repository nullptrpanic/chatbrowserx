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

const panelGetStateVersionSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('panel.getStateVersion'),
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

const panelGetTaskDetailsSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('panel.getTaskDetails'),
    payload: z.object({ taskId: identifierSchema }).strict(),
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

const chatSupplementSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('chat.supplement'),
    payload: z
      .object({
        taskId: identifierSchema,
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

const sandboxGetConsoleSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('sandbox.getConsole'),
    payload: z.object({}).strict(),
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
        historyMessageLimit: z.number().int().min(1).max(50).default(50),
        codexAccessToken: z.string().trim().min(1).max(20_000).optional(),
        tavilyKey: z.string().trim().min(1).max(20_000).optional(),
        sandboxServer: z.string().trim().max(2_048).optional(),
        sandboxToken: z.string().trim().min(1).max(20_000).optional(),
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
    payload: z.object({ taskId: identifierSchema }).strict(),
  })
  .strict();

const taskRetrySchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('task.retry'),
    payload: z.object({ taskId: identifierSchema }).strict(),
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

const taskClearContextSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('task.clearContext'),
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

const imagePreviewOpenSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('image.preview.open'),
    payload: z
      .object({
        tabId: z.number().int().nonnegative(),
        attachmentId: identifierSchema,
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

export const extensionMessageSchema: z.ZodType<ExtensionMessage> = z.discriminatedUnion('type', [
  systemPingSchema,
  panelGetStateVersionSchema,
  panelGetSnapshotSchema,
  panelGetTaskDetailsSchema,
  chatSubmitSchema,
  chatSupplementSchema,
  conversationClearSchema,
  sandboxGetConsoleSchema,
  settingsGetSchema,
  settingsSaveSchema,
  taskSnapshotSchema,
  taskPauseSchema,
  taskResumeSchema,
  taskRetrySchema,
  taskCancelSchema,
  taskClearContextSchema,
  screenshotCaptureSchema,
  imagePreviewOpenSchema,
  pageFeaturesEnsureSchema,
]);

const pagePingSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.ping'),
    payload: z.object({}).strict(),
  })
  .strict();

const pageContentReadSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.content.read'),
    payload: z.object({}).strict(),
  })
  .strict();

const pageActionPerformSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.action.perform'),
    payload: z.discriminatedUnion('action', [
      z
        .object({
          action: z.literal('click'),
          ref: z.string().trim().min(1).max(128),
          button: z.enum(['left', 'right', 'middle']),
          count: z.union([z.literal(1), z.literal(2)]),
        })
        .strict(),
      z
        .object({
          action: z.literal('type'),
          ref: z.string().trim().min(1).max(128),
          text: z.string().max(20_000),
          replace: z.boolean(),
          submit: z.boolean(),
        })
        .strict(),
      z
        .object({
          action: z.literal('scroll'),
          target: z.string().trim().min(1).max(128),
          deltaX: z.number().int().min(-10_000).max(10_000),
          deltaY: z.number().int().min(-10_000).max(10_000),
        })
        .strict()
        .refine(({ deltaX, deltaY }) => deltaX !== 0 || deltaY !== 0),
      z
        .object({
          action: z.literal('select'),
          ref: z.string().trim().min(1).max(128),
          value: z.string().max(2_000),
        })
        .strict(),
    ]),
  })
  .strict();

const pointerCoordinateSchema = z.number().finite().min(0).max(1_000_000);
const pagePointerShowSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.pointer.show'),
    payload: z
      .object({
        x: pointerCoordinateSchema,
        y: pointerCoordinateSchema,
        fromX: pointerCoordinateSchema,
        fromY: pointerCoordinateSchema,
        effect: z.enum(['move', 'click', 'double_click', 'drag']),
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

const pageImagePreviewOpenSchema = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: requestIdSchema,
    type: z.literal('page.imagePreview.open'),
    payload: z
      .object({
        src: z
          .string()
          .min(1)
          .max(14_000_000)
          .refine((value) =>
            [
              'data:image/png;base64,',
              'data:image/jpeg;base64,',
              'data:image/webp;base64,',
              'data:image/gif;base64,',
            ].some((prefix) => value.startsWith(prefix)),
          ),
        alt: z.string().max(500),
      })
      .strict(),
  })
  .strict();

export const pageCommandSchema: z.ZodType<PageCommand> = z.discriminatedUnion('type', [
  pagePingSchema,
  pageContentReadSchema,
  pageActionPerformSchema,
  pagePointerShowSchema,
  pageScreenshotSelectSchema,
  pageOverlaysSetHiddenSchema,
  pageImagePreviewOpenSchema,
]);
