import { ArrowDown, FileText, ListChecks, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelMessage, PanelTask } from '../../shared/protocol/panel-types';
import type { AttachmentDraftClient } from './use-image-draft';
import { MessageItem } from './MessageItem';
import { TaskProgressCard } from '../tasks/TaskProgressCard';

export interface ConversationViewProps {
  readonly messages: readonly PanelMessage[];
  readonly task: PanelTask | null;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onSuggestion: (value: string) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
}

/** Renders conversation messages, embedded durable task state, and stable near-bottom following. */
export function ConversationView({
  messages,
  task,
  attachments,
  t,
  onSuggestion,
  onPause,
  onResume,
  onCancel,
}: ConversationViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const element = scroller.current;
    if (following && element !== null) element.scrollTop = element.scrollHeight;
  }, [following, messages, task?.sequence]);

  const empty = messages.length === 0 && task === null;
  return (
    <div
      className="conversation-scroller"
      ref={scroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 72);
      }}
    >
      {empty ? (
        <section className="conversation-empty">
          <div className="empty-orbit" aria-hidden="true">
            ✦
          </div>
          <h1>{t('emptyTitle')}</h1>
          <p>{t('emptyBody')}</p>
          <div className="suggestion-grid">
            <button type="button" onClick={() => onSuggestion(t('suggestionSummarize'))}>
              <FileText size={16} /> {t('suggestionSummarize')}
            </button>
            <button type="button" onClick={() => onSuggestion(t('suggestionForm'))}>
              <ListChecks size={16} /> {t('suggestionForm')}
            </button>
            <button type="button" onClick={() => onSuggestion(t('suggestionCompare'))}>
              <Search size={16} /> {t('suggestionCompare')}
            </button>
          </div>
        </section>
      ) : (
        <div className="message-list">
          {messages.map((message) => (
            <MessageItem key={message.id} message={message} attachments={attachments} t={t} />
          ))}
          {task === null ? null : (
            <TaskProgressCard
              task={task}
              t={t}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
            />
          )}
        </div>
      )}
      {following ? null : (
        <button
          type="button"
          className="jump-latest"
          onClick={() => {
            const element = scroller.current;
            if (element !== null) element.scrollTop = element.scrollHeight;
            setFollowing(true);
          }}
        >
          <ArrowDown size={14} />
        </button>
      )}
    </div>
  );
}
