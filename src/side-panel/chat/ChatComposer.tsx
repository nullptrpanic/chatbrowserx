import { Camera, ChevronDown, ImagePlus, Send, Square } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelClient } from '../state/panel-client';
import { ImageAttachmentStrip } from './ImageAttachmentStrip';
import { useImageDraft, type AttachmentDraftClient } from './use-image-draft';

export interface ChatComposerProps {
  readonly client: PanelClient;
  readonly attachments: AttachmentDraftClient;
  readonly text: string;
  readonly running: boolean;
  readonly taskLocked: boolean;
  readonly hasToken: boolean;
  readonly hasPagePermission: boolean;
  readonly t: Translator;
  readonly onTextChange: (value: string) => void;
  readonly onOpenSettings: () => void;
}

/** Renders the image/screenshot-aware task composer with send and stop consistency. */
export function ChatComposer({
  client,
  attachments,
  text,
  running,
  taskLocked,
  hasToken,
  hasPagePermission,
  t,
  onTextChange,
  onOpenSettings,
}: ChatComposerProps) {
  const draft = useImageDraft({ client: attachments });
  const fileInput = useRef<HTMLInputElement>(null);
  const [screenshotMenu, setScreenshotMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'send' | 'screenshot' | null>(null);
  const canSend = text.trim().length > 0 || draft.items.length > 0;

  /** Sends the current draft only after authentication and preserves it after any failure. */
  async function submit(): Promise<void> {
    if (!canSend || busy || taskLocked) return;
    if (!hasToken) {
      onOpenSettings();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.submit(text, draft.attachmentIds);
      onTextChange('');
      draft.clear();
    } catch {
      setError('send');
    } finally {
      setBusy(false);
    }
  }

  /** Captures one user-selected screenshot mode and appends its persisted Blob reference. */
  async function capture(mode: 'viewport' | 'region'): Promise<void> {
    setScreenshotMenu(false);
    setBusy(true);
    setError(null);
    try {
      if (!hasPagePermission && !(await client.requestPagePermission())) return;
      const id = await client.captureScreenshot(mode);
      if (id !== null) await draft.addExisting(id);
    } catch {
      setError('screenshot');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="composer" aria-label={t('taskComposer')}>
      <ImageAttachmentStrip items={draft.items} onRemove={draft.remove} t={t} />
      <textarea
        value={text}
        rows={1}
        maxLength={20_000}
        placeholder={t('composerPlaceholder')}
        aria-label={t('composerPlaceholder')}
        onChange={(event) => onTextChange(event.target.value)}
        onPaste={draft.handlePaste}
        onInput={(event) => {
          const element = event.currentTarget;
          element.style.height = 'auto';
          element.style.height = `${String(Math.min(element.scrollHeight, 220))}px`;
        }}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === 'Enter' &&
            !running &&
            !taskLocked
          ) {
            event.preventDefault();
            void submit();
          }
          if (event.key === 'Backspace' && text.length === 0 && draft.items.length > 0) {
            const last = draft.items.at(-1);
            if (last !== undefined) draft.remove(last.id);
          }
        }}
      />
      {draft.error === null && error === null ? null : (
        <p className="composer-error" role="alert">
          {error === 'screenshot'
            ? t('screenshotError')
            : error === 'send'
              ? t('sendError')
              : t('attachmentError')}
        </p>
      )}
      <div className="composer-toolbar">
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          aria-label={t('addImage')}
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = '';
            void draft.addFiles(files, 'file');
          }}
        />
        <button
          type="button"
          className="composer-tool"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus size={16} /> {t('image')}
        </button>
        <div className="screenshot-control">
          <button
            type="button"
            className="composer-tool"
            disabled={busy}
            aria-expanded={screenshotMenu}
            onClick={() => setScreenshotMenu((value) => !value)}
          >
            <Camera size={16} /> {t('screenshot')} <ChevronDown size={13} />
          </button>
          {screenshotMenu ? (
            <div className="screenshot-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void capture('region')}>
                {t('regionScreenshot')}
              </button>
              <button type="button" role="menuitem" onClick={() => void capture('viewport')}>
                {t('viewportScreenshot')}
              </button>
            </div>
          ) : null}
        </div>
        {running ? (
          <button
            type="button"
            className="primary-action is-stop"
            disabled={busy}
            onClick={() => void client.cancelTask()}
          >
            <Square size={13} fill="currentColor" /> {t('stop')}
          </button>
        ) : (
          <button
            type="button"
            className="primary-action"
            disabled={!canSend || busy || taskLocked}
            onClick={() => void submit()}
          >
            <Send size={15} /> {busy ? t('sending') : t('send')}
          </button>
        )}
      </div>
    </section>
  );
}
