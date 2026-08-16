import { describe, expect, it } from 'vitest';
import { ChromeCredentialStore } from '../../src/persistence/credential-store';
import { MemoryStorageArea } from './test-helpers';

describe('ChromeCredentialStore', () => {
  it('restricts storage to trusted contexts and round-trips trimmed credentials', async () => {
    const storage = new MemoryStorageArea();
    storage.values['credentials.tavilyKey'] = 'legacy-key';
    const store = new ChromeCredentialStore(storage);

    await store.initialize();
    await store.setCodexAccessToken('  codex-token  ');

    expect(storage.accessLevel).toBe('TRUSTED_CONTEXTS');
    expect(storage.values).not.toHaveProperty('credentials.tavilyKey');
    await expect(store.getCodexAccessToken()).resolves.toBe('codex-token');
  });

  it('rejects blank credentials', async () => {
    const store = new ChromeCredentialStore(new MemoryStorageArea());

    await expect(store.setCodexAccessToken('   ')).rejects.toThrow(/codex access token/i);
  });

  it('redacts credential values from lower-level storage errors', async () => {
    const storage = new MemoryStorageArea();
    storage.failWrites = true;
    const store = new ChromeCredentialStore(storage);
    const secret = 'secret-token-value';

    try {
      await store.setCodexAccessToken(secret);
      throw new Error('Expected the credential write to fail.');
    } catch (error) {
      expect(String(error)).toMatch(/unable to store codex access token/i);
      expect(String(error)).not.toContain(secret);
    }
  });
});
