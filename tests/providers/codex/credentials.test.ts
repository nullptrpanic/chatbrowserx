import { describe, expect, it, vi } from 'vitest';
import { CodexCredentials } from '../../../src/providers/codex/credentials';
import { DEFAULT_APP_SETTINGS } from '../../../src/persistence/settings-store';

const token = `${btoa('{}').replace(/=+$/, '')}.${btoa(JSON.stringify({ chatgpt_account_id: 'fixture' })).replace(/=+$/, '')}.`;
const nextToken = `${token}next`;

describe('trusted Codex credentials', () => {
  it('keeps manual mode independent of Sandbox', async () => {
    const sandbox = { configurationKey: vi.fn(), readCredential: vi.fn() };
    const credentials = new CodexCredentials(
      { getAccessToken: async () => token },
      { get: async () => DEFAULT_APP_SETTINGS },
      sandbox,
    );
    expect(await credentials.getAccessToken()).toBe(token);
    expect(sandbox.configurationKey).not.toHaveBeenCalled();
  });

  it('shares concurrent syncs, uses the synced token, and refreshes it on demand', async () => {
    const configuration = {};
    const manual = { getAccessToken: vi.fn(async () => 'manual') };
    const sandbox = {
      configurationKey: async () => configuration,
      readCredential: vi.fn(async () => token),
    };
    const credentials = new CodexCredentials(
      manual,
      {
        get: async () => ({
          ...DEFAULT_APP_SETTINGS,
          credentialSource: 'sandbox',
          authPath: '/private/custom auth.json',
        }),
      },
      sandbox,
    );
    expect(await Promise.all([credentials.getAccessToken(), credentials.getAccessToken()])).toEqual(
      [token, token],
    );
    expect(sandbox.readCredential).toHaveBeenCalledOnce();
    expect(sandbox.readCredential.mock.calls[0]).toEqual([
      '/private/custom auth.json',
      ['tokens', 'access_token'],
      expect.any(AbortSignal),
    ]);
    expect(manual.getAccessToken).not.toHaveBeenCalled();
    expect(await credentials.getAccessToken()).toBe(token);
    expect(sandbox.readCredential).toHaveBeenCalledOnce();
    sandbox.readCredential.mockResolvedValue(nextToken);
    expect(await credentials.credentialSync.refresh()).toBe('synced');
    expect(await credentials.getAccessToken()).toBe(nextToken);
    expect(sandbox.readCredential).toHaveBeenCalledTimes(2);
  });

  it('discards old tokens after a failed refresh or a Sandbox connection change', async () => {
    let configuration = {};
    const readCredential = vi.fn(async () => token);
    const credentials = new CodexCredentials(
      { getAccessToken: async () => 'manual' },
      { get: async () => ({ ...DEFAULT_APP_SETTINGS, credentialSource: 'sandbox' }) },
      { configurationKey: async () => configuration, readCredential },
    );
    expect(await credentials.credentialSync.refresh()).toBe('synced');
    readCredential.mockRejectedValue(new Error('secret upstream response'));
    expect(await credentials.credentialSync.refresh()).toBe('failed');
    expect(await credentials.credentialSync.getStatus()).toBe('failed');
    await expect(credentials.getAccessToken()).rejects.toMatchObject({ code: 'AUTH' });
    configuration = {};
    expect(await credentials.credentialSync.getStatus()).toBe('idle');
    readCredential.mockResolvedValue(nextToken);
    expect(await credentials.getAccessToken()).toBe(nextToken);
  });

  it('keeps a token for five minutes and refreshes only on use after idle time', async () => {
    const configuration = {};
    const readCredential = vi
      .fn(async () => token)
      .mockResolvedValueOnce(token)
      .mockResolvedValueOnce(nextToken);
    const credentials = new CodexCredentials(
      { getAccessToken: async () => undefined },
      { get: async () => ({ ...DEFAULT_APP_SETTINGS, credentialSource: 'sandbox' }) },
      { configurationKey: async () => configuration, readCredential },
    );
    vi.useFakeTimers({ now: 0 });
    try {
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(readCredential).not.toHaveBeenCalled();
      expect(await credentials.getAccessToken()).toBe(token);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await credentials.getAccessToken()).toBe(token);
      await vi.advanceTimersByTimeAsync(239_998);
      expect(await credentials.getAccessToken()).toBe(token);
      expect(readCredential).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(await credentials.credentialSync.getStatus()).toBe('synced');
      expect(readCredential).toHaveBeenCalledOnce();
      expect(
        await Promise.all([credentials.getAccessToken(), credentials.getAccessToken()]),
      ).toEqual([nextToken, nextToken]);
      expect(readCredential).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['unavailable', 'invalid', 'missing'])(
    'redacts %s sync failures and offers manual authentication',
    async (mode) => {
      const configuration = {};
      const credentials = new CodexCredentials(
        { getAccessToken: async () => token },
        {
          get: async () => ({ ...DEFAULT_APP_SETTINGS, credentialSource: 'sandbox' }),
        },
        {
          configurationKey: async () => (mode === 'missing' ? null : configuration),
          readCredential: async () => {
            if (mode === 'unavailable') throw new Error('secret upstream response');
            return 'secret invalid token';
          },
        },
      );
      await expect(credentials.getAccessToken()).rejects.toMatchObject({
        code: 'AUTH',
        message: expect.stringContaining('manual authentication'),
      });
      await expect(credentials.getAccessToken()).rejects.not.toThrow('secret');
      expect(await credentials.credentialSync.getStatus()).toBe('failed');
    },
  );
});
