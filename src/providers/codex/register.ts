import { register } from '../registry';
import { CodexProvider } from './provider';
import { CodexCredentials } from './credentials';
import { CODEX_MODEL } from './codex-constants';
import type { StorageAreaPort } from '../../persistence/storage-area';

/** Existing installations used provider-specific setting names. Keep that migration here. */
export async function migrateCodexSettings(storage: StorageAreaPort): Promise<void> {
  const stored = (await storage.get('settings.app'))['settings.app'];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
  const value = stored as Record<string, unknown>;
  if (
    typeof value.providerId === 'string' &&
    !('codexCredentialSource' in value) &&
    !('codexAuthPath' in value)
  )
    return;
  const { codexCredentialSource, codexAuthPath, ...rest } = value;
  await storage.set({
    'settings.app': {
      ...rest,
      providerId: value.providerId ?? 'codex',
      credentialSource: value.credentialSource ?? codexCredentialSource ?? 'manual',
      authPath: value.authPath ?? codexAuthPath ?? '~/.codex/auth.json',
    },
  });
}

register({
  id: 'codex',
  name: 'Codex',
  default: true,
  credentialKey: 'codexAccessToken',
  defaults: { model: CODEX_MODEL, reasoningEffort: 'medium', authPath: '~/.codex/auth.json' },
  initialize: migrateCodexSettings,
  create: (host) =>
    new CodexProvider(
      new CodexCredentials(
        { getAccessToken: () => host.credentials.getProviderToken('codexAccessToken') },
        host.settings,
        host.sandbox,
      ),
    ),
});
