import { describe, expect, it, vi } from 'vitest';
import { ChromeTranslationPagePort } from '../../../src/platform/chrome/translation-page-port';
import type { PageCommand } from '../../../src/shared/protocol/message-types';

const options = { sessionId: 'enabled', loadingText: '翻译中…', errorText: '翻译失败' };
const reply = (m: PageCommand, data: unknown) => ({
  version: 1,
  requestId: m.requestId,
  ok: true,
  data,
});

function fixture(
  sendMessage: (tabId: number, message: PageCommand) => Promise<unknown>,
  active = true,
) {
  const ensureInstalled = vi.fn(async () => ({
    status: 'installed' as const,
    originPattern: 'https://example.test/*',
  }));
  const port = new ChromeTranslationPagePort({
    installer: { ensureInstalled },
    ids: { create: () => 'request' },
    tabs: { get: async () => ({ url: 'https://example.test/', active }), sendMessage },
  });
  return { port, ensureInstalled };
}

describe('ChromeTranslationPagePort', () => {
  it('does not accept an unrelated old session as proof of a failed toggle', async () => {
    let toggles = 0;
    const { port } = fixture(async (_tab, m) => {
      if (m.type === 'page.translation.toggle') {
        toggles++;
        throw new Error('Port closed');
      }
      return reply(m, { sessionId: 'unrelated' });
    });
    await expect(port.toggle(7, options)).rejects.toThrow('Port closed');
    expect(toggles).toBe(1);
  });
  it('recognizes an already opened session after its toggle acknowledgement is lost, without toggling twice', async () => {
    let toggles = 0;
    const { port } = fixture(async (_tab, m) => {
      if (m.type === 'page.translation.toggle') {
        toggles++;
        throw new Error('Message port closed');
      }
      return reply(m, { sessionId: options.sessionId });
    });
    await expect(port.toggle(7, options)).resolves.toBe(true);
    expect(toggles).toBe(1);
  });
  it('rejects a background tab even when a debugger keeps its document apparently visible', async () => {
    const { port } = fixture(async (_tab, m) => reply(m, { sessionId: 'still-visible' }), false);
    expect(await port.getSession(7)).toBeNull();
  });
  it('reads page-owned state without injecting code or toggling the lens', async () => {
    const calls: PageCommand[] = [];
    const { port, ensureInstalled } = fixture(async (_tab, m) => {
      calls.push(m);
      return reply(m, { sessionId: 'enabled' });
    });
    expect(await port.getSession(7)).toBe('enabled');
    expect(calls.map((m) => m.type)).toEqual(['page.translation.getState']);
    expect(ensureInstalled).not.toHaveBeenCalled();
  });

  it('reinstalls only after an explicitly unsupported command, without losing labels', async () => {
    const calls: PageCommand[] = [];
    const { port, ensureInstalled } = fixture(async (_tab, m) => {
      calls.push(m);
      return calls.length === 1
        ? { version: 1, requestId: 'invalid', ok: false, error: { code: 'INVALID_PAGE_COMMAND' } }
        : reply(m, { active: true });
    });
    expect(await port.toggle(7, options)).toBe(true);
    expect(calls.map((m) => m.payload)).toEqual([options, options]);
    expect(ensureInstalled).toHaveBeenLastCalledWith(7, 'https://example.test/', true);
  });

  it('never retries an ambiguous toggle, and rejects uncorrelated success responses', async () => {
    let calls = 0;
    const { port } = fixture(async (_tab, m) => {
      if (m.type === 'page.translation.toggle') calls++;
      return { version: 1, requestId: 'wrong', ok: true, data: { active: true } };
    });
    await expect(port.toggle(7, options)).rejects.toThrow();
    expect(calls).toBe(1);
    await expect(port.getSession(7)).rejects.toMatchObject({
      code: 'TRANSLATION_PAGE_UNAVAILABLE',
    });
  });
});

it('retries a transient session query without toggling or reinstalling the page', async () => {
  let calls = 0;
  const { port, ensureInstalled } = fixture(async (_tab, m) => {
    expect(m.type).toBe('page.translation.getState');
    if (++calls === 1) throw new Error('Message port temporarily closed');
    return reply(m, { sessionId: 'enabled' });
  });
  expect(await port.getSession(7)).toBe('enabled');
  expect(calls).toBe(2);
  expect(ensureInstalled).not.toHaveBeenCalled();
});

it('distinguishes a persistent page communication failure from an explicitly closed session', async () => {
  let calls = 0;
  const { port } = fixture(async () => {
    calls++;
    throw new Error('private page details');
  });
  await expect(port.getSession(7)).rejects.toMatchObject({ code: 'TRANSLATION_PAGE_UNAVAILABLE' });
  expect(calls).toBe(2);
  const closed = fixture(async (_tab, m) => reply(m, { sessionId: null }));
  expect(await closed.port.getSession(7)).toBeNull();
});

it('reports a page without a command receiver as inactive after navigation', async () => {
  const sendMessage = vi.fn(async () => {
    throw new Error('Could not establish connection. Receiving end does not exist.');
  });
  const { port, ensureInstalled } = fixture(sendMessage);
  expect(await port.getSession(7)).toBeNull();
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(ensureInstalled).not.toHaveBeenCalled();
});

it('bounds a missing session reply to two timed attempts', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const { port } = fixture(async () => {
    calls++;
    return new Promise(() => undefined);
  });
  try {
    const result = expect(port.getSession(7)).rejects.toMatchObject({
      code: 'TRANSLATION_PAGE_UNAVAILABLE',
    });
    await vi.advanceTimersByTimeAsync(10000);
    await result;
    expect(calls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it('rechecks tab visibility before retrying a page query', async () => {
  let active = true;
  const sendMessage = vi.fn(async () => {
    active = false;
    throw new Error('Port unavailable');
  });
  const port = new ChromeTranslationPagePort({
    ids: { create: () => 'page' },
    installer: { ensureInstalled: vi.fn() },
    tabs: { get: async () => ({ active }), sendMessage },
  });
  expect(await port.getSession(7)).toBeNull();
  expect(sendMessage).toHaveBeenCalledTimes(1);
});
