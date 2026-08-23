import { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import type { ModelToolDefinition } from '../../providers/provider-types';

const MAX_TOOL_CALL_ID_CHARACTERS = 256;
const MAX_TOOL_ARGUMENTS_JSON_CHARACTERS = 32 * 1_024;
const MAX_PATH_CHARACTERS = 4_096;
const MAX_COMMAND_CHARACTERS = 20_000;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARACTERS)
  .refine((value) => value.trim() === value && value.startsWith('/'));

export const sandboxReadSchema = z
  .object({
    path: absolutePathSchema,
    startLine: z.number().int().min(1),
    maxLines: z.number().int().min(1).max(400),
  })
  .strict();

export const sandboxExecSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(MAX_COMMAND_CHARACTERS)
      .refine((value) => value.trim().length > 0),
    cwd: z
      .string()
      .min(1)
      .max(MAX_PATH_CHARACTERS)
      .refine((value) => value.trim() === value)
      .nullable(),
  })
  .strict();

export type SandboxReadToolInput = z.infer<typeof sandboxReadSchema>;
export type SandboxExecToolInput = z.infer<typeof sandboxExecSchema>;

export type ParsedSandboxToolCall =
  | {
      readonly family: 'sandbox';
      readonly operation: 'read';
      readonly replay: 'safe';
      readonly callId: string;
      readonly name: 'sandbox_read';
      readonly argumentsJson: string;
      readonly arguments: SandboxReadToolInput;
    }
  | {
      readonly family: 'sandbox';
      readonly operation: 'exec';
      readonly replay: 'mutation';
      readonly callId: string;
      readonly name: 'sandbox_exec';
      readonly argumentsJson: string;
      readonly arguments: SandboxExecToolInput;
    };

export interface SandboxToolCallSource {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export const SANDBOX_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    type: 'function',
    name: 'sandbox_read',
    description:
      'Read a bounded range from an absolute text-file path on the configured Sandbox. Read a selected SKILL.md completely before following it, continuing with later line ranges when truncated.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARACTERS },
        startLine: { type: 'integer', minimum: 1 },
        maxLines: { type: 'integer', minimum: 1, maximum: 400 },
      },
      required: ['path', 'startLine', 'maxLines'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'sandbox_exec',
    description:
      'Run one necessary Bash command on the configured Sandbox. Prefer built-in ChatBrowserX tools for overlapping capabilities. Resolve Skill-relative commands from the SKILL.md directory. Redirect large output to a file and paginate it with sandbox_read.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND_CHARACTERS },
        cwd: { type: ['string', 'null'], minLength: 1, maxLength: MAX_PATH_CHARACTERS },
      },
      required: ['command', 'cwd'],
      additionalProperties: false,
    },
    strict: true,
  },
];

export function parseSandboxToolCall(input: SandboxToolCallSource): ParsedSandboxToolCall {
  try {
    if (
      input.callId.trim().length === 0 ||
      input.callId.length > MAX_TOOL_CALL_ID_CHARACTERS ||
      input.argumentsJson.length > MAX_TOOL_ARGUMENTS_JSON_CHARACTERS
    ) {
      throw new Error('Invalid Sandbox tool call envelope.');
    }
    const value: unknown = JSON.parse(input.argumentsJson);
    if (input.name === 'sandbox_read') {
      return {
        family: 'sandbox',
        operation: 'read',
        replay: 'safe',
        callId: input.callId,
        name: 'sandbox_read',
        argumentsJson: input.argumentsJson,
        arguments: sandboxReadSchema.parse(value),
      };
    }
    if (input.name === 'sandbox_exec') {
      return {
        family: 'sandbox',
        operation: 'exec',
        replay: 'mutation',
        callId: input.callId,
        name: 'sandbox_exec',
        argumentsJson: input.argumentsJson,
        arguments: sandboxExecSchema.parse(value),
      };
    }
    throw new Error('Unsupported Sandbox tool.');
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}
