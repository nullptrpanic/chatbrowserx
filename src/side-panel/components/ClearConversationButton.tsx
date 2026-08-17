import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import { IconButton } from './IconButton';

export interface ClearConversationButtonProps {
  readonly t: Translator;
  readonly onClear: () => Promise<void>;
}

/** Provides a compact destructive action with an anchored, reversible confirmation step. */
export function ClearConversationButton({ t, onClear }: ClearConversationButtonProps) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="clear-conversation-control">
      <IconButton
        className="clear-conversation-trigger"
        label={t('clearConversation')}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={clearing}
        onClick={() => {
          setFailed(false);
          setOpen((value) => !value);
        }}
      >
        <Trash2 size={16} />
      </IconButton>
      {open ? (
        <section
          className="clear-conversation-popover"
          role="dialog"
          aria-modal="false"
          aria-label={t('clearConversationQuestion')}
        >
          <strong>{t('clearConversationQuestion')}</strong>
          <p>{t('clearConversationWarning')}</p>
          {failed ? (
            <p className="clear-conversation-error" role="alert">
              {t('clearConversationFailed')}
            </p>
          ) : null}
          <div className="clear-conversation-actions">
            <button type="button" disabled={clearing} onClick={() => setOpen(false)}>
              {t('cancelAction')}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={clearing}
              onClick={() => {
                setClearing(true);
                setFailed(false);
                void onClear()
                  .then(() => setOpen(false))
                  .catch(() => setFailed(true))
                  .finally(() => setClearing(false));
              }}
            >
              {t('confirmClearConversation')}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
