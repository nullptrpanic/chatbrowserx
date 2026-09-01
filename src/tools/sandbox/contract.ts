import { z } from 'zod';
import { strictFunctionTool } from '../model-tool';
import type { ValidatedToolCall } from '../types';

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

export type SandboxReadInput = z.infer<typeof sandboxReadSchema>;
export type SandboxExecInput = z.infer<typeof sandboxExecSchema>;

export const sandboxReadDefinition = strictFunctionTool(
  'sandbox_read',
  'Read a bounded range from an absolute text-file path on the configured Sandbox. Read a selected SKILL.md completely before following it, continuing with later line ranges when truncated.',
  {
    path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARACTERS },
    startLine: { type: 'integer', minimum: 1 },
    maxLines: { type: 'integer', minimum: 1, maximum: 400 },
  },
);

export const sandboxExecDefinition = strictFunctionTool(
  'sandbox_exec',
  'Run one necessary Bash command on the configured Sandbox. Prefer built-in ChatBrowserX tools for overlapping capabilities. Resolve Skill-relative commands from the SKILL.md directory. Redirect large output to a file and paginate it with sandbox_read.',
  {
    command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND_CHARACTERS },
    cwd: { type: ['string', 'null'], minLength: 1, maxLength: MAX_PATH_CHARACTERS },
  },
);

export type SandboxToolCall =
  | (ValidatedToolCall<SandboxReadInput> & {
      readonly name: 'sandbox_read';
      readonly family: 'sandbox';
      readonly operation: 'read';
      readonly replay: 'safe';
    })
  | (ValidatedToolCall<SandboxExecInput> & {
      readonly name: 'sandbox_exec';
      readonly family: 'sandbox';
      readonly operation: 'exec';
      readonly replay: 'mutation';
    });
