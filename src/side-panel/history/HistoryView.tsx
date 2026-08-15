import { MessageSquareText, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelConversationSummary } from '../../shared/protocol/panel-types';
import { taskStatusLabel } from '../tasks/TaskStatusLabel';

export interface HistoryViewProps {
  readonly conversations: readonly PanelConversationSummary[];
  readonly activeId: string | null;
  readonly canClearActive: boolean;
  readonly t: Translator;
  readonly onSelect: (id: string) => void;
  readonly onNew: () => void;
  readonly onClear: () => Promise<void>;
}

/** Renders per-tab conversation history as a replacement view rather than a permanent column. */
export function HistoryView({
  conversations,
  activeId,
  canClearActive,
  t,
  onSelect,
  onNew,
  onClear,
}: HistoryViewProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  return (
    <section className="history-view" aria-labelledby="history-title">
      <div className="view-heading">
        <div>
          <span className="eyebrow">ChatBrowserX</span>
          <h1 id="history-title">{t('historyTitle')}</h1>
        </div>
        <button type="button" className="secondary-button" onClick={onNew}>
          <Plus size={15} /> {t('newTask')}
        </button>
      </div>
      {conversations.length === 0 ? (
        <div className="view-empty">
          <MessageSquareText size={24} />
          <p>{t('historyEmpty')}</p>
        </div>
      ) : (
        <div className="history-list">
          {conversations.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              className={`history-item ${conversation.id === activeId ? 'is-active' : ''}`}
              onClick={() => onSelect(conversation.id)}
            >
              <span className="history-item-title">{conversation.title}</span>
              <span className="history-item-meta">
                {new Intl.DateTimeFormat(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(conversation.updatedAt)}
                {conversation.taskStatus === null
                  ? ''
                  : ` · ${taskStatusLabel(conversation.taskStatus, t)}`}
              </span>
            </button>
          ))}
        </div>
      )}
      {activeId === null ? null : (
        <button
          type="button"
          className="clear-conversation-button"
          disabled={!canClearActive}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            void onClear().finally(() => setConfirmClear(false));
          }}
        >
          <Trash2 size={14} /> {confirmClear ? t('clearConfirm') : t('clearConversation')}
        </button>
      )}
    </section>
  );
}
