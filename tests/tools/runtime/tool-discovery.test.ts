import { describe, expect, it } from 'vitest';
import { discoverTools } from '../../../src/tools/discover';
import { bindToolRuntime } from '../../../src/tools/registry';
import { ToolServiceResolver } from '../../../src/tools/service-resolver';
import type { ToolRuntimeContext } from '../../../src/tools/types';
import type { MaterializedToolResult } from '../../../src/tasks/tool-result-types';

const runtime = () =>
  bindToolRuntime(
    discoverTools().filter(({ declaration }) => declaration.name === 'load_tools'),
    new ToolServiceResolver(),
  );
const search = { type: 'hosted_tool' as const, name: 'web_search' };
const fileSearch = { type: 'hosted_tool' as const, name: 'file_search' };
function receipt(output: string, taskId = 'current'): MaterializedToolResult {
  return {
    id: 'receipt',
    callId: 'call',
    taskId,
    runId: 'run',
    toolName: 'load_tools',
    argumentsJson: '{"names":["web_search"]}',
    output,
    attachmentIds: [],
    createdAt: 1,
  };
}

describe('optional tool discovery', () => {
  it('does not advertise a loader when the backend offers no optional tools', async () => {
    const contract = await runtime().contract({});
    expect(contract.definitions).toEqual([]);
    expect(contract.additionalTools).toEqual([]);
  });

  it('enables only requested supported tools from successful receipts in the current task', async () => {
    const task = {
      id: 'current',
      conversationId: 'conversation',
      ordinal: 1,
      tabId: 7,
      goal: 'Research',
      status: 'planning' as const,
      latestRunId: 'run',
      lastEventSequence: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const context: ToolRuntimeContext = {
      task,
      optionalTools: [search, fileSearch],
      toolResults: [
        receipt('{"ok":true,"requested":["web_search","unknown_tool"]}'),
        receipt('{"ok":false,"requested":["file_search"]}'),
        receipt('{"ok":true,"requested":["file_search"]}', 'other_task'),
        receipt('invalid output'),
      ],
    };
    const contract = await runtime().contract(context);
    expect(contract.additionalTools).toEqual([search]);
    expect(contract.definitions[0]?.parameters).toMatchObject({
      properties: { names: { items: { enum: ['web_search', 'file_search'] } } },
    });
    expect(
      (await runtime().contract({ ...context, optionalTools: [fileSearch] })).additionalTools,
    ).toEqual([]);
  });
});
