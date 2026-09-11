import { expect, it } from 'vitest';
import { parseExtensionMessage, parsePageCommand } from '../../src/shared/protocol/parse-message';

it('accepts bounded source text but never text payloads for pixel inspection', () => {
  const message = {
    version: 1,
    requestId: 't',
    type: 'translation.read',
    payload: { sessionId: 's', texts: [{ id: 'p', text: 'A complete paragraph.' }] },
  };
  expect(parseExtensionMessage(message)).toEqual(message);
  expect(() => parseExtensionMessage({ ...message, type: 'translation.inspect' })).toThrow();
  for (const texts of [
    [],
    [
      { id: 'p', text: 'a' },
      { id: 'p', text: 'b' },
    ],
    [{ id: 'p', text: 'x'.repeat(8001) }],
  ])
    expect(() =>
      parseExtensionMessage({ ...message, payload: { sessionId: 's', texts } }),
    ).toThrow();
});

it('accepts a bounded region from an enabled page without a caller-supplied tab ID', () => {
  const message = {
    version: 1,
    requestId: 'r',
    type: 'translation.read',
    payload: {
      sessionId: 's',
      devicePixelRatio: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      rect: { x: 100, y: 100, width: 400, height: 200 },
    },
  };
  expect(parseExtensionMessage(message)).toEqual(message);
  expect(() =>
    parseExtensionMessage({ ...message, payload: { ...message.payload, tabId: 9 } }),
  ).toThrow();
});

it('accepts the UI toggle and credential-free page toggle', () => {
  expect(
    parseExtensionMessage({
      version: 1,
      requestId: 'r',
      type: 'translation.toggle',
      payload: { tabId: 7 },
    }).type,
  ).toBe('translation.toggle');
  expect(
    parsePageCommand({
      version: 1,
      requestId: 'r',
      type: 'page.translation.toggle',
      payload: { sessionId: 's', loadingText: '翻译中…', errorText: '翻译失败' },
    }).type,
  ).toBe('page.translation.toggle');
});

it('accepts read-only state queries on their respective UI and page boundaries', () => {
  expect(
    parseExtensionMessage({
      version: 1,
      requestId: 's',
      type: 'translation.getState',
      payload: { sessionId: 'enabled' },
    }).payload,
  ).toEqual({ sessionId: 'enabled' });
  expect(
    parseExtensionMessage({
      version: 1,
      requestId: 's',
      type: 'translation.getState',
      payload: { tabId: 7 },
    }).type,
  ).toBe('translation.getState');
  expect(
    parsePageCommand({ version: 1, requestId: 's', type: 'page.translation.getState', payload: {} })
      .type,
  ).toBe('page.translation.getState');
});
