interface ObjectUrlEntry {
  readonly blob: Blob;
  readonly url: string;
  references: number;
}

export class ObjectUrlRegistry {
  readonly #entries = new Map<string, ObjectUrlEntry>();

  /** Acquires one reusable object URL and increments its local display reference count. */
  acquire(id: string, blob: Blob): string {
    const existing = this.#entries.get(id);
    if (existing !== undefined) {
      if (existing.blob !== blob) throw new Error('Attachment ID refers to a different Blob.');
      existing.references += 1;
      return existing.url;
    }
    const url = URL.createObjectURL(blob);
    this.#entries.set(id, { blob, url, references: 1 });
    return url;
  }

  /** Releases one display reference and revokes the URL at zero references. */
  release(id: string): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    this.#entries.delete(id);
    URL.revokeObjectURL(entry.url);
  }

  /** Revokes every remaining URL and clears all local display references. */
  releaseAll(): void {
    for (const entry of this.#entries.values()) URL.revokeObjectURL(entry.url);
    this.#entries.clear();
  }
}
