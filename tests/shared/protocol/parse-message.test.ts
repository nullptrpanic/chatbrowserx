import { describe, expect, it } from 'vitest';
import {
  parseExtensionMessage,
  parsePageCommand,
} from '../../../src/shared/protocol/parse-message';

describe('parseExtensionMessage', () => {
  it('defaults an older settings save payload to 50 history messages', () => {
    expect(
      parseExtensionMessage({
        version: 1,
        requestId: 'req_settings',
        type: 'settings.save',
        payload: {
          reasoningEffort: 'medium',
          systemPrompt: '',
          language: 'zh-CN',
        },
      }),
    ).toMatchObject({
      type: 'settings.save',
      payload: { historyMessageLimit: 50 },
    });
  });

  it('accepts and trims an explicitly supplied Tavily key', () => {
    expect(
      parseExtensionMessage({
        version: 1,
        requestId: 'req_tavily_settings',
        type: 'settings.save',
        payload: {
          reasoningEffort: 'medium',
          systemPrompt: '',
          language: 'zh-CN',
          historyMessageLimit: 50,
          tavilyKey: '  tvly-key  ',
        },
      }),
    ).toMatchObject({
      type: 'settings.save',
      payload: { tavilyKey: 'tvly-key' },
    });
  });

  it('rejects history limits above the completed-message cap', () => {
    expect(() =>
      parseExtensionMessage({
        version: 1,
        requestId: 'req_history_limit',
        type: 'settings.save',
        payload: {
          reasoningEffort: 'medium',
          systemPrompt: '',
          language: 'zh-CN',
          historyMessageLimit: 51,
        },
      }),
    ).toThrow(/invalid extension message/i);
  });

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

  it('accepts text or image-only runtime supplements and rejects empty ones', () => {
    expect(
      parseExtensionMessage({
        version: 1,
        requestId: 'req_supplement',
        type: 'chat.supplement',
        payload: { taskId: 'task_1', text: '', attachmentIds: ['attachment_1'] },
      }),
    ).toMatchObject({
      type: 'chat.supplement',
      payload: { taskId: 'task_1', text: '', attachmentIds: ['attachment_1'] },
    });
    expect(() =>
      parseExtensionMessage({
        version: 1,
        requestId: 'req_empty_supplement',
        type: 'chat.supplement',
        payload: { taskId: 'task_1', text: '   ', attachmentIds: [] },
      }),
    ).toThrow(/invalid extension message/i);
  });

  it.each([
    ['system.ping', {}],
    ['task.create', { tabId: 7, conversationId: 'conv_1', goal: 'Fill the form' }],
    ['task.pause', { taskId: 'task_1' }],
    ['task.resume', { taskId: 'task_1' }],
    ['task.cancel', { taskId: 'task_1' }],
    ['image.preview.open', { tabId: 7, attachmentId: 'attachment_1' }],
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
        requestId: 'req_pointer',
        type: 'page.pointer.show',
        payload: { x: 100, y: 80, fromX: 10, fromY: 20, effect: 'click' },
      }),
    ).toMatchObject({ type: 'page.pointer.show' });
    expect(
      parsePageCommand({
        version: 1,
        requestId: 'req_content',
        type: 'page.content.read',
        payload: {},
      }),
    ).toMatchObject({ type: 'page.content.read' });
    expect(
      parsePageCommand({
        version: 1,
        requestId: 'req_elements',
        type: 'page.elements.observe',
        payload: {},
      }),
    ).toMatchObject({ type: 'page.elements.observe' });
    expect(
      parsePageCommand({
        version: 1,
        requestId: 'req_hidden',
        type: 'page.overlays.setHidden',
        payload: { hidden: true },
      }),
    ).toMatchObject({ type: 'page.overlays.setHidden' });
    expect(
      parsePageCommand({
        version: 1,
        requestId: 'req_preview',
        type: 'page.imagePreview.open',
        payload: {
          src: 'data:image/png;base64,cG5n',
          alt: 'photo.png',
        },
      }),
    ).toMatchObject({ type: 'page.imagePreview.open' });
  });

  it('rejects task commands and extra page payload fields', () => {
    expect(() =>
      parsePageCommand({
        version: 1,
        requestId: 'req_pointer_invalid',
        type: 'page.pointer.show',
        payload: { x: -1, y: 80, fromX: 10, fromY: 20, effect: 'click', javascript: 'x' },
      }),
    ).toThrow(/invalid page command/i);
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
