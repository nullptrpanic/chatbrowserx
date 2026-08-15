export interface StorageAreaPort {
  get(keys?: string | readonly string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface TrustedStorageAreaPort extends StorageAreaPort {
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
}

export class ChromeLocalStorageArea implements TrustedStorageAreaPort {
  /**
   * Reads selected values from Chrome local storage in a trusted extension context.
   */
  async get(keys?: string | readonly string[]): Promise<Record<string, unknown>> {
    return chrome.storage.local.get(
      keys === undefined ? null : [...(typeof keys === 'string' ? [keys] : keys)],
    );
  }

  /**
   * Writes selected values to Chrome local storage without exposing them to page contexts.
   */
  async set(items: Record<string, unknown>): Promise<void> {
    await chrome.storage.local.set(items);
  }

  /**
   * Restricts Chrome local storage access to trusted extension contexts.
   */
  async setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void> {
    await chrome.storage.local.setAccessLevel(options);
  }
}
