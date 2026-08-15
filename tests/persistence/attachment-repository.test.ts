// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IndexedDbAttachmentRepository } from '../../src/persistence/attachment-repository';
import { openChatBrowserDatabase } from '../../src/persistence/open-database';
import { createTestDatabaseName } from './test-helpers';

describe('IndexedDbAttachmentRepository', () => {
  it('round-trips Blob bytes and deletes only old unreferenced attachments', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('attachment'));
    const repository = new IndexedDbAttachmentRepository(database);
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });

    await repository.put({
      id: 'attachment_1',
      blob,
      mimeType: 'image/png',
      byteSize: 3,
      width: 1,
      height: 1,
      source: 'file',
      createdAt: 10,
    });
    const recovered = await repository.get('attachment_1');

    expect(recovered).toMatchObject({ id: 'attachment_1', byteSize: 3 });
    if (recovered === undefined) {
      throw new Error('Expected the stored attachment to exist.');
    }
    expect([...new Uint8Array(await recovered.blob.arrayBuffer())]).toEqual([1, 2, 3]);
    await expect(repository.deleteUnreferenced(10)).resolves.toBe(0);

    await repository.addReference('attachment_1', 'message:message_1');
    await repository.addReference('attachment_1', 'message:message_1');
    await expect(repository.deleteUnreferenced(11)).resolves.toBe(0);

    await repository.removeReference('attachment_1', 'message:message_1');
    await expect(repository.deleteUnreferenced(11)).resolves.toBe(1);
    await expect(repository.get('attachment_1')).resolves.toBeUndefined();
    database.close();
  });

  it('rejects references to missing attachments', async () => {
    const database = await openChatBrowserDatabase(createTestDatabaseName('attachment-missing'));
    const repository = new IndexedDbAttachmentRepository(database);

    await expect(repository.addReference('missing', 'message:message_1')).rejects.toThrow(
      /attachment does not exist/i,
    );
    database.close();
  });
});
