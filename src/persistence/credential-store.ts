import { ChromeLocalStorageArea, type TrustedStorageAreaPort } from './storage-area';

export interface CredentialStore {
  initialize(): Promise<void>;
  getCodexAccessToken(): Promise<string | undefined>;
  setCodexAccessToken(value: string): Promise<void>;
  getTavilyKey(): Promise<string | undefined>;
  setTavilyKey(value: string): Promise<void>;
  getSandboxToken(): Promise<string | undefined>;
  setSandboxToken(value: string): Promise<void>;
}

const CODEX_TOKEN_KEY = 'credentials.codexAccessToken';
const TAVILY_KEY = 'credentials.tavilyKey';
const SANDBOX_TOKEN_KEY = 'credentials.sandboxToken';

export class ChromeCredentialStore implements CredentialStore {
  readonly #storage: TrustedStorageAreaPort;

  /**
   * Creates a credential store backed by an injected or real trusted Chrome storage boundary.
   */
  constructor(storage: TrustedStorageAreaPort = new ChromeLocalStorageArea()) {
    this.#storage = storage;
  }

  /**
   * Restricts the entire local storage area to trusted extension contexts before credential use.
   */
  async initialize(): Promise<void> {
    await this.#storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  }

  /**
   * Reads the Codex Access Token only for trusted extension services.
   */
  async getCodexAccessToken(): Promise<string | undefined> {
    return this.#readCredential(CODEX_TOKEN_KEY, 'Codex Access Token');
  }

  /**
   * Saves a nonblank Codex Access Token and redacts any lower-level storage failure.
   */
  async setCodexAccessToken(value: string): Promise<void> {
    await this.#writeCredential(CODEX_TOKEN_KEY, value, 'Codex Access Token');
  }

  /** Reads the Tavily Key only for trusted extension services. */
  async getTavilyKey(): Promise<string | undefined> {
    return this.#readCredential(TAVILY_KEY, 'Tavily Key');
  }

  /** Saves a nonblank Tavily Key and redacts any lower-level storage failure. */
  async setTavilyKey(value: string): Promise<void> {
    await this.#writeCredential(TAVILY_KEY, value, 'Tavily Key');
  }

  /** Reads the Sandbox Token only for trusted extension services. */
  async getSandboxToken(): Promise<string | undefined> {
    return this.#readCredential(SANDBOX_TOKEN_KEY, 'Sandbox Token');
  }

  /** Saves a nonblank Sandbox Token and redacts any lower-level storage failure. */
  async setSandboxToken(value: string): Promise<void> {
    await this.#writeCredential(SANDBOX_TOKEN_KEY, value, 'Sandbox Token');
  }

  /**
   * Reads and validates one credential without returning non-string storage values.
   */
  async #readCredential(key: string, label: string): Promise<string | undefined> {
    try {
      const value = (await this.#storage.get(key))[key];
      if (value === undefined) {
        return undefined;
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Invalid stored value.');
      }
      return value;
    } catch {
      throw new Error(`Unable to read ${label}.`);
    }
  }

  /**
   * Writes one trimmed credential while replacing unsafe storage errors with a stable message.
   */
  async #writeCredential(key: string, value: string, label: string): Promise<void> {
    const normalized = value.trim();
    if (normalized.length === 0) {
      throw new Error(`${label} must not be blank.`);
    }

    try {
      await this.#storage.set({ [key]: normalized });
    } catch {
      throw new Error(`Unable to store ${label}.`);
    }
  }
}
