import { z } from 'zod';
import type { PanelSettingsSnapshot, PanelSnapshot } from '../../shared/protocol/panel-types';

const taskStatusSchema = z.enum([
  'queued',
  'observing',
  'planning',
  'acting',
  'verifying',
  'checkpointed',
  'waiting_for_tab',
  'waiting_for_auth',
  'waiting_for_confirmation',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
const idSchema = z.string().min(1).max(256);
const timestampSchema = z.number().finite().nonnegative();
const conversationSchema = z
  .object({
    id: idSchema,
    title: z.string().max(500),
    tabId: z.number().int().nonnegative().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    taskStatus: taskStatusSchema.nullable(),
  })
  .strict();
const settingsSchema = z
  .object({
    model: z.string().min(1).max(256),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
    systemPrompt: z.string().max(20_000),
    language: z.enum(['system', 'zh-CN', 'en', 'ja']),
    hasCodexToken: z.boolean(),
    hasTavilyKey: z.boolean(),
  })
  .strict();

export const panelSnapshotSchema: z.ZodType<PanelSnapshot> = z
  .object({
    generatedAt: timestampSchema,
    tab: z
      .object({
        id: z.number().int().nonnegative(),
        title: z.string().max(500),
        url: z.string().max(4_096),
        origin: z.string().max(4_096),
        supported: z.boolean(),
        hasPermission: z.boolean(),
        debuggerAttached: z.boolean(),
      })
      .strict(),
    conversation: conversationSchema.nullable(),
    conversations: z.array(conversationSchema).max(1_000),
    messages: z
      .array(
        z
          .object({
            id: idSchema,
            role: z.enum(['user', 'assistant', 'system']),
            status: z.enum(['complete', 'streaming', 'interrupted', 'error']),
            text: z.string().max(1_000_000),
            attachmentIds: z.array(idSchema).max(64),
            createdAt: timestampSchema,
            updatedAt: timestampSchema,
          })
          .strict(),
      )
      .max(500),
    attachments: z
      .array(
        z
          .object({
            id: idSchema,
            mimeType: z.string().max(256),
            byteSize: z.number().int().nonnegative(),
            width: z.number().int().positive().nullable(),
            height: z.number().int().positive().nullable(),
            source: z.string().max(128),
            fileName: z.string().max(255).nullable(),
          })
          .strict(),
      )
      .max(4_000),
    task: z
      .object({
        id: idSchema,
        status: taskStatusSchema,
        goal: z.string().max(20_000),
        tabId: z.number().int().nonnegative().nullable(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
        sequence: z.number().int().nonnegative(),
        browserActionsUsed: z.number().int().nonnegative(),
        browserActionsLimit: z.number().int().positive(),
        lastError: z
          .object({
            code: z.string().max(128),
            retryable: z.boolean(),
            userMessage: z.string().max(2_000),
          })
          .strict()
          .nullable(),
        pendingConfirmation: z
          .object({
            digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
            actionKind: z.string().max(64),
            targetLabel: z.string().max(500).nullable(),
          })
          .strict()
          .nullable(),
        events: z
          .array(
            z
              .object({
                sequence: z.number().int().positive(),
                type: z.string().max(128),
                reason: z.string().max(500),
                at: timestampSchema,
              })
              .strict(),
          )
          .max(100),
      })
      .strict()
      .nullable(),
    settings: settingsSchema,
  })
  .strict();

/** Parses one untrusted runtime payload into the exact sanitized panel snapshot contract. */
export function parsePanelSnapshot(value: unknown): PanelSnapshot {
  const parsed = panelSnapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error('Panel snapshot is invalid.');
  return parsed.data;
}

/** Parses the sanitized response returned immediately after a trusted settings save. */
export function parsePanelSettings(value: unknown): PanelSettingsSnapshot {
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Panel settings are invalid.');
  return parsed.data;
}
