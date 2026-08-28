import { describe, expect, it } from 'vitest';
import {
  HISTORY_TOOL_DEFINITIONS,
  parseHistoryToolCall,
} from '../../../src/agent/tools/history-tool-schema';

describe('history tool contracts', () => {
  it('exposes only offset history reading and exact result reading', () => {
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
  });

  it('parses both bounded operations', () => {
    expect(
      parseHistoryToolCall({
        callId: 'call_history',
        name: 'history_read',
        argumentsJson: '{"offset":1,"cursor":"","limit":50}',
      }),
    ).toMatchObject({ family: 'history', operation: 'history', name: 'history_read' });
    expect(
      parseHistoryToolCall({
        callId: 'call_result',
        name: 'result_read',
        argumentsJson: '{"resultId":"result_1","offset":0,"limit":20000}',
      }),
    ).toMatchObject({ family: 'history', operation: 'result', name: 'result_read' });
  });

  it('rejects search fields and invalid bounds', () => {
    expect(() =>
      parseHistoryToolCall({
        callId: 'call_bad',
        name: 'history_read',
        argumentsJson: '{"offset":0,"cursor":"","limit":101}',
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
