import { useState } from 'react';
import type { ImageDraftItem } from './use-image-draft';
import { ImagePreviewDialog } from './ImagePreviewDialog';
import type { Translator } from '../../shared/i18n/i18n';

export interface ImageAttachmentStripProps {
  readonly items: readonly ImageDraftItem[];
  readonly onRemove: (id: string) => void;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
  readonly t: Translator;
}

/** Renders removable image thumbnails and an on-demand full-size preview dialog. */
export function ImageAttachmentStrip({
  items,
  onRemove,
  onOpenImagePreview,
  t,
}: ImageAttachmentStripProps) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = items.find((item) => item.id === previewId) ?? null;
  if (items.length === 0) return null;

  return (
    <div className="attachment-strip" aria-label={t('pendingImages')}>
      {items.map((item) => (
        <div className="attachment-thumbnail" key={item.id}>
          <button
            type="button"
            className="attachment-preview-button"
            aria-label={t('previewImage')}
            onClick={() => {
              void (async () => {
                const opened = (await onOpenImagePreview?.(item.id)) ?? false;
                if (!opened) setPreviewId(item.id);
              })();
            }}
          >
            <img src={item.previewUrl} alt={t('pendingImages')} />
          </button>
          <button
            type="button"
            className="attachment-remove-button"
            aria-label={t('removeImage')}
            onClick={() => onRemove(item.id)}
          >
            ×
          </button>
        </div>
      ))}
      <ImagePreviewDialog
        open={preview !== null}
        src={preview?.previewUrl ?? ''}
        alt={preview?.record.fileName ?? t('imagePreviewDialog')}
        onClose={() => setPreviewId(null)}
        t={t}
      />
    </div>
  );
}
