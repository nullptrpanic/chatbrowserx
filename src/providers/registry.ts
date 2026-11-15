import type { CredentialStore } from '../persistence/credential-store';
import type { AppSettings, SettingsStore } from '../persistence/settings-store';
import type { StorageAreaPort } from '../persistence/storage-area';
import type { SandboxClient } from '../sandbox/sandbox-client';
import type { CredentialSyncSelection, CredentialSyncStatus, Provider } from './provider';

export interface ProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly defaults: {
    readonly model: string;
    readonly reasoningEffort: string;
    readonly authPath: string;
  };
}

export interface ProviderHost {
  readonly settings: Pick<SettingsStore, 'get'>;
  readonly credentials: Pick<CredentialStore, 'getProviderToken' | 'setProviderToken'>;
  readonly sandbox: Pick<SandboxClient, 'configurationKey' | 'readCredential'>;
  readonly storage: StorageAreaPort;
}

export interface ProviderRegistration extends ProviderDescriptor {
  readonly default?: boolean;
  /** Opaque storage name owned by this provider; it need not match a model or vendor name. */
  readonly credentialKey: string;
  readonly create: (host: ProviderHost) => Provider;
  readonly initialize?: (storage: StorageAreaPort) => Promise<void>;
}

const registrations = new Map<string, ProviderRegistration>();

export function register(definition: ProviderRegistration): void {
  if (registrations.has(definition.id)) throw new Error('Duplicate provider registration.');
  registrations.set(definition.id, definition);
}

export function registeredProviders(): readonly ProviderRegistration[] {
  return [...registrations.values()];
}

export interface ProviderConfiguration {
  readonly providerId: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly credentialSource: 'manual' | 'sandbox';
  readonly credentialSyncStatus?: CredentialSyncStatus | undefined;
  readonly authPath: string;
  readonly hasAccessToken: boolean;
  readonly providers: readonly ProviderDescriptor[];
}

interface ProviderInstance {
  readonly id: string;
  readonly identity: string;
  readonly provider: Provider;
}

/** Resolves registered implementations and configuration without inspecting their wire protocol. */
export class ProviderRegistry {
  private readonly instances = new Map<string, ProviderInstance>();
  private preview: ProviderInstance | undefined;
  private readonly defaultProvider: ProviderRegistration;

  constructor(
    private readonly definitions: readonly ProviderRegistration[],
    private readonly host: ProviderHost,
  ) {
    const defaults = definitions.filter((definition) => definition.default);
    const [defaultProvider] = defaults;
    if (defaults.length !== 1 || !defaultProvider)
      throw new Error('Exactly one default provider must be registered.');
    if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length)
      throw new Error('Duplicate provider registration.');
    this.defaultProvider = defaultProvider;
  }

  async initialize(): Promise<void> {
    for (const definition of this.definitions) await definition.initialize?.(this.host.storage);
  }

  async resolve() {
    return this.resolveSettings(await this.host.settings.get());
  }

  /** Refreshes saved Sandbox credentials, or tests settings before they are saved. */
  async syncToken(selection?: CredentialSyncSelection): Promise<CredentialSyncStatus> {
    const settings = await this.host.settings.get();
    const selected = selection
      ? {
          ...settings,
          providerId: selection.providerId ?? settings.providerId ?? '',
          credentialSource: 'sandbox' as const,
          authPath: selection.authPath,
        }
      : settings;
    if (selected.credentialSource !== 'sandbox') return 'idle';
    const { provider } = this.resolveSettings(selected, selection !== undefined);
    return (await provider.credentialSync?.refresh()) ?? 'failed';
  }

  private resolveSettings(
    settings: AppSettings,
    preview = false,
  ): {
    provider: Provider;
    settings: AppSettings;
    providerId: string;
  } {
    const definition = this.definition(settings.providerId);
    const resolved: AppSettings = {
      ...settings,
      providerId: definition.id,
      model: settings.model || definition.defaults.model,
      reasoningEffort: settings.reasoningEffort || definition.defaults.reasoningEffort,
      credentialSource: settings.credentialSource ?? 'manual',
      authPath: settings.authPath || definition.defaults.authPath,
    };
    const identity = JSON.stringify([resolved.credentialSource, resolved.authPath]);
    let cached = this.instances.get(definition.id);
    if (cached?.identity !== identity) {
      const draft =
        this.preview?.id === definition.id && this.preview.identity === identity
          ? this.preview
          : undefined;
      cached = draft ?? {
        id: definition.id,
        identity,
        provider: definition.create({
          ...this.host,
          settings: { get: async () => resolved },
        }),
      };
      if (preview) this.preview = cached;
      else {
        this.instances.set(definition.id, cached);
        if (draft) this.preview = undefined;
      }
    }
    return {
      provider: cached.provider,
      providerId: definition.id,
      settings: resolved,
    };
  }

  async configuration(): Promise<ProviderConfiguration> {
    const { provider, settings, providerId } = await this.resolve();
    return {
      providerId,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      credentialSource: settings.credentialSource ?? 'manual',
      ...(settings.credentialSource === 'sandbox'
        ? {
            credentialSyncStatus: (await provider.credentialSync?.getStatus()) ?? 'failed',
          }
        : {}),
      authPath: settings.authPath ?? '',
      hasAccessToken:
        (await this.host.credentials
          .getProviderToken(this.definition(providerId).credentialKey)
          .catch(() => undefined)) !== undefined,
      providers: this.definitions.map(({ id, name, defaults }) => ({
        id,
        name,
        defaults,
      })),
    };
  }

  async readToken(): Promise<string | undefined> {
    const definition = this.definition((await this.host.settings.get()).providerId);
    return this.host.credentials.getProviderToken(definition.credentialKey);
  }

  async saveToken(value: string): Promise<void> {
    const definition = this.definition((await this.host.settings.get()).providerId);
    await this.host.credentials.setProviderToken(definition.credentialKey, value);
  }

  async listModels(signal: AbortSignal) {
    return (await this.resolve()).provider.listModels(signal);
  }

  private definition(id?: string): ProviderRegistration {
    const definition = id
      ? this.definitions.find((candidate) => candidate.id === id)
      : this.defaultProvider;
    if (!definition) throw new Error('The configured provider is unavailable.');
    return definition;
  }
}
