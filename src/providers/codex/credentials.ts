import type { SettingsStore } from '../../persistence/settings-store';
import type { SandboxClient } from '../../sandbox/sandbox-client';
import { providerErrorFromCode } from '../provider-error';
import { extractChatGptAccountId } from './access-token';

/** Host-owned authentication. Tokens never pass through model tools or conversation persistence. */
export class CodexCredentials {
  private pending: { path: string; configuration: object; value: Promise<string> } | null = null;

  constructor(
    private readonly manual: { getAccessToken(): Promise<string | undefined> },
    private readonly settings: Pick<SettingsStore, 'get'>,
    private readonly sandbox: Pick<SandboxClient, 'configurationKey' | 'readCredential'>,
  ) {}

  async getAccessToken(): Promise<string | undefined> {
    const settings = await this.settings.get();
    if (settings.credentialSource !== 'sandbox') return this.manual.getAccessToken();
    const path = settings.authPath || '~/.codex/auth.json';
    const configuration = await this.sandbox.configurationKey();
    if (!configuration) throw providerErrorFromCode('AUTH', { credentialSource: 'sandbox' });
    if (this.pending?.path === path && this.pending.configuration === configuration)
      return this.pending.value;
    const value = this.sandbox
      .readCredential(path, ['tokens', 'access_token'], AbortSignal.timeout(10_000))
      .then((token) => {
        extractChatGptAccountId(token);
        return token;
      })
      .catch(() => {
        throw providerErrorFromCode('AUTH', { credentialSource: 'sandbox' });
      });
    const pending = { path, configuration, value };
    this.pending = pending;
    try {
      return await value;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
}
