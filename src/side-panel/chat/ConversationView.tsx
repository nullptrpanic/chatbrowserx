import { ArrowDown, FileText, ListChecks, Search } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type {
  PanelMessage,
  PanelMessageSourcePage,
  PanelTask,
} from '../../shared/protocol/panel-types';
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
  readonly onOpenSourcePage?: ((source: PanelMessageSourcePage) => Promise<void>) | undefined;
  readonly onLoadTaskDetails?: ((taskId: string) => Promise<void>) | undefined;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
  readonly onClearTaskContext?: ((taskId: string) => Promise<void>) | undefined;
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
  onOpenSourcePage,
  onLoadTaskDetails,
  onPause,
  onResume,
  onRetry,
  onCancel,
  onClearTaskContext,
}: ConversationViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const contentVersion = conversationContentVersion(messages, tasks, task);
  const tasksById = new Map(tasks.map((item) => [item.id, item]));
  const taskHostMessageIds = new Map<string, string>();
  for (const message of messages) {
    const messageTask = tasksById.get(message.taskId) ?? null;
    if (canHostTaskDetails(message, messageTask)) {
      taskHostMessageIds.set(message.taskId, message.id);
    }
  }
  const attachedTaskIds = new Set(taskHostMessageIds.keys());

  useLayoutEffect(() => {
    const element = scroller.current;
    if (following && element !== null) element.scrollTop = element.scrollHeight;
  }, [contentVersion, following]);

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
            if (
              message.role === 'assistant' &&
              taskHostMessageIds.get(message.taskId) !== message.id
            ) {
              return null;
            }
            const messageTask =
              taskHostMessageIds.get(message.taskId) === message.id
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
                onOpenSourcePage={onOpenSourcePage}
                onLoadTaskDetails={onLoadTaskDetails}
                onPause={onPause}
                onResume={onResume}
                onRetry={onRetry}
                onCancel={onCancel}
                onClearTaskContext={onClearTaskContext}
              />
            );
          })}
          {task === null || attachedTaskIds.has(task.id) ? null : (
            <TaskProgressCard
              task={task}
              attachments={attachments}
              t={t}
              onOpenImagePreview={onOpenImagePreview}
              onLoadTaskDetails={onLoadTaskDetails}
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

/** Tracks only visible content changes so identity-only polling cannot disturb scrolling. */
function conversationContentVersion(
  messages: readonly PanelMessage[],
  tasks: readonly PanelTask[],
  activeTask: PanelTask | null,
): string {
  const latestMessage = messages.at(-1);
  const messageVersion =
    latestMessage === undefined
      ? 'empty'
      : [
          messages.length,
          latestMessage.id,
          latestMessage.updatedAt,
          latestMessage.status,
          latestMessage.text.length,
          latestMessage.attachmentIds.length,
        ].join(':');
  const taskVersion = tasks
    .map((item) =>
      [
        item.id,
        item.sequence,
        item.status,
        item.detailLevel,
        item.toolResults.length,
        item.supplements.length,
      ].join(':'),
    )
    .join('|');
  const activeVersion =
    activeTask === null
      ? 'none'
      : `${activeTask.id}:${String(activeTask.sequence)}:${activeTask.status}`;
  return `${messageVersion}#${taskVersion}#${activeVersion}`;
}

/** Prevents an invisible interrupted placeholder from swallowing its task's fallback card. */
function canHostTaskDetails(message: PanelMessage, task: PanelTask | null): boolean {
  return (
    message.role === 'assistant' &&
    !(
      message.status === 'interrupted' &&
      message.text.length === 0 &&
      message.attachmentIds.length === 0 &&
      task?.status !== 'cancelled'
    )
  );
}
