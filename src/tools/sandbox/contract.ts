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
  'Run one necessary Bash command on the configured Sandbox. Honor an explicit user choice of CLI/Skill or browser; otherwise prefer built-in tools for overlapping capabilities. Resolve Skill-relative commands from the SKILL.md directory. Prefer direct bounded stdout for ordinary reads (output is capped at 64 KiB). Use a file and sandbox_read only for expected oversized or actually truncated output. Reuse successful results; do not refetch or pretty-print through another process merely to read them. Empty stdout may be normal for writes or redirection: check exit code, stderr and intended effects before retrying.',
  {
    command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND_CHARACTERS },
    cwd: { type: ['string', 'null'], minLength: 1, maxLength: MAX_PATH_CHARACTERS },
  },
);

export type SandboxToolCall =
  | (ValidatedToolCall<SandboxReadInput> & {
      readonly name: 'sandbox_read';
      readonly operation: 'read';
    })
  | (ValidatedToolCall<SandboxExecInput> & {
      readonly name: 'sandbox_exec';
      readonly operation: 'exec';
    });
