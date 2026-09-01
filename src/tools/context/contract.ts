import { z } from 'zod';
import { strictFunctionTool } from '../model-tool';
import { parseToolCallArguments, type ModelToolCallSource } from '../tool-call-envelope';

const MAX_CONTEXT_STATE_CHARACTERS = 8_192;
const MAX_CONTEXT_CURSOR_CHARACTERS = 256;

export const CONTEXT_COMMIT_TOOL_NAME = 'commit_context' as const;

export const contextCommitSchema = z
  .object({
    state: z
      .string()
      .min(1)
      .max(MAX_CONTEXT_STATE_CHARACTERS)
      .refine((value) => value.trim().length > 0),
    throughCallId: z
      .string()
      .min(1)
      .max(MAX_CONTEXT_CURSOR_CHARACTERS)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

export type ContextCommitToolInput = z.infer<typeof contextCommitSchema>;

export type RecordedContextCommitToolInput = ContextCommitToolInput;

export type ContextCommitToolCallSource = ModelToolCallSource;

export interface ParsedContextCommitToolCall {
  readonly callId: string;
  readonly name: typeof CONTEXT_COMMIT_TOOL_NAME;
  readonly argumentsJson: string;
  readonly arguments: ContextCommitToolInput;
}

export const contextCommitDefinition = strictFunctionTool(
  CONTEXT_COMMIT_TOOL_NAME,
  'Commit a concise durable state and release completed tool-call context through one exact call ID.',
  {
    state: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_CONTEXT_STATE_CHARACTERS,
    },
    throughCallId: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_CONTEXT_CURSOR_CHARACTERS,
    },
  },
);

/** Parses one validated context commit call. */
export function parseContextCommitToolCall(
  input: ContextCommitToolCallSource,
): ParsedContextCommitToolCall {
  if (input.name !== CONTEXT_COMMIT_TOOL_NAME) {
    throw new Error('Invalid context commit envelope.');
  }
  return {
    callId: input.callId,
    name: CONTEXT_COMMIT_TOOL_NAME,
    argumentsJson: input.argumentsJson,
    arguments: contextCommitSchema.parse(parseToolCallArguments(input)),
  };
}

/** Parses the one durable record format accepted by current checkpoints. */
export function parseRecordedContextCommitToolCall(
  input: ContextCommitToolCallSource,
): RecordedContextCommitToolInput {
  if (input.name !== CONTEXT_COMMIT_TOOL_NAME) {
    throw new Error('Recorded context commit is invalid.');
  }
  return contextCommitSchema.parse(parseToolCallArguments(input));
}
