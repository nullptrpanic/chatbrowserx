// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry, type ProviderRegistration } from '../../src/providers/registry';
import type { Provider } from '../../src/providers/provider';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../../src/persistence/settings-store';
import { MemoryStorageArea } from '../persistence/test-helpers';
import { migrateCodexSettings } from '../../src/providers/codex/register';

function fixture() {
  let settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
  const credentials = new Map<string, string>([
    ['first.secret', 'first-token'],
    ['second.secret', 'second-token'],
  ]);
  const storage = new MemoryStorageArea();
  const makeDefinition = (id: string): ProviderRegistration => ({
    id,
    name: id,
    default: id === 'first',
    credentialKey: `${id}.secret`,
    defaults: { model: `${id}-model`, reasoningEffort: `${id}-effort`, authPath: `/${id}/auth` },
    create: vi.fn(
      () =>
        ({
          getModel: async () => {
            throw new Error('Not requested in configuration tests');
          },
          listModels: async () => [
            {
              id: `${id}-model`,
              name: id,
              contextWindow: 1000,
              defaultReasoningEffort: `${id}-effort`,
              reasoningEfforts: [`${id}-effort`],
            },
          ],
          compact: async () => ({ items: [], usage: null }),
        }) satisfies Provider,
    ),
  });
  const definitions = [makeDefinition('first'), makeDefinition('second')];
  const registry = new ProviderRegistry(definitions, {
    storage,
    settings: { get: async () => settings },
    credentials: {
      getProviderToken: async (key) => credentials.get(key),
      setProviderToken: async (key, value) => {
        credentials.set(key, value);
      },
    },
    sandbox: {
      configurationKey: async () => null,
      readCredential: async () => {
        throw new Error('Not used');
      },
    },
  });
  return {
    registry,
    definitions,
    credentials,
    storage,
    select: (value: Partial<AppSettings>) => {
      settings = { ...DEFAULT_APP_SETTINGS, ...value };
    },
  };
}

describe('provider registration and configuration', () => {
  it('resolves defaults and discovers another implementation without a vendor branch', async () => {
    const f = fixture();
    const first = await f.registry.resolve();
    expect(first.settings).toMatchObject({
      providerId: 'first',
      model: 'first-model',
      reasoningEffort: 'first-effort',
      authPath: '/first/auth',
    });
    expect((await f.registry.resolve()).provider).toBe(first.provider);
    f.select({ providerId: 'second' });
    expect((await f.registry.resolve()).settings).toMatchObject({
      providerId: 'second',
      model: 'second-model',
    });
    expect((await f.registry.listModels(new AbortController().signal))[0]?.id).toBe('second-model');
    expect(
      f.definitions.map((definition) => vi.mocked(definition.create).mock.calls.length),
    ).toEqual([1, 1]);
  });

  it('keeps credentials provider-scoped and never includes them in public configuration', async () => {
    const f = fixture();
    expect(await f.registry.readToken()).toBe('first-token');
    expect(JSON.stringify(await f.registry.configuration())).not.toContain('first-token');
    f.select({ providerId: 'second' });
    await f.registry.saveToken('changed-second');
    expect(f.credentials.get('first.secret')).toBe('first-token');
    expect(await f.registry.readToken()).toBe('changed-second');
  });

  it('does not silently replace an unavailable configured provider with the default', async () => {
    const f = fixture();
    f.select({ providerId: 'missing' });
    await expect(f.registry.resolve()).rejects.toThrow('unavailable');
    expect(
      f.definitions.every((definition) => vi.mocked(definition.create).mock.calls.length === 0),
    ).toBe(true);
  });

  it('keeps configured model and reasoning selections unchanged', async () => {
    const f = fixture();
    f.select({ model: 'private-model', reasoningEffort: 'custom', authPath: '/custom/auth' });
    expect((await f.registry.resolve()).settings).toMatchObject({
      model: 'private-model',
      reasoningEffort: 'custom',
      authPath: '/custom/auth',
    });
  });

  it('migrates existing settings in the concrete provider without changing credentials or prompts', async () => {
    const storage = new MemoryStorageArea();
    storage.values['credentials.codexAccessToken'] = 'private-existing-token';
    storage.values['settings.app'] = {
      model: 'existing-model',
      reasoningEffort: 'high',
      systemPrompt: 'exact user prompt',
      language: 'en',
      codexCredentialSource: 'sandbox',
      codexAuthPath: '/private/custom auth.json',
    };
    await migrateCodexSettings(storage);
    expect(storage.values['settings.app']).toEqual({
      providerId: 'codex',
      model: 'existing-model',
      reasoningEffort: 'high',
      systemPrompt: 'exact user prompt',
      language: 'en',
      credentialSource: 'sandbox',
      authPath: '/private/custom auth.json',
    });
    expect(storage.values['credentials.codexAccessToken']).toBe('private-existing-token');
    const first = structuredClone(storage.values);
    await migrateCodexSettings(storage);
    expect(storage.values).toEqual(first);
  });
});
