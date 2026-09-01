import { z } from 'zod';
import { providerErrorFromCode } from '../../agent/model/model-provider-error';
import type { ModelCompactionResult } from '../../agent/model/model-provider';

const MAX_COMPACT_OUTPUT_ITEMS = 256;
const MAX_COMPACT_ENCRYPTED_CHARACTERS = 8 * 1024 * 1024;

const compactMessageSchema = z
  .object({
    type: z.literal('message'),
    role: z.literal('user'),
  })
  .passthrough();

const compactItemSchema = z
  .object({
    type: z.literal('compaction'),
    id: z.string().min(1).max(256),
    encrypted_content: z.string().min(1).max(MAX_COMPACT_ENCRYPTED_CHARACTERS),
  })
  .passthrough();

const compactResponseSchema = z
  .object({
    output: z
      .array(z.union([compactMessageSchema, compactItemSchema]))
      .max(MAX_COMPACT_OUTPUT_ITEMS),
  })
  .passthrough();

/** Extracts one terminal opaque compaction boundary without retaining returned message content. */
export function parseCodexCompactResponse(value: unknown): ModelCompactionResult {
  const parsed = compactResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.output.length === 0) {
    throw providerErrorFromCode('INVALID_RESPONSE', {
      invalidResponseStage: 'compaction_schema',
    });
  }
  const compactItems = parsed.data.output.filter(
    (item): item is z.infer<typeof compactItemSchema> => item.type === 'compaction',
  );
  const terminal = parsed.data.output.at(-1);
  if (compactItems.length !== 1 || terminal?.type !== 'compaction') {
    throw providerErrorFromCode('INVALID_RESPONSE', {
      invalidResponseStage: 'compaction_schema',
    });
  }
  return {
    itemId: terminal.id,
    encryptedContent: terminal.encrypted_content,
  };
}
