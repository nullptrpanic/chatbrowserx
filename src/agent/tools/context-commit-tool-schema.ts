import { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import type { ModelToolDefinition } from '../../providers/provider-types';

const MAX_TOOL_CALL_ID_CHARACTERS = 256;
const MAX_TOOL_ARGUMENTS_JSON_CHARACTERS = 32 * 1_024;
const MAX_CONTEXT_STATE_CHARACTERS = 8_192;

export const CONTEXT_COMMIT_TOOL_NAME = 'commit_context' as const;

export const contextCommitToolSchema = z
  .object({
    state: z
      .string()
      .min(1)
      .max(MAX_CONTEXT_STATE_CHARACTERS)
      .refine((value) => value.trim().length > 0),
  })
  .strict();

export type ContextCommitToolInput = z.infer<typeof contextCommitToolSchema>;

export interface ContextCommitToolCallSource {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ParsedContextCommitToolCall {
  readonly callId: string;
  readonly name: typeof CONTEXT_COMMIT_TOOL_NAME;
  readonly argumentsJson: string;
  readonly arguments: ContextCommitToolInput;
}

export const CONTEXT_COMMIT_TOOL_DEFINITION: ModelToolDefinition = {
  type: 'function',
  name: CONTEXT_COMMIT_TOOL_NAME,
  description:
    'Commit a self-contained working-state checkpoint. Call this when the current ' +
    'working state should replace the raw tool calls and tool outputs that came before ' +
    'this call, for example after completing a meaningful phase or establishing a new ' +
    'stable task state. Future model requests will omit those earlier tool calls and ' +
    'outputs and retain this checkpoint instead. The state must preserve the user goal, ' +
    'constraints, verified facts, current browser or task state, unresolved issues, ' +
    'important evidence, and the exact next step. This operation does not delete user ' +
    'messages, system instructions, or local audit records. Do not call immediately ' +
    'before a final answer unless the checkpoint is needed for later continuation.',
  parameters: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_CONTEXT_STATE_CHARACTERS,
        description:
          'A concise, self-contained working-state summary. Include everything needed ' +
          'to continue correctly without reading the earlier raw tool results.',
      },
    },
    required: ['state'],
    additionalProperties: false,
  },
  strict: true,
};

/** Parses one internal context commit while replacing unsafe validation details. */
export function parseContextCommitToolCall(
  input: ContextCommitToolCallSource,
): ParsedContextCommitToolCall {
  try {
    if (
      input.callId.trim().length === 0 ||
      input.callId.length > MAX_TOOL_CALL_ID_CHARACTERS ||
      input.name !== CONTEXT_COMMIT_TOOL_NAME ||
      input.argumentsJson.length > MAX_TOOL_ARGUMENTS_JSON_CHARACTERS
    ) {
      throw new Error('Invalid context commit envelope.');
    }
    const value: unknown = JSON.parse(input.argumentsJson);
    return {
      callId: input.callId,
      name: CONTEXT_COMMIT_TOOL_NAME,
      argumentsJson: input.argumentsJson,
      arguments: contextCommitToolSchema.parse(value),
    };
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}
