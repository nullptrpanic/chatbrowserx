import { describe, expect, it } from 'vitest';
import { ChromeSettingsStore, DEFAULT_APP_SETTINGS } from '../../src/persistence/settings-store';
import { MemoryStorageArea } from './test-helpers';

describe('ChromeSettingsStore', () => {
  it('migrates stored settings without a history limit to the default', async () => {
    const storage = new MemoryStorageArea();
    storage.values['settings.app'] = {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'system',
    };

    await expect(new ChromeSettingsStore(storage).get()).resolves.toMatchObject({
      historyMessageLimit: 50,
    });
  });

  it('returns exact defaults and saves normalized valid settings', async () => {
    const storage = new MemoryStorageArea();
    const store = new ChromeSettingsStore(storage);

    await expect(store.get()).resolves.toEqual(DEFAULT_APP_SETTINGS);
    await store.save({
      model: '  gpt-5.6-terra  ',
      reasoningEffort: 'high',
      systemPrompt: 'Keep browser actions concise.',
      language: 'zh-CN',
      historyMessageLimit: 42,
    });

    await expect(store.get()).resolves.toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      systemPrompt: 'Keep browser actions concise.',
      language: 'zh-CN',
      historyMessageLimit: 42,
    });
  });

  it('clamps a previously valid stored history limit above 50', async () => {
    const storage = new MemoryStorageArea();
    storage.values['settings.app'] = {
      model: 'gpt-5.6-terra',
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'system',
      historyMessageLimit: 75,
    };

    await expect(new ChromeSettingsStore(storage).get()).resolves.toMatchObject({
      historyMessageLimit: 50,
    });
  });

  it('rejects invalid settings and resets without deleting credentials', async () => {
    const storage = new MemoryStorageArea();
    storage.values['credentials.codexAccessToken'] = 'keep-me';
    const store = new ChromeSettingsStore(storage);

    await expect(
      store.save({ ...DEFAULT_APP_SETTINGS, reasoningEffort: 'ultra' as never }),
    ).rejects.toThrow(/invalid app settings/i);
    await store.reset();

    expect(storage.values['credentials.codexAccessToken']).toBe('keep-me');
    await expect(store.get()).resolves.toEqual(DEFAULT_APP_SETTINGS);
  });

  it.each([0, 51, 1.5])('rejects invalid history limit %s', async (historyMessageLimit) => {
    const store = new ChromeSettingsStore(new MemoryStorageArea());

    await expect(store.save({ ...DEFAULT_APP_SETTINGS, historyMessageLimit })).rejects.toThrow(
      /invalid app settings/i,
    );
  });
});
