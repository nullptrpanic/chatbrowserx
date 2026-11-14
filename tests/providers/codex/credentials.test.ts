import { describe, expect, it, vi } from 'vitest';
import { CodexCredentials } from '../../../src/providers/codex/credentials';
import { DEFAULT_APP_SETTINGS } from '../../../src/persistence/settings-store';

const token = `${btoa('{}').replace(/=+$/, '')}.${btoa(JSON.stringify({ chatgpt_account_id: 'fixture' })).replace(/=+$/, '')}.`;
const signal = new AbortController().signal;

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

  it('reads the configured file and shares only concurrent reads, never persisting the token', async () => {
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
    await credentials.getAccessToken();
    expect(sandbox.readCredential).toHaveBeenCalledTimes(2);
  });

  it.each(['unavailable', 'invalid', 'missing'])(
    'redacts %s sync failures and offers manual authentication',
    async (mode) => {
      const credentials = new CodexCredentials(
        { getAccessToken: async () => token },
        {
          get: async () => ({ ...DEFAULT_APP_SETTINGS, credentialSource: 'sandbox' }),
        },
        {
          configurationKey: async () => (mode === 'missing' ? null : {}),
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
      expect(signal.aborted).toBe(false);
    },
  );
});
