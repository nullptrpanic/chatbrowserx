import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ObjectUrlRegistry } from '../../../src/attachments/object-url-registry';
import { validateImageBatch } from '../../../src/attachments/attachment-policy';
import { AttachmentPolicyError } from '../../../src/attachments/attachment-service';
import type { AttachmentDraftClient } from '../../../src/side-panel/chat/use-image-draft';
import { useImageDraft } from '../../../src/side-panel/chat/use-image-draft';

describe('useImageDraft', () => {
  it('enforces one combined quota on overlapping file and paste additions', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const files = Array.from(
      { length: 10 },
      (_, index) => new File(['png'], String(index), { type: 'image/png' }),
    );
    const client: AttachmentDraftClient = {
      addFiles: async (batch, source, usage) => {
        const checked = validateImageBatch(batch, usage);
        if (!checked.ok) throw new AttachmentPolicyError(checked.code);
        return batch.map((f) => ({
          id: f.name,
          blob: f,
          byteSize: f.size,
          mimeType: f.type,
          width: null,
          height: null,
          source,
          createdAt: 1,
        }));
      },
      get: async () => undefined,
    };
    const { result } = renderHook(() => useImageDraft({ client }));
    await act(async () => {
      await Promise.all([
        result.current.addFiles(files.slice(0, 5)),
        result.current.addFiles(files.slice(5), 'paste'),
      ]);
    });
    expect(result.current.attachmentIds).toEqual(['0', '1', '2', '3', '4']);
    expect(result.current.error).toBe('TOO_MANY_IMAGES');
  });

  it('discards a pending image load after the draft unmounts', async () => {
    const acquire = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stale');
    const blob = new Blob(['image'], { type: 'image/png' });
    let finishRead: (() => void) | undefined;
    const client = {
      addFiles: async () => [],
      get: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          finishRead = resolve;
        });
        return {
          id: 'old',
          blob,
          byteSize: blob.size,
          mimeType: blob.type,
          width: null,
          height: null,
          source: 'file' as const,
          createdAt: 1,
        };
      }),
    };
    const { result, unmount } = renderHook(() => useImageDraft({ client }));
    const pending = result.current.addExisting('old');
    await vi.waitFor(() => expect(client.get).toHaveBeenCalledWith('old'));
    unmount();
    finishRead?.();
    await pending;
    expect(acquire).not.toHaveBeenCalled();
  });

  it('adds, deduplicates, and removes Blob-backed previews', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const file = new File(['png'], 'photo.png', { type: 'image/png' });
    const client = {
      addFiles: vi.fn(async () => [
        {
          id: 'attachment_1',
          blob: file,
          mimeType: file.type,
          byteSize: file.size,
          width: null,
          height: null,
          source: 'file' as const,
          createdAt: 1_000,
          fileName: file.name,
        },
      ]),
      get: vi.fn(async () => undefined),
    };
    const urls = new ObjectUrlRegistry();
    const { result, unmount } = renderHook(() => useImageDraft({ client, urls }));

    await act(async () => {
      await result.current.addFiles([file]);
      await result.current.addFiles([file]);
    });
    expect(result.current.attachmentIds).toEqual(['attachment_1']);
    expect(client.addFiles).toHaveBeenCalledTimes(1);

    act(() => result.current.remove('attachment_1'));
    expect(result.current.items).toEqual([]);
    expect(revoke).toHaveBeenCalledWith('blob:preview');
    await act(async () => result.current.addFiles([file]));
    expect(result.current.attachmentIds).toEqual(['attachment_1']);
    unmount();
  });
});
