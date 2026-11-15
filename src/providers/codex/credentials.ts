import type { SettingsStore } from '../../persistence/settings-store';
import type { SandboxClient } from '../../sandbox/sandbox-client';
import type { CredentialSyncStatus, ProviderCredentialSync } from '../provider';
import { providerErrorFromCode } from '../provider-error';
import { extractChatGptAccountId } from './access-token';

const TOKEN_CACHE_MS = 60_000;

interface SandboxCredential {
  readonly path: string;
  readonly configuration: object | null;
  status: CredentialSyncStatus;
  token?: { readonly value: string; readonly syncedAt: number };
  pending?: Promise<string>;
}

/** Host-owned authentication. Tokens never pass through model tools or conversation persistence. */
export class CodexCredentials {
  private credential: SandboxCredential | null = null;

  readonly credentialSync: ProviderCredentialSync = {
    getStatus: async () => (await this.currentCredential())?.status ?? 'idle',
    refresh: async () => {
      const credential = await this.currentCredential();
      if (!credential) return 'idle';
      return this.refresh(credential).then(
        () => 'synced',
        () => 'failed',
      );
    },
  };

  constructor(
    private readonly manual: { getAccessToken(): Promise<string | undefined> },
    private readonly settings: Pick<SettingsStore, 'get'>,
    private readonly sandbox: Pick<SandboxClient, 'configurationKey' | 'readCredential'>,
  ) {}

  async getAccessToken(): Promise<string | undefined> {
    const credential = await this.currentCredential();
    if (!credential) return this.manual.getAccessToken();
    const token = credential.token;
    if (token && Date.now() - token.syncedAt < TOKEN_CACHE_MS) return token.value;
    return this.refresh(credential);
  }

  private async currentCredential(): Promise<SandboxCredential | null> {
    const settings = await this.settings.get();
    if (settings.credentialSource !== 'sandbox') {
      this.credential = null;
      return null;
    }
    const path = settings.authPath || '~/.codex/auth.json';
    const configuration = await this.sandbox.configurationKey();
    if (this.credential?.path !== path || this.credential.configuration !== configuration) {
      this.credential = { path, configuration, status: configuration ? 'idle' : 'failed' };
    }
    return this.credential;
  }

  private async refresh(credential: SandboxCredential): Promise<string> {
    if (credential.pending) return credential.pending;
    if (!credential.configuration)
      throw providerErrorFromCode('AUTH', { credentialSource: 'sandbox' });
    credential.pending = this.sandbox
      .readCredential(credential.path, ['tokens', 'access_token'], AbortSignal.timeout(10_000))
      .then(async (token) => {
        if ((await this.sandbox.configurationKey()) !== credential.configuration)
          throw providerErrorFromCode('AUTH');
        extractChatGptAccountId(token);
        credential.token = { value: token, syncedAt: Date.now() };
        credential.status = 'synced';
        return token;
      })
      .catch(() => {
        delete credential.token;
        credential.status = 'failed';
        throw providerErrorFromCode('AUTH', { credentialSource: 'sandbox' });
      })
      .finally(() => {
        delete credential.pending;
      });
    return credential.pending;
  }
}
