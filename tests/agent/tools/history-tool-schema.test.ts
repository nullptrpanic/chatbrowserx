import { describe, expect, it } from 'vitest';
import {
  HISTORY_TOOL_DEFINITIONS,
  parseHistoryToolCall,
} from '../../../src/agent/tools/history-tool-schema';

describe('history tool contracts', () => {
  it('uses one strict history tool for relative and stable task reads', () => {
    expect(HISTORY_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'history_read',
      'result_read',
    ]);
    for (const definition of HISTORY_TOOL_DEFINITIONS) {
      const parameters = definition.parameters as {
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required: readonly string[];
      };
      expect(definition.strict).toBe(true);
      expect(parameters.required).toEqual(Object.keys(parameters.properties));
    }
    expect(HISTORY_TOOL_DEFINITIONS[0]?.description).toContain('taskId');
    expect(HISTORY_TOOL_DEFINITIONS[0]?.description).toContain('offset');
    expect(HISTORY_TOOL_DEFINITIONS[1]?.description).toContain('history_read');
  });

  it('parses relative and exact task selectors through history_read', () => {
    expect(
      parseHistoryToolCall({
        callId: 'call_history',
        name: 'history_read',
        argumentsJson: '{"taskId":null,"offset":1,"cursor":"","limit":50}',
      }),
    ).toMatchObject({
      family: 'history',
      operation: 'history',
      name: 'history_read',
      arguments: { taskId: null, offset: 1, cursor: '', limit: 50 },
    });
    expect(
      parseHistoryToolCall({
        callId: 'call_task_history',
        name: 'history_read',
        argumentsJson: '{"taskId":"task_1","offset":null,"cursor":"","limit":50}',
      }),
    ).toMatchObject({
      family: 'history',
      operation: 'history',
      name: 'history_read',
      arguments: { taskId: 'task_1', offset: null, cursor: '', limit: 50 },
    });
    expect(
      parseHistoryToolCall({
        callId: 'call_result',
        name: 'result_read',
        argumentsJson: '{"resultId":"result_1","offset":0,"limit":20000}',
      }),
    ).toMatchObject({
      family: 'history',
      operation: 'result',
      name: 'result_read',
    });
  });

  it('rejects ambiguous selectors, search fields, and invalid bounds', () => {
    expect(() =>
      parseHistoryToolCall({
        callId: 'call_bad',
        name: 'history_read',
        argumentsJson: '{"taskId":null,"offset":0,"cursor":"","limit":101}',
      }),
    ).toThrow();
    expect(() =>
      parseHistoryToolCall({
        callId: 'call_bad',
        name: 'history_read',
        argumentsJson: '{"taskId":"task_1","offset":1,"cursor":"","limit":50}',
      }),
    ).toThrow();
    expect(() =>
      parseHistoryToolCall({
        callId: 'call_bad',
        name: 'history_read',
        argumentsJson: '{"taskId":null,"offset":null,"cursor":"","limit":50}',
      }),
    ).toThrow();
    expect(() =>
      parseHistoryToolCall({
        callId: 'call_bad',
        name: 'result_read',
        argumentsJson: '{"resultId":"result_1","offset":0,"limit":1,"query":"x"}',
      }),
    ).toThrow();
  });
});
