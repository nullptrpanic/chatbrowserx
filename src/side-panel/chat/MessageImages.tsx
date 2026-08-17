import { useEffect, useState } from 'react';
import type { AttachmentDraftClient } from './use-image-draft';
import { ImagePreviewDialog } from './ImagePreviewDialog';
import type { Translator } from '../../shared/i18n/i18n';

interface LoadedImage {
  readonly id: string;
  readonly url: string;
  readonly alt: string;
}

export interface MessageImagesProps {
  readonly attachmentIds: readonly string[];
  readonly client: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
}

/** Loads message image Blobs by reference and owns their short-lived object URLs. */
export function MessageImages({
  attachmentIds,
  client,
  t,
  onOpenImagePreview,
}: MessageImagesProps) {
  const [images, setImages] = useState<readonly LoadedImage[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const attachmentKey = attachmentIds.join('\u001f');

  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    const stableIds = attachmentKey.length === 0 ? [] : attachmentKey.split('\u001f');
    void Promise.all(stableIds.map((id) => client.get(id))).then((records) => {
      if (!active) return;
      const loaded = records.flatMap((record) => {
        if (record === undefined) return [];
        const url = URL.createObjectURL(record.blob);
        urls.push(url);
        return [{ id: record.id, url, alt: record.fileName ?? t('imageAttachment') }];
      });
      setImages(loaded);
    });
    return () => {
      active = false;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [attachmentKey, client, t]);

  const preview = images.find((image) => image.id === previewId) ?? null;
  if (attachmentIds.length === 0) return null;
  return (
    <div className="message-images">
      {images.map((image) => (
        <button
          type="button"
          key={image.id}
          className="message-image-button"
          onClick={() => {
            void (async () => {
              const opened = (await onOpenImagePreview?.(image.id)) ?? false;
              if (!opened) setPreviewId(image.id);
            })();
          }}
        >
          <img src={image.url} alt={image.alt} />
        </button>
      ))}
      <ImagePreviewDialog
        open={preview !== null}
        src={preview?.url ?? ''}
        alt={preview?.alt ?? t('imagePreviewDialog')}
        onClose={() => setPreviewId(null)}
        t={t}
      />
    </div>
  );
}
