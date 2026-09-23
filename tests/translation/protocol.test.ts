import { expect, it } from 'vitest';
import { parseExtensionMessage, parsePageCommand } from '../../src/shared/protocol/parse-message';

it('rejects the removed image translation resource endpoint', () => {
  const message = {
    version: 1,
    requestId: 'i',
    type: 'translation.image',
    payload: { sessionId: 's', url: 'https://cdn.test/image.png' },
  };
  expect(() => parseExtensionMessage(message)).toThrow();
});

it('rejects the obsolete DOM background resource endpoint', () => {
  const message = {
    version: 1,
    requestId: 'background',
    type: 'translation.background',
    payload: { sessionId: 's', url: 'https://cdn.test/photo.png' },
  };
  expect(() => parseExtensionMessage(message)).toThrow();
  for (const url of ['file:///private/test', 'javascript:alert(1)', 'data:image/png;base64,YQ=='])
    expect(() =>
      parseExtensionMessage({
        ...message,
        payload: { ...message.payload, url },
      }),
    ).toThrow();
  expect(() =>
    parseExtensionMessage({
      ...message,
      payload: { ...message.payload, tabId: 7 },
    }),
  ).toThrow();
});

it('accepts bounded source text but never text payloads for pixel inspection', () => {
  const message = {
    version: 1,
    requestId: 't',
    type: 'translation.read',
    payload: {
      sessionId: 's',
      texts: [{ id: 'p', text: 'A complete paragraph.' }],
    },
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

it('rejects image payloads at the text translation boundary', () => {
  const message = {
    version: 1,
    requestId: 'r',
    type: 'translation.read',
    payload: {
      sessionId: 's',
      devicePixelRatio: 1,
      imageUrl: 'data:image/png;base64,cG5n',
      viewportWidth: 800,
      viewportHeight: 600,
      rect: { x: 100, y: 100, width: 400, height: 200 },
    },
  };
  expect(() => parseExtensionMessage(message)).toThrow();
  expect(() =>
    parseExtensionMessage({
      ...message,
      payload: { ...message.payload, tabId: 9 },
    }),
  ).toThrow();
});

it.each([
  { lengths: [8000, 8000], valid: true },
  { lengths: [8001], valid: false },
  { lengths: [8000, 8000, 1], valid: false },
  { lengths: Array<number>(32).fill(1), valid: true },
  { lengths: Array<number>(33).fill(1), valid: false },
])('enforces source and batch limits for $lengths', ({ lengths, valid }) => {
  const message = {
    version: 1,
    requestId: 'limits',
    type: 'translation.read',
    payload: {
      sessionId: 's',
      texts: lengths.map((length, i) => ({ id: `p${i}`, text: 'x'.repeat(length) })),
    },
  };
  if (valid) expect(parseExtensionMessage(message)).toEqual(message);
  else expect(() => parseExtensionMessage(message)).toThrow();
});

it('cancels the text-only session without obsolete image cleanup flags', () => {
  const message = {
    version: 1,
    requestId: 'cancel',
    type: 'translation.cancel',
    payload: { sessionId: 's' },
  };
  expect(parseExtensionMessage(message)).toEqual(message);
  for (const obsolete of [{ close: true }, { kind: 'pixels' }])
    expect(() =>
      parseExtensionMessage({
        ...message,
        payload: { ...message.payload, ...obsolete },
      }),
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
      payload: {
        sessionId: 's',
        loadingText: '翻译中…',
        errorText: '翻译失败',
        unsupportedText: 'Share this tab',
        retryText: 'Retry',
      },
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
    parsePageCommand({
      version: 1,
      requestId: 's',
      type: 'page.translation.getState',
      payload: {},
    }).type,
  ).toBe('page.translation.getState');
});
