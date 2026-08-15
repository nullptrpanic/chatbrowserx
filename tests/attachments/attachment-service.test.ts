import { describe, expect, it, vi } from 'vitest';
import type { AttachmentRepository } from '../../src/persistence/attachment-repository';
import { AttachmentService } from '../../src/attachments/attachment-service';

/** Creates an in-memory repository double that records exactly one Blob per attachment. */
function repositoryFixture() {
  const records = new Map<string, Parameters<AttachmentRepository['put']>[0]>();
  const repository = {
    put: vi.fn(async (input: Parameters<AttachmentRepository['put']>[0]) => {
      records.set(input.id, input);
      return input;
    }),
    get: vi.fn(async (id: string) => records.get(id)),
    addReference: vi.fn(async () => undefined),
    removeReference: vi.fn(async () => undefined),
    deleteUnreferenced: vi.fn(async () => 0),
  } satisfies AttachmentRepository;
  return { records, repository };
}

describe('AttachmentService', () => {
  it('validates, sanitizes names, and persists image Blob metadata once', async () => {
    const fixture = repositoryFixture();
    const service = new AttachmentService(fixture.repository, {
      clock: { now: () => 1_000 },
      ids: { create: () => 'attachment_1' },
      readDimensions: vi.fn(async () => ({ width: 640, height: 480 })),
    });
    const file = new File([new Uint8Array([1, 2, 3])], '../private/photo.png', {
      type: 'image/png',
    });

    const [record] = await service.addImages([file], 'file');

    expect(record).toMatchObject({
      id: 'attachment_1',
      blob: file,
      mimeType: 'image/png',
      byteSize: 3,
      width: 640,
      height: 480,
      source: 'file',
      fileName: 'photo.png',
      createdAt: 1_000,
    });
    expect(fixture.repository.put).toHaveBeenCalledTimes(1);
  });

  it('adds and removes explicit durable references through the repository', async () => {
    const fixture = repositoryFixture();
    const service = new AttachmentService(fixture.repository, {
      clock: { now: () => 1_000 },
      ids: { create: () => 'attachment_1' },
    });

    await service.addReference('attachment_1', 'draft:1');
    await service.removeReference('attachment_1', 'draft:1');

    expect(fixture.repository.addReference).toHaveBeenCalledWith('attachment_1', 'draft:1');
    expect(fixture.repository.removeReference).toHaveBeenCalledWith('attachment_1', 'draft:1');
  });

  it('stores a validated captured PNG without requiring a File wrapper', async () => {
    const fixture = repositoryFixture();
    const service = new AttachmentService(fixture.repository, {
      clock: { now: () => 1_000 },
      ids: { create: () => 'attachment_capture' },
    });
    const blob = new Blob(['png'], { type: 'image/png' });

    await expect(service.addImageBlob(blob, 'viewport_capture')).resolves.toMatchObject({
      id: 'attachment_capture',
      blob,
      source: 'viewport_capture',
      width: null,
      height: null,
    });
  });
});
