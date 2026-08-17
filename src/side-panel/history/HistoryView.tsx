import { MessageSquareText, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelConversationSummary } from '../../shared/protocol/panel-types';
import { taskStatusLabel } from '../tasks/TaskStatusLabel';

export interface HistoryViewProps {
  readonly conversations: readonly PanelConversationSummary[];
  readonly activeId: string | null;
  readonly t: Translator;
  readonly onSelect: (id: string) => void;
  readonly onNew: () => void;
  readonly onClear: () => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}

/** Renders browser-wide conversation history as a replacement view rather than a permanent column. */
export function HistoryView({
  conversations,
  activeId,
  t,
  onSelect,
  onNew,
  onClear,
  onDelete,
}: HistoryViewProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  return (
    <section className="history-view" aria-labelledby="history-title">
      <div className="view-heading">
        <div>
          <span className="eyebrow">{t('allTabs')}</span>
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
          {conversations.map((conversation) => {
            const confirming = confirmDeleteId === conversation.id;
            return (
              <div className="history-row" key={conversation.id}>
                <button
                  type="button"
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
                <button
                  type="button"
                  className={`history-delete ${confirming ? 'is-confirming' : ''}`}
                  aria-label={`${t(confirming ? 'deleteConfirm' : 'deleteConversation')}：${conversation.title}`}
                  title={t(confirming ? 'deleteConfirm' : 'deleteConversation')}
                  onClick={() => {
                    if (!confirming) {
                      setActionFailed(false);
                      setConfirmDeleteId(conversation.id);
                      return;
                    }
                    void onDelete(conversation.id)
                      .then(() => setConfirmDeleteId(null))
                      .catch(() => setActionFailed(true));
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {actionFailed ? (
        <p className="history-action-error" role="alert">
          {t('historyActionFailed')}
        </p>
      ) : null}
      {activeId === null ? null : (
        <button
          type="button"
          className="clear-conversation-button"
          onClick={() => {
            if (!confirmClear) {
              setActionFailed(false);
              setConfirmClear(true);
              return;
            }
            void onClear()
              .then(() => setConfirmClear(false))
              .catch(() => setActionFailed(true));
          }}
        >
          <Trash2 size={14} /> {confirmClear ? t('clearConfirm') : t('clearConversation')}
        </button>
      )}
    </section>
  );
}
