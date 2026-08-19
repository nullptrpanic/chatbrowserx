import { Check, Copy, ExternalLink, Globe2 } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type {
  PanelMessage,
  PanelMessageSourcePage,
  PanelTask,
} from '../../shared/protocol/panel-types';
import { TaskProgressCard } from '../tasks/TaskProgressCard';
import type { AttachmentDraftClient } from './use-image-draft';
import { copyMessageToClipboard } from './copy-message';
import { MessageImages } from './MessageImages';
import { RestrictedMarkdown } from './RestrictedMarkdown';

export interface MessageItemProps {
  readonly message: PanelMessage;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly task?: PanelTask | null;
  readonly taskInteractive?: boolean;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
  readonly onOpenSourcePage?: ((source: PanelMessageSourcePage) => Promise<void>) | undefined;
  readonly onLoadTaskDetails?: ((taskId: string) => Promise<void>) | undefined;
  readonly onPause?: () => void;
  readonly onResume?: () => void;
  readonly onRetry?: () => void;
  readonly onCancel?: () => void;
}

/** Renders one user, assistant, or system message with safe content and image references. */
export function MessageItem({
  message,
  attachments,
  t,
  task = null,
  taskInteractive = false,
  onOpenImagePreview,
  onOpenSourcePage,
  onLoadTaskDetails,
  onPause = noop,
  onResume = noop,
  onRetry = noop,
  onCancel = noop,
}: MessageItemProps) {
  const [copied, setCopied] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const sourcePage = message.role === 'user' ? message.sourcePage : undefined;
  const displayedText =
    message.text.length > 0
      ? message.text
      : message.role === 'assistant' && message.status === 'error'
        ? t('failedResponse')
        : message.role === 'assistant' &&
            message.status === 'interrupted' &&
            task?.status === 'cancelled'
          ? t('cancelledResponse')
          : '';
  if (
    message.role === 'assistant' &&
    message.status === 'interrupted' &&
    message.text.length === 0 &&
    message.attachmentIds.length === 0 &&
    task?.status !== 'cancelled'
  ) {
    return null;
  }
  return (
    <article
      className={`message-item message-${message.role} is-${message.status} ${task === null ? '' : 'has-task-details'} ${sourcePage === undefined ? '' : 'has-source-page'}`}
    >
      <div className="message-bubble">
        <header className="message-meta">
          <span>{message.role === 'user' ? t('userMessage') : t('assistantMessage')}</span>
          {sourcePage === undefined ? null : (
            <button
              type="button"
              className="message-source-page"
              aria-label={t('openSourcePage', { title: sourcePage.title })}
              title={`${sourcePage.title}\n${sourcePage.url}`}
              onClick={() => void onOpenSourcePage?.(sourcePage).catch(noop)}
            >
              <span className="message-source-icon" aria-hidden="true">
                {sourcePage.favIconUrl === null || faviconFailed ? (
                  <Globe2 size={12} />
                ) : (
                  <img src={sourcePage.favIconUrl} alt="" onError={() => setFaviconFailed(true)} />
                )}
              </span>
              <span className="message-source-title">{sourcePage.title}</span>
              <ExternalLink className="message-source-external" size={11} aria-hidden="true" />
            </button>
          )}
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
              message.createdAt,
            )}
          </time>
        </header>
        <MessageImages
          attachmentIds={message.attachmentIds}
          client={attachments}
          t={t}
          onOpenImagePreview={onOpenImagePreview}
        />
        {displayedText.length === 0 && message.status === 'streaming' ? null : (
          <RestrictedMarkdown text={displayedText} />
        )}
        {message.status === 'streaming' ? (
          <span className="streaming-label" role="status">
            <span className="typing-dots" aria-hidden="true">
              <i /> <i /> <i />
            </span>
            {t('streaming')}
          </span>
        ) : null}
        {message.status === 'interrupted' && task?.status !== 'cancelled' ? (
          <p className="interrupted-label">{t('interrupted')}</p>
        ) : null}
        {displayedText.length > 0 || message.attachmentIds.length > 0 ? (
          <div className="message-actions">
            <button
              type="button"
              onClick={() => {
                void copyMessageToClipboard({
                  text: displayedText,
                  attachmentIds: message.attachmentIds,
                  client: attachments,
                })
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1_500);
                  })
                  .catch(noop);
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? t('copied') : t('copy')}
            </button>
          </div>
        ) : null}
        {task === null ? null : (
          <TaskProgressCard
            task={task}
            attachments={attachments}
            t={t}
            embedded
            interactive={taskInteractive}
            onOpenImagePreview={onOpenImagePreview}
            onLoadTaskDetails={onLoadTaskDetails}
            onPause={onPause}
            onResume={onResume}
            onRetry={onRetry}
            onCancel={onCancel}
          />
        )}
      </div>
    </article>
  );
}

function noop(): void {}
