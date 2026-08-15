import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ObjectUrlRegistry } from '../../../src/attachments/object-url-registry';
import { useImageDraft } from '../../../src/side-panel/chat/use-image-draft';

describe('useImageDraft', () => {
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
    unmount();
  });
});
