let databaseSequence = 0;

/**
 * Returns a unique in-memory IndexedDB name so persistence tests cannot share state.
 */
export function createTestDatabaseName(label: string): string {
  databaseSequence += 1;
  return `chatbrowserx-test-${label}-${databaseSequence}`;
}

export class MemoryStorageArea {
  readonly values: Record<string, unknown> = {};
  accessLevel: string | null = null;
  failWrites = false;

  /**
   * Reads one key or a list of keys using the Promise form of the Chrome storage contract.
   */
  async get(keys?: string | readonly string[]): Promise<Record<string, unknown>> {
    if (keys === undefined) {
      return { ...this.values };
    }

    const requestedKeys = typeof keys === 'string' ? [keys] : keys;
    return Object.fromEntries(
      requestedKeys.filter((key) => key in this.values).map((key) => [key, this.values[key]]),
    );
  }

  /**
   * Stores values or simulates an unsafe lower-level error for redaction tests.
   */
  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failWrites) {
      throw new Error(`Storage rejected ${JSON.stringify(items)}.`);
    }

    Object.assign(this.values, items);
  }

  /**
   * Records the access level requested by the trusted credential repository.
   */
  async setAccessLevel(options: { accessLevel: string }): Promise<void> {
    this.accessLevel = options.accessLevel;
  }
}
