import { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import type {
  HistoryReadInput,
  ResultReadInput,
  TaskHistoryReadInput,
} from '../../tasks/task-history-reader';
import { strictFunctionTool } from '../../tools/contracts/model-tool';
import {
  parseToolCallArguments,
  type ModelToolCallSource,
} from '../../tools/contracts/tool-call-envelope';

const MAX_CURSOR_CHARACTERS = 1_024;
const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_HISTORY_ITEMS = 100;
const MAX_RESULT_CHARACTERS = 20_000;

export const historyReadSchema = z
  .object({
    offset: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    cursor: z.string().max(MAX_CURSOR_CHARACTERS),
    limit: z.number().int().min(1).max(MAX_HISTORY_ITEMS),
  })
  .strict();

export const taskHistoryReadSchema = z
  .object({
    taskId: z.string().min(1).max(MAX_IDENTIFIER_CHARACTERS),
    cursor: z.string().max(MAX_CURSOR_CHARACTERS),
    limit: z.number().int().min(1).max(MAX_HISTORY_ITEMS),
  })
  .strict();

export const resultReadSchema = z
  .object({
    resultId: z.string().min(1).max(MAX_IDENTIFIER_CHARACTERS),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(MAX_RESULT_CHARACTERS),
  })
  .strict();

export type ParsedHistoryToolCall =
  | {
      readonly family: 'history';
      readonly operation: 'history';
      readonly replay: 'safe';
      readonly callId: string;
      readonly name: 'history_read';
      readonly argumentsJson: string;
      readonly arguments: HistoryReadInput;
    }
  | {
      readonly family: 'history';
      readonly operation: 'history_task';
      readonly replay: 'safe';
      readonly callId: string;
      readonly name: 'history_read_task';
      readonly argumentsJson: string;
      readonly arguments: TaskHistoryReadInput;
    }
  | {
      readonly family: 'history';
      readonly operation: 'result';
      readonly replay: 'safe';
      readonly callId: string;
      readonly name: 'result_read';
      readonly argumentsJson: string;
      readonly arguments: ResultReadInput;
    };

export const HISTORY_TOOL_DEFINITIONS = [
  strictFunctionTool(
    'history_read',
    'Discover and read one bounded page from a previous logical task by relative position. offset 1 is the immediately previous task. Use this only when no stable taskId is already available. The response supplies task.id for exact later reads. Start with an empty cursor.',
    {
      offset: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      cursor: { type: 'string', maxLength: MAX_CURSOR_CHARACTERS },
      limit: { type: 'integer', minimum: 1, maximum: MAX_HISTORY_ITEMS },
    },
  ),
  strictFunctionTool(
    'history_read_task',
    'Read one bounded page from an exact previous logical task using its stable taskId. Use this whenever reply context supplies targetTaskId, when a history response supplies task.id, or when traversing replyTo.taskId and replyTo.messageId. Start with an empty cursor and continue with nextCursor while hasMore is true.',
    {
      taskId: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_IDENTIFIER_CHARACTERS,
      },
      cursor: { type: 'string', maxLength: MAX_CURSOR_CHARACTERS },
      limit: { type: 'integer', minimum: 1, maximum: MAX_HISTORY_ITEMS },
    },
  ),
  strictFunctionTool(
    'result_read',
    'Read an exact bounded character range from a tool result referenced by history_read or history_read_task. Continue from nextOffset while hasMore is true.',
    {
      resultId: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_IDENTIFIER_CHARACTERS,
      },
      offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_CHARACTERS },
    },
  ),
];

export function parseHistoryToolCall(input: ModelToolCallSource): ParsedHistoryToolCall {
  try {
    const value = parseToolCallArguments(input);
    if (input.name === 'history_read') {
      return {
        family: 'history',
        operation: 'history',
        replay: 'safe',
        callId: input.callId,
        name: 'history_read',
        argumentsJson: input.argumentsJson,
        arguments: historyReadSchema.parse(value),
      };
    }
    if (input.name === 'history_read_task') {
      return {
        family: 'history',
        operation: 'history_task',
        replay: 'safe',
        callId: input.callId,
        name: 'history_read_task',
        argumentsJson: input.argumentsJson,
        arguments: taskHistoryReadSchema.parse(value),
      };
    }
    if (input.name === 'result_read') {
      return {
        family: 'history',
        operation: 'result',
        replay: 'safe',
        callId: input.callId,
        name: 'result_read',
        argumentsJson: input.argumentsJson,
        arguments: resultReadSchema.parse(value),
      };
    }
    throw new Error('Unsupported history tool.');
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}
