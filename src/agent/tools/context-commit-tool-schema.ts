import { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import {
  parseToolCallArguments,
  type ModelToolCallSource,
} from '../../tools/contracts/tool-call-envelope';

const MAX_CONTEXT_STATE_CHARACTERS = 8_192;
const MAX_CONTEXT_CURSOR_CHARACTERS = 256;

export const CONTEXT_COMMIT_TOOL_NAME = 'commit_context' as const;

const recordedContextCommitSchema = z
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

export type ContextCommitToolInput = z.infer<typeof recordedContextCommitSchema>;

export type RecordedContextCommitToolInput = ContextCommitToolInput;

export type ContextCommitToolCallSource = ModelToolCallSource;

export interface ParsedContextCommitToolCall {
  readonly callId: string;
  readonly name: typeof CONTEXT_COMMIT_TOOL_NAME;
  readonly argumentsJson: string;
  readonly arguments: ContextCommitToolInput;
}

/** Parses the internal AgentPlanner contract without exposing this tool to Codex. */
export function parseContextCommitToolCall(
  input: ContextCommitToolCallSource,
): ParsedContextCommitToolCall {
  try {
    if (input.name !== CONTEXT_COMMIT_TOOL_NAME) {
      throw new Error('Invalid context commit envelope.');
    }
    return {
      callId: input.callId,
      name: CONTEXT_COMMIT_TOOL_NAME,
      argumentsJson: input.argumentsJson,
      arguments: recordedContextCommitSchema.parse(parseToolCallArguments(input)),
    };
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}

/** Parses the one durable record format accepted by current checkpoints. */
export function parseRecordedContextCommitToolCall(
  input: ContextCommitToolCallSource,
): RecordedContextCommitToolInput {
  if (input.name !== CONTEXT_COMMIT_TOOL_NAME) {
    throw new Error('Recorded context commit is invalid.');
  }
  return recordedContextCommitSchema.parse(parseToolCallArguments(input));
}
