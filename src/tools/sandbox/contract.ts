import { z } from 'zod';
import { strictFunctionTool } from '../model-tool';
import type { ValidatedToolCall } from '../types';

const MAX_PATH_CHARACTERS = 4_096;
const MAX_COMMAND_CHARACTERS = 20_000;
const MAX_SKILL_QUERY_CHARACTERS = 200;
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

export const skillSearchSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(MAX_SKILL_QUERY_CHARACTERS)
      .refine((value) => value.trim().length > 0),
    limit: z.number().int().min(1).max(10),
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
export type SandboxSkillSearchInput = z.infer<typeof skillSearchSchema>;

export const skillSearchDefinition = strictFunctionTool(
  'skill_search',
  'Search installed Sandbox Skills by a concise capability query. Use only when no built-in ChatBrowserX tool covers the task or the user explicitly requests a Skill. Do not use it for current-page content or actions. Read a selected SKILL.md completely with sandbox_read before following it.',
  {
    query: { type: 'string', minLength: 1, maxLength: MAX_SKILL_QUERY_CHARACTERS },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
  },
);

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
