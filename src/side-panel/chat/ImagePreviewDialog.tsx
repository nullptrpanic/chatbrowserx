import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Translator } from '../../shared/i18n/i18n';

export interface ImagePreviewDialogProps {
  readonly open: boolean;
  readonly src: string;
  readonly alt: string;
  readonly onClose: () => void;
  readonly t: Translator;
}

/** Renders an accessible modal image preview and restores focus to its invoking control. */
export function ImagePreviewDialog({ open, src, alt, onClose, t }: ImagePreviewDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    invokerRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    /** Closes the modal through the standard Escape keyboard gesture. */
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      invokerRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div className="image-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('imagePreviewDialog')}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button ref={closeRef} type="button" className="image-preview-close" onClick={onClose}>
          {t('closePreview')}
        </button>
        <img src={src} alt={alt} />
      </div>
    </div>,
    document.body,
  );
}
