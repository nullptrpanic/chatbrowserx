import type { IDBPDatabase } from 'idb';
import type { AttachmentRecord, NewAttachment } from '../attachments/attachment-types';
import type { AttachmentId } from '../shared/ids';
import type { ChatBrowserDatabase } from './database-schema';

export interface AttachmentRepository {
  put(input: NewAttachment): Promise<AttachmentRecord>;
  get(id: AttachmentId): Promise<AttachmentRecord | undefined>;
  addReference(id: AttachmentId, referenceId: string): Promise<void>;
  removeReference(id: AttachmentId, referenceId: string): Promise<void>;
  deleteUnreferenced(before: number): Promise<number>;
}

export class IndexedDbAttachmentRepository implements AttachmentRepository {
  readonly #database: IDBPDatabase<ChatBrowserDatabase>;

  /**
   * Creates an attachment repository over an already opened application database.
   */
  constructor(database: IDBPDatabase<ChatBrowserDatabase>) {
    this.#database = database;
  }

  /**
   * Stores one validated Blob record exactly once and returns the durable representation.
   */
  async put(input: NewAttachment): Promise<AttachmentRecord> {
    if (input.id.trim().length === 0) {
      throw new Error('Attachment ID is required.');
    }
    if (input.byteSize !== input.blob.size || input.byteSize <= 0) {
      throw new Error('Attachment byte size does not match its Blob.');
    }
    if (input.mimeType.trim().length === 0 || !Number.isFinite(input.createdAt)) {
      throw new Error('Attachment metadata is invalid.');
    }

    const record: AttachmentRecord = { ...input };
    await this.#database.add('attachments', record);
    return record;
  }

  /**
   * Retrieves one stored attachment without materializing or duplicating its Blob bytes.
   */
  async get(id: AttachmentId): Promise<AttachmentRecord | undefined> {
    return this.#database.get('attachments', id);
  }

  /**
   * Adds one idempotent owner reference after verifying that the attachment exists.
   */
  async addReference(id: AttachmentId, referenceId: string): Promise<void> {
    if (referenceId.trim().length === 0) {
      throw new Error('Attachment reference ID is required.');
    }

    const transaction = this.#database.transaction(
      ['attachments', 'attachment-references'],
      'readwrite',
    );
    const attachment = await transaction.objectStore('attachments').get(id);
    if (attachment === undefined) {
      throw new Error('Attachment does not exist.');
    }

    await transaction.objectStore('attachment-references').put({
      attachmentId: id,
      referenceId,
    });
    await transaction.done;
  }

  /**
   * Removes one owner reference and treats an already absent reference as a successful no-op.
   */
  async removeReference(id: AttachmentId, referenceId: string): Promise<void> {
    await this.#database.delete('attachment-references', [id, referenceId]);
  }

  /**
   * Deletes attachments older than the cutoff only when no durable owner reference remains.
   */
  async deleteUnreferenced(before: number): Promise<number> {
    const transaction = this.#database.transaction(
      ['attachments', 'attachment-references'],
      'readwrite',
    );
    const attachments = await transaction
      .objectStore('attachments')
      .index('by-created-at')
      .getAll(IDBKeyRange.upperBound(before, true));
    let deleted = 0;

    for (const attachment of attachments) {
      const referenceCount = await transaction
        .objectStore('attachment-references')
        .index('by-attachment')
        .count(attachment.id);
      if (referenceCount === 0) {
        await transaction.objectStore('attachments').delete(attachment.id);
        deleted += 1;
      }
    }

    await transaction.done;
    return deleted;
  }
}
