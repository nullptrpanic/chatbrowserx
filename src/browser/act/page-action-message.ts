import { z } from 'zod';
import { PROTOCOL_VERSION, type Message } from '../../shared/protocol/message-types';
import type { BrowserActionRequest } from '../contracts/action';
import { browserActionRequestSchema } from '../contracts/action-schema';

export type PageActionCommand = Message<'page.domAction', { action: BrowserActionRequest }>;

const pageActionCommandSchema: z.ZodType<PageActionCommand> = z
  .object({
    version: z.literal(PROTOCOL_VERSION),
    requestId: z.string().trim().min(1).max(128),
    type: z.literal('page.domAction'),
    payload: z.object({ action: browserActionRequestSchema }).strict(),
  })
  .strict();

/** Validates a structured browser action without accepting executable source or extra fields. */
export function parsePageActionCommand(value: unknown): PageActionCommand {
  const result = pageActionCommandSchema.safeParse(value);
  if (result.success) return result.data;
  throw new Error('Invalid page action command.');
}
