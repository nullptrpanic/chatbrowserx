import { ArrowDown, FileText, ListChecks, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelMessage, PanelTask } from '../../shared/protocol/panel-types';
import type { AttachmentDraftClient } from './use-image-draft';
import { MessageItem } from './MessageItem';
import { TaskProgressCard } from '../tasks/TaskProgressCard';

export interface ConversationViewProps {
  readonly messages: readonly PanelMessage[];
  readonly tasks: readonly PanelTask[];
  readonly task: PanelTask | null;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onSuggestion: (value: string) => void;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}

/** Renders conversation messages, embedded durable task state, and stable near-bottom following. */
export function ConversationView({
  messages,
  tasks,
  task,
  attachments,
  t,
  onSuggestion,
  onOpenImagePreview,
  onPause,
  onResume,
  onRetry,
  onCancel,
}: ConversationViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const tasksById = new Map(tasks.map((item) => [item.id, item]));
  const taskHostMessageIds = new Map<string, string>();
  for (const message of messages) {
    if (canHostTaskDetails(message) && message.taskId !== null) {
      taskHostMessageIds.set(message.taskId, message.id);
    }
  }
  const attachedTaskIds = new Set(taskHostMessageIds.keys());

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
          {messages.map((message) => {
            const messageTask =
              message.taskId !== null && taskHostMessageIds.get(message.taskId) === message.id
                ? (tasksById.get(message.taskId) ?? null)
                : null;
            return (
              <MessageItem
                key={message.id}
                message={message}
                task={messageTask}
                taskInteractive={messageTask?.id === task?.id}
                attachments={attachments}
                t={t}
                onOpenImagePreview={onOpenImagePreview}
                onPause={onPause}
                onResume={onResume}
                onRetry={onRetry}
                onCancel={onCancel}
              />
            );
          })}
          {task === null || attachedTaskIds.has(task.id) ? null : (
            <TaskProgressCard
              task={task}
              t={t}
              onPause={onPause}
              onResume={onResume}
              onRetry={onRetry}
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

/** Prevents an invisible failed placeholder from swallowing its task's fallback card. */
function canHostTaskDetails(message: PanelMessage): boolean {
  return (
    message.role === 'assistant' &&
    !(
      (message.status === 'error' || message.status === 'interrupted') &&
      message.text.length === 0 &&
      message.attachmentIds.length === 0
    )
  );
}
