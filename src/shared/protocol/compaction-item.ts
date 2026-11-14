import { z } from 'zod';

/** Compaction material must be replayable before it is saved or restored. */
export const compactionItemSchema = z.object({
  type: z.literal('compaction'),
  id: z.string().optional(),
  encrypted_content: z.string().refine((content) => content.trim().length > 0),
});
