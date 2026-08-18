import { z } from 'zod';
import type {
  PanelEditableSettings,
  PanelSettingsSnapshot,
  PanelSnapshot,
} from '../../shared/protocol/panel-types';

const taskStatusSchema = z.enum([
  'queued',
  'planning',
  'waiting_for_auth',
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
    historyMessageLimit: z.number().int().min(1).max(50).default(50),
    hasCodexToken: z.boolean(),
    hasTavilyKey: z.boolean().default(false),
  })
  .strict();
const editableSettingsSchema = z
  .object({
    model: z.string().min(1).max(256),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
    systemPrompt: z.string().max(20_000),
    language: z.enum(['system', 'zh-CN', 'en', 'ja']),
    historyMessageLimit: z.number().int().min(1).max(50).default(50),
    codexAccessToken: z.string().max(20_000),
    tavilyKey: z.string().max(20_000),
  })
  .strict();
const completedToolResultSchema = z
  .object({
    callId: idSchema,
    toolName: z.string().min(1).max(128),
    argumentsJson: z.string().max(20_000),
    output: z.string().max(100_000),
    resultRef: z.string().max(512),
    attachmentIds: z.array(idSchema).max(8).default([]),
  })
  .strict();
const taskSupplementSchema = z
  .object({
    id: idSchema,
    text: z.string().max(20_000),
    attachmentIds: z.array(idSchema).max(8),
    createdAt: timestampSchema,
  })
  .strict();
const panelTaskSchema = z
  .object({
    id: idSchema,
    status: taskStatusSchema,
    goal: z.string().max(20_000),
    tabId: z.number().int().nonnegative().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    sequence: z.number().int().nonnegative(),
    lastError: z
      .object({
        code: z.string().max(128),
        retryable: z.boolean(),
        userMessage: z.string().max(2_000),
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
            reasoningSummary: z.string().max(20_000).optional(),
          })
          .strict(),
      )
      .max(100),
    completedToolResults: z.array(completedToolResultSchema).max(20),
    supplements: z.array(taskSupplementSchema).max(100).default([]),
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
      })
      .strict(),
    conversation: conversationSchema.nullable(),
    conversations: z.array(conversationSchema).max(1_000),
    messages: z
      .array(
        z
          .object({
            id: idSchema,
            taskId: idSchema.nullable(),
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
    tasks: z.array(panelTaskSchema).max(500),
    task: panelTaskSchema.nullable(),
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

/** Parses the credential-bearing response requested only by the trusted settings screen. */
export function parsePanelEditableSettings(value: unknown): PanelEditableSettings {
  const parsed = editableSettingsSchema.safeParse(value);
  if (!parsed.success) throw new Error('Editable panel settings are invalid.');
  return parsed.data;
}
