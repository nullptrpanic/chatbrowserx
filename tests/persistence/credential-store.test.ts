import { describe, expect, it } from 'vitest';
import { ChromeCredentialStore } from '../../src/persistence/credential-store';
import { MemoryStorageArea } from './test-helpers';

describe('ChromeCredentialStore', () => {
  it('restricts storage to trusted contexts and round-trips trimmed credentials', async () => {
    const storage = new MemoryStorageArea();
    storage.values['credentials.tavilyKey'] = 'saved-tavily-key';
    const store = new ChromeCredentialStore(storage);

    await store.initialize();
    await store.setCodexAccessToken('  codex-token  ');
    await store.setTavilyKey('  new-tavily-key  ');
    await store.setSandboxToken('  sandbox-token  ');

    expect(storage.accessLevel).toBe('TRUSTED_CONTEXTS');
    await expect(store.getCodexAccessToken()).resolves.toBe('codex-token');
    await expect(store.getTavilyKey()).resolves.toBe('new-tavily-key');
    await expect(store.getSandboxToken()).resolves.toBe('sandbox-token');
  });

  it('rejects blank credentials', async () => {
    const store = new ChromeCredentialStore(new MemoryStorageArea());

    await expect(store.setCodexAccessToken('   ')).rejects.toThrow(/codex access token/i);
    await expect(store.setTavilyKey('   ')).rejects.toThrow(/tavily key/i);
    await expect(store.setSandboxToken('   ')).rejects.toThrow(/sandbox token/i);
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

  it('redacts Tavily key values from lower-level storage errors', async () => {
    const storage = new MemoryStorageArea();
    storage.failWrites = true;
    const store = new ChromeCredentialStore(storage);
    const secret = 'secret-tavily-value';

    await expect(store.setTavilyKey(secret)).rejects.toThrow(/unable to store tavily key/i);
    try {
      await store.setTavilyKey(secret);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('redacts Sandbox token values from lower-level storage errors', async () => {
    const storage = new MemoryStorageArea();
    storage.failWrites = true;
    const store = new ChromeCredentialStore(storage);
    const secret = 'secret-sandbox-value';

    await expect(store.setSandboxToken(secret)).rejects.toThrow(/unable to store sandbox token/i);
    try {
      await store.setSandboxToken(secret);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
