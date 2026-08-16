import { describe, expect, it } from 'vitest';
import {
  parseExtensionMessage,
  parsePageCommand,
} from '../../../src/shared/protocol/parse-message';

describe('parseExtensionMessage', () => {
  it('accepts a versioned task snapshot request', () => {
    expect(
      parseExtensionMessage({
        version: 1,
        requestId: 'req_1',
        type: 'task.getSnapshot',
        payload: { taskId: 'task_1' },
      }),
    ).toEqual({
      version: 1,
      requestId: 'req_1',
      type: 'task.getSnapshot',
      payload: { taskId: 'task_1' },
    });
  });

  it.each([
    ['system.ping', {}],
    ['task.create', { tabId: 7, conversationId: 'conv_1', goal: 'Fill the form' }],
    ['task.pause', { taskId: 'task_1' }],
    ['task.resume', { taskId: 'task_1' }],
    ['task.cancel', { taskId: 'task_1' }],
  ])('accepts the supported %s command', (type, payload) => {
    expect(
      parseExtensionMessage({ version: 1, requestId: 'req_supported', type, payload }),
    ).toMatchObject({ type, payload });
  });

  it('rejects unknown versions and extra credential fields without leaking their values', () => {
    const secret = 'secret-token-value';

    expect(() =>
      parseExtensionMessage({
        version: 2,
        requestId: 'req_1',
        type: 'task.getSnapshot',
        payload: { taskId: 'task_1', accessToken: secret },
      }),
    ).toThrow(/invalid extension message/i);

    try {
      parseExtensionMessage({
        version: 2,
        requestId: 'req_1',
        type: 'task.getSnapshot',
        payload: { taskId: 'task_1', accessToken: secret },
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it.each([
    { version: 1, requestId: '', type: 'system.ping', payload: {} },
    { version: 1, requestId: 'req_1', type: 'task.unknown', payload: {} },
    {
      version: 1,
      requestId: 'req_1',
      type: 'task.create',
      payload: { tabId: -1, conversationId: 'conv_1', goal: 'x' },
    },
    {
      version: 1,
      requestId: 'req_1',
      type: 'task.create',
      payload: { tabId: 1, conversationId: '', goal: 'x' },
    },
    {
      version: 1,
      requestId: 'req_1',
      type: 'task.create',
      payload: { tabId: 1, conversationId: 'conv_1', goal: '   ' },
    },
  ])('rejects malformed command %#', (value) => {
    expect(() => parseExtensionMessage(value)).toThrow(/invalid extension message/i);
  });
});

describe('parsePageCommand', () => {
  it('accepts only the remaining page feature commands', () => {
    expect(
      parsePageCommand({ version: 1, requestId: 'req_ping', type: 'page.ping', payload: {} }),
    ).toMatchObject({ type: 'page.ping' });
    expect(
      parsePageCommand({
        version: 1,
        requestId: 'req_hidden',
        type: 'page.overlays.setHidden',
        payload: { hidden: true },
      }),
    ).toMatchObject({ type: 'page.overlays.setHidden' });
  });

  it('rejects task commands and extra page payload fields', () => {
    expect(() =>
      parsePageCommand({
        version: 1,
        requestId: 'req_task',
        type: 'task.pause',
        payload: { taskId: 'task_1' },
      }),
    ).toThrow(/invalid page command/i);
    expect(() =>
      parsePageCommand({
        version: 1,
        requestId: 'req_page',
        type: 'page.ping',
        payload: { accessToken: 'must-not-be-accepted' },
      }),
    ).toThrow(/invalid page command/i);
  });
});
