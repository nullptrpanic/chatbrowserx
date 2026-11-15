import { describe, expect, it } from 'vitest';
import { discoverTools } from '../../../src/tools/discover';
import { bindToolRuntime } from '../../../src/tools/registry';
import { ToolServiceResolver } from '../../../src/tools/service-resolver';

const runtime = bindToolRuntime(discoverTools(), new ToolServiceResolver());

describe('history tool contracts', () => {
  it('exposes one strict read tool alongside search and attachments', async () => {
    const contract = await runtime.contract({ historyAvailable: true });
    expect(
      contract.definitions
        .filter(({ name }) => /^(history|attachment)\./.test(name))
        .map(({ name }) => name),
    ).toEqual(['history.search', 'history.read', 'attachment.read']);
    expect(contract.definitions.find(({ name }) => name === 'history.read')).toMatchObject({
      strict: true,
      parameters: {
        required: ['target'],
        properties: {
          target: {
            anyOf: expect.arrayContaining([
              expect.objectContaining({ additionalProperties: false }),
            ]),
          },
        },
      },
    });
  });

  it('validates search bounds without exposing conversation scope', async () => {
    const contract = await runtime.contract({ historyAvailable: true });
    for (const query of ['', '截图 TOKEN']) {
      const args = { query, cursor: '', limit: 5 };
      expect(
        contract.parse({
          name: 'history.search',
          callId: 'search',
          argumentsJson: JSON.stringify(args),
        }).arguments,
      ).toEqual(args);
    }
    for (const args of [
      { query: '', cursor: '', limit: 11 },
      { query: 'x'.repeat(513), cursor: '', limit: 5 },
      { query: '', cursor: '', limit: 5, conversationId: 'foreign' },
    ])
      expect(() =>
        contract.parse({
          name: 'history.search',
          callId: 'bad',
          argumentsJson: JSON.stringify(args),
        }),
      ).toThrow();
  });

  it.each([
    [
      { taskId: 'task_1', cursor: '', limit: 20 },
      { kind: 'timeline', input: { taskId: 'task_1', offset: null, cursor: '', limit: 20 } },
    ],
    [
      { taskOffset: 1, cursor: '', limit: 20 },
      { kind: 'timeline', input: { taskId: null, offset: 1, cursor: '', limit: 20 } },
    ],
    [
      { taskId: 'task_1', messageId: 'msg_1', offset: 0, limit: 20_000 },
      { kind: 'message', input: { messageId: 'msg_1' } },
    ],
    [
      { taskId: 'task_1', callId: 'call_1', offset: 4, limit: 100 },
      { kind: 'result', input: { callId: 'call_1' } },
    ],
  ])('routes an unambiguous read from %j', async (target, args) => {
    const contract = await runtime.contract({ historyAvailable: true });
    expect(
      contract.parse({
        name: 'history.read',
        callId: 'read',
        argumentsJson: JSON.stringify({ target }),
      }).arguments,
    ).toMatchObject(args);
  });

  it.each([
    { taskId: 'task_1', taskOffset: 1, cursor: '', limit: 50 },
    { taskId: 'task_1', messageId: 'msg_1', callId: 'call_1', offset: 0, limit: 50 },
    { taskId: 'task_1', callId: 'call_1', offset: -1, limit: 50 },
    { taskId: 'task_1', resultId: 'result_1', offset: 0, limit: 50 },
  ])('rejects ambiguous or invalid targets from %j', async (target) => {
    const contract = await runtime.contract({ historyAvailable: true });
    expect(() =>
      contract.parse({
        name: 'history.read',
        callId: 'bad',
        argumentsJson: JSON.stringify({ target }),
      }),
    ).toThrow();
  });

  it('reads recorded result_read arguments through the merged declaration', () => {
    const source = {
      name: 'result_read',
      callId: 'older',
      argumentsJson: '{"taskId":"task_1","callId":"call_1","offset":3,"limit":20}',
    };
    expect(runtime.parseRecorded(source)).toEqual({
      ...source,
      arguments: {
        kind: 'result',
        input: { taskId: 'task_1', callId: 'call_1', offset: 3, limit: 20 },
      },
    });
  });
});
