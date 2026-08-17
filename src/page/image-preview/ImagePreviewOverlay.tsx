export interface ImagePreviewOverlayProps {
  readonly src: string;
  readonly alt: string;
  readonly view: Window;
  readonly onClose: () => void;
}

function previewLabels(language: string): { readonly dialog: string; readonly close: string } {
  const normalized = language.toLowerCase();
  if (normalized.startsWith('zh')) return { dialog: '图片预览', close: '关闭预览' };
  if (normalized.startsWith('ja')) return { dialog: '画像プレビュー', close: '閉じる' };
  return { dialog: 'Image preview', close: 'Close preview' };
}

/** Renders one isolated image preview across the complete web-page viewport. */
export function ImagePreviewOverlay({ src, alt, view, onClose }: ImagePreviewOverlayProps) {
  const labels = previewLabels(view.navigator.language);

  return (
    <div className="cbx-image-preview" role="dialog" aria-modal="true" aria-label={labels.dialog}>
      <style>{`
        :host { all: initial; color-scheme: dark; }
        *, *::before, *::after { box-sizing: border-box; }
        .cbx-image-preview { position: fixed; inset: 0; display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0, 1fr); padding: 14px 16px 16px; color: #f6f8fc; background: rgba(5, 8, 14, .82); font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .cbx-image-preview-toolbar { display: flex; justify-content: flex-end; padding-bottom: 10px; }
        .cbx-image-preview-close { min-height: 34px; padding: 0 12px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; color: #f6f8fc; background: #202735; font: inherit; font-weight: 600; cursor: pointer; }
        .cbx-image-preview-close:hover { background: #2b3548; }
        .cbx-image-preview-close:focus-visible { outline: 2px solid #8bb4ff; outline-offset: 2px; }
        .cbx-image-preview-canvas { display: grid; min-width: 0; min-height: 0; place-items: center; overflow: auto; }
        img { display: block; max-width: 100%; max-height: 100%; border-radius: 10px; object-fit: contain; box-shadow: 0 12px 36px rgba(0,0,0,.32); }
      `}</style>
      <div className="cbx-image-preview-toolbar">
        <button autoFocus type="button" className="cbx-image-preview-close" onClick={onClose}>
          {labels.close}
        </button>
      </div>
      <div className="cbx-image-preview-canvas" onClick={onClose}>
        <img src={src} alt={alt} onClick={(event) => event.stopPropagation()} />
      </div>
    </div>
  );
}
