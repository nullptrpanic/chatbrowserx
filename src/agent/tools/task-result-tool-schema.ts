import { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import type {
  HistoricalToolResultReadInput,
  HistoricalToolResultSearchInput,
} from '../../tasks/historical-tool-results';
import { strictFunctionTool } from '../../tools/contracts/model-tool';
import {
  parseToolCallArguments,
  type ModelToolCallSource,
} from '../../tools/contracts/tool-call-envelope';

const MAX_QUERY_CHARACTERS = 1_024;
const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_TOOL_NAME_CHARACTERS = 128;
const MAX_SEARCH_RESULTS = 20;
const MAX_READ_CHARACTERS = 20_000;
const validToolNamePattern = '^[a-zA-Z0-9_-]+$';

export const taskResultSearchSchema = z
  .object({
    scope: z.enum(['previous_task', 'current_conversation', 'task_id']),
    taskId: z.string().min(1).max(MAX_IDENTIFIER_CHARACTERS).nullable(),
    query: z.string().max(MAX_QUERY_CHARACTERS),
    toolName: z
      .string()
      .min(1)
      .max(MAX_TOOL_NAME_CHARACTERS)
      .regex(new RegExp(validToolNamePattern))
      .nullable(),
    limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.scope === 'task_id') !== (value.taskId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['taskId'],
        message: 'taskId is required only for task_id scope.',
      });
    }
  });

export const taskResultReadSchema = z
  .object({
    evidenceId: z.string().min(1).max(MAX_IDENTIFIER_CHARACTERS),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(MAX_READ_CHARACTERS),
  })
  .strict();

export type ParsedTaskResultToolCall =
  | {
      readonly family: 'task_result';
      readonly operation: 'search';
      readonly replay: 'safe';
      readonly callId: string;
      readonly name: 'task_result_search';
      readonly argumentsJson: string;
      readonly arguments: HistoricalToolResultSearchInput;
    }
  | {
      readonly family: 'task_result';
      readonly operation: 'read';
      readonly replay: 'safe';
      readonly callId: string;
      readonly name: 'task_result_read';
      readonly argumentsJson: string;
      readonly arguments: HistoricalToolResultReadInput;
    };

export const TASK_RESULT_TOOL_DEFINITIONS = [
  strictFunctionTool(
    'task_result_search',
    'Search bounded metadata for exact tool evidence retained by terminal tasks in this conversation. Use previous_task for the latest completed, failed, or cancelled WorkSession. Search summaries are derived; call task_result_read for exact stored output.',
    {
      scope: {
        type: 'string',
        enum: ['previous_task', 'current_conversation', 'task_id'],
      },
      taskId: { type: ['string', 'null'], minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
      query: { type: 'string', maxLength: MAX_QUERY_CHARACTERS },
      toolName: {
        type: ['string', 'null'],
        minLength: 1,
        maxLength: MAX_TOOL_NAME_CHARACTERS,
        pattern: validToolNamePattern,
      },
      limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS },
    },
  ),
  strictFunctionTool(
    'task_result_read',
    'Read one bounded character range from exact persisted historical tool output. Continue at the returned offset while hasMore is true. contentState reports whether the original retained evidence was complete, truncated, or metadata-only.',
    {
      evidenceId: { type: 'string', minLength: 1, maxLength: MAX_IDENTIFIER_CHARACTERS },
      offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      limit: { type: 'integer', minimum: 1, maximum: MAX_READ_CHARACTERS },
    },
  ),
];

export function parseTaskResultToolCall(input: ModelToolCallSource): ParsedTaskResultToolCall {
  try {
    const value = parseToolCallArguments(input);
    if (input.name === 'task_result_search') {
      return {
        family: 'task_result',
        operation: 'search',
        replay: 'safe',
        callId: input.callId,
        name: 'task_result_search',
        argumentsJson: input.argumentsJson,
        arguments: taskResultSearchSchema.parse(value),
      };
    }
    if (input.name === 'task_result_read') {
      return {
        family: 'task_result',
        operation: 'read',
        replay: 'safe',
        callId: input.callId,
        name: 'task_result_read',
        argumentsJson: input.argumentsJson,
        arguments: taskResultReadSchema.parse(value),
      };
    }
    throw new Error('Unsupported historical task-result tool.');
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}
