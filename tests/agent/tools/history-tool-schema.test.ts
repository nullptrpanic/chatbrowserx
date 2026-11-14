import { describe, expect, it } from 'vitest';
import {
  historyDetailReadDefinition,
  historyReadDefinition,
  historySearchDefinition,
  resultReadDefinition,
} from '../../../src/tools/history/contract';
import {
  historyDetailReadTool,
  historyReadTool,
  historySearchTool,
  historyRuntime,
  resultReadTool,
} from '../../../src/tools/history/tool';
import { ToolDeclarationCatalog } from '../../../src/tools/register';
import { bindToolRuntime } from '../../../src/tools/registry';
import { ToolServiceResolver } from '../../../src/tools/service-resolver';

const HISTORY_TOOL_DEFINITIONS = [
  historyReadDefinition,
  historyDetailReadDefinition,
  resultReadDefinition,
  historySearchDefinition,
];
const catalog = new ToolDeclarationCatalog();
catalog.register(historyReadTool, historyRuntime);
catalog.register(historyDetailReadTool, historyRuntime);
catalog.register(resultReadTool, historyRuntime);
catalog.register(historySearchTool, historyRuntime);
const runtime = bindToolRuntime(catalog.seal(), new ToolServiceResolver());

describe('history tool contracts', () => {
  it('uses one strict history tool for relative and stable task reads', () => {
    expect(HISTORY_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'history_read',
      'history_detail_read',
      'result_read',
      'history_search',
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
    expect(HISTORY_TOOL_DEFINITIONS[1]?.description).toContain('detailId');
    expect(HISTORY_TOOL_DEFINITIONS[2]?.description).toContain('history_read');
  });

  it('accepts bounded search, browsing and message anchors without a model-controlled conversation scope', async () => {
    const contract = await runtime.contract({ historyAvailable: true });
    for (const query of ['', '截图 TOKEN']) {
      expect(
        contract.parse({
          name: 'history_search',
          callId: 'search',
          argumentsJson: JSON.stringify({ query, cursor: '', limit: 5 }),
        }),
      ).toMatchObject({ arguments: { query, cursor: '', limit: 5 } });
    }
    expect(
      contract.parse({
        name: 'history_read',
        callId: 'read',
        argumentsJson: JSON.stringify({
          taskId: 'task_1',
          offset: null,
          messageId: 'answer_1',
          cursor: '',
          limit: 5,
        }),
      }),
    ).toMatchObject({ arguments: { messageId: 'answer_1' } });
    for (const input of [
      { query: '', cursor: '', limit: 11 },
      { query: '', cursor: '', limit: 0 },
      { query: 'x'.repeat(513), cursor: '', limit: 5 },
      { query: '', cursor: '', limit: 5, conversationId: 'foreign' },
    ])
      expect(() =>
        contract.parse({
          name: 'history_search',
          callId: 'bad',
          argumentsJson: JSON.stringify(input),
        }),
      ).toThrow();
  });

  it('parses relative and exact task selectors through history_read', async () => {
    const contract = await runtime.contract({ historyAvailable: true });
    expect(
      contract.parse({
        callId: 'call_history',
        name: 'history_read',
        argumentsJson: '{"taskId":null,"offset":1,"cursor":"","limit":50}',
      }),
    ).toMatchObject({
      name: 'history_read',
      arguments: { taskId: null, offset: 1, cursor: '', limit: 50 },
    });
    expect(
      contract.parse({
        callId: 'call_task_history',
        name: 'history_read',
        argumentsJson: '{"taskId":"task_1","offset":null,"cursor":"","limit":50}',
      }),
    ).toMatchObject({
      name: 'history_read',
      arguments: { taskId: 'task_1', offset: null, cursor: '', limit: 50 },
    });
    expect(
      contract.parse({
        callId: 'call_detail',
        name: 'history_detail_read',
        argumentsJson: '{"detailId":"detail_1","offset":0,"limit":20000}',
      }),
    ).toMatchObject({
      name: 'history_detail_read',
    });
    expect(
      contract.parse({
        callId: 'call_result',
        name: 'result_read',
        argumentsJson: '{"resultId":"result_1","offset":0,"limit":20000}',
      }),
    ).toMatchObject({
      name: 'result_read',
    });
  });

  it('rejects ambiguous selectors, search fields, and invalid bounds', async () => {
    const contract = await runtime.contract({ historyAvailable: true });
    expect(() =>
      contract.parse({
        callId: 'call_bad',
        name: 'history_read',
        argumentsJson: '{"taskId":null,"offset":0,"cursor":"","limit":101}',
      }),
    ).toThrow();
    expect(() =>
      contract.parse({
        callId: 'call_bad',
        name: 'history_read',
        argumentsJson: '{"taskId":"task_1","offset":1,"cursor":"","limit":50}',
      }),
    ).toThrow();
    expect(() =>
      contract.parse({
        callId: 'call_bad',
        name: 'history_read',
        argumentsJson: '{"taskId":null,"offset":null,"cursor":"","limit":50}',
      }),
    ).toThrow();
    expect(() =>
      contract.parse({
        callId: 'call_bad',
        name: 'result_read',
        argumentsJson: '{"resultId":"result_1","offset":0,"limit":1,"query":"x"}',
      }),
    ).toThrow();
  });
});
