import { describe, expect, it } from 'vitest';
import {
  parseTaskResultToolCall,
  TASK_RESULT_TOOL_DEFINITIONS,
} from '../../../src/agent/tools/task-result-tool-schema';

describe('TASK_RESULT_TOOL_DEFINITIONS', () => {
  it('exposes two strict Responses API-compatible contracts', () => {
    expect(TASK_RESULT_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'task_result_search',
      'task_result_read',
    ]);
    for (const definition of TASK_RESULT_TOOL_DEFINITIONS) {
      const parameters = definition.parameters as {
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required: readonly string[];
      };
      expect(definition.strict).toBe(true);
      expect(definition.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(parameters.required).toEqual(Object.keys(parameters.properties));
    }
    expect(JSON.stringify(TASK_RESULT_TOOL_DEFINITIONS)).not.toContain('uniqueItems');
  });
});

describe('parseTaskResultToolCall', () => {
  it('parses bounded search and read calls as replay-safe local operations', () => {
    const searchArguments = {
      scope: 'previous_task',
      taskId: null,
      query: 'orders status',
      toolName: 'browser_network_get',
      limit: 10,
    } as const;
    const readArguments = { evidenceId: 'toolResult_1', offset: 0, limit: 20_000 } as const;

    expect(
      parseTaskResultToolCall({
        callId: 'call_search',
        name: 'task_result_search',
        argumentsJson: JSON.stringify(searchArguments),
      }),
    ).toEqual({
      family: 'task_result',
      operation: 'search',
      replay: 'safe',
      callId: 'call_search',
      name: 'task_result_search',
      argumentsJson: JSON.stringify(searchArguments),
      arguments: searchArguments,
    });
    expect(
      parseTaskResultToolCall({
        callId: 'call_read',
        name: 'task_result_read',
        argumentsJson: JSON.stringify(readArguments),
      }),
    ).toEqual({
      family: 'task_result',
      operation: 'read',
      replay: 'safe',
      callId: 'call_read',
      name: 'task_result_read',
      argumentsJson: JSON.stringify(readArguments),
      arguments: readArguments,
    });
  });

  it.each([
    {
      callId: 'call_1',
      name: 'task_result_search',
      argumentsJson: JSON.stringify({
        scope: 'task_id',
        taskId: null,
        query: '',
        toolName: null,
        limit: 10,
      }),
    },
    {
      callId: 'call_1',
      name: 'task_result_search',
      argumentsJson: JSON.stringify({
        scope: 'previous_task',
        taskId: 'task_1',
        query: '',
        toolName: null,
        limit: 10,
      }),
    },
    {
      callId: 'call_1',
      name: 'task_result_search',
      argumentsJson: JSON.stringify({
        scope: 'current_conversation',
        taskId: null,
        query: 'q'.repeat(1_025),
        toolName: null,
        limit: 10,
      }),
    },
    {
      callId: 'call_1',
      name: 'task_result_search',
      argumentsJson: JSON.stringify({
        scope: 'current_conversation',
        taskId: null,
        query: '',
        toolName: 'invalid tool name',
        limit: 10,
      }),
    },
    {
      callId: 'call_1',
      name: 'task_result_search',
      argumentsJson: JSON.stringify({
        scope: 'current_conversation',
        taskId: null,
        query: '',
        toolName: null,
        limit: 21,
      }),
    },
    {
      callId: 'call_1',
      name: 'task_result_read',
      argumentsJson: JSON.stringify({ evidenceId: '', offset: 0, limit: 100 }),
    },
    {
      callId: 'call_1',
      name: 'task_result_read',
      argumentsJson: JSON.stringify({ evidenceId: 'result_1', offset: -1, limit: 100 }),
    },
    {
      callId: 'call_1',
      name: 'task_result_read',
      argumentsJson: JSON.stringify({ evidenceId: 'result_1', offset: 0, limit: 20_001 }),
    },
    {
      callId: 'call_1',
      name: 'task_result_read',
      argumentsJson: JSON.stringify({
        evidenceId: 'result_1',
        offset: 0,
        limit: 100,
        extra: true,
      }),
    },
  ])('rejects malformed, unbounded, or inconsistent calls %#', (input) => {
    expect(() => parseTaskResultToolCall(input)).toThrow();
    try {
      parseTaskResultToolCall(input);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });
});
