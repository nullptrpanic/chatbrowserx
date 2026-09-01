import { z } from 'zod';
import { strictFunctionTool } from '../model-tool';

const MAX_CURSOR_CHARACTERS = 1_024;
const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_HISTORY_ITEMS = 100;
const MAX_RESULT_CHARACTERS = 20_000;

export const historyReadSchema = z
  .object({
    taskId: z.string().min(1).max(MAX_IDENTIFIER_CHARACTERS).nullable(),
    offset: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
    cursor: z.string().max(MAX_CURSOR_CHARACTERS),
    limit: z.number().int().min(1).max(MAX_HISTORY_ITEMS),
  })
  .strict()
  .refine(({ taskId, offset }) => (taskId === null) !== (offset === null));

export const historyReadDefinition = strictFunctionTool(
  'history_read',
  'Read one bounded page from a previous logical task. Set taskId to a stable task identifier and offset to null for an exact read. Set taskId to null and offset to a one-based relative position when no stable identifier is available; offset 1 is the immediately previous task. Exactly one selector must be non-null. Start with an empty cursor and continue with nextCursor while hasMore is true.',
  {
    taskId: { type: ['string', 'null'], minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
    offset: { type: ['integer', 'null'], minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    cursor: { type: 'string', maxLength: MAX_CURSOR_CHARACTERS },
    limit: { type: 'integer', minimum: 1, maximum: MAX_HISTORY_ITEMS },
  },
);

export const resultReadSchema = z
  .object({
    resultId: z.string().min(1).max(MAX_IDENTIFIER_CHARACTERS),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(MAX_RESULT_CHARACTERS),
  })
  .strict();

export const resultReadDefinition = strictFunctionTool(
  'result_read',
  'Read an exact bounded character range from a tool result referenced by history_read. Continue from nextOffset while hasMore is true.',
  {
    resultId: { type: 'string', minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_CHARACTERS },
  },
);
