import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelMessage } from '../../shared/protocol/panel-types';
import type { AttachmentDraftClient } from './use-image-draft';
import { MessageImages } from './MessageImages';
import { RestrictedMarkdown } from './RestrictedMarkdown';

export interface MessageItemProps {
  readonly message: PanelMessage;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
}

/** Renders one user, assistant, or system message with safe content and image references. */
export function MessageItem({ message, attachments, t }: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  return (
    <article className={`message-item message-${message.role} is-${message.status}`}>
      <header className="message-meta">
        <span>{message.role === 'user' ? t('userMessage') : t('assistantMessage')}</span>
        <time dateTime={new Date(message.createdAt).toISOString()}>
          {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
            message.createdAt,
          )}
        </time>
      </header>
      <MessageImages attachmentIds={message.attachmentIds} client={attachments} t={t} />
      {message.text.length === 0 && message.status === 'streaming' ? null : (
        <RestrictedMarkdown text={message.text} />
      )}
      {message.status === 'streaming' ? (
        <span className="streaming-label" role="status">
          <span className="typing-dots" aria-hidden="true">
            <i /> <i /> <i />
          </span>
          {t('streaming')}
        </span>
      ) : null}
      {message.status === 'interrupted' ? (
        <p className="interrupted-label">{t('interrupted')}</p>
      ) : null}
      {message.role === 'assistant' && message.text.length > 0 ? (
        <div className="message-actions">
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(message.text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1_500);
              });
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t('copied') : t('copy')}
          </button>
        </div>
      ) : null}
    </article>
  );
}
