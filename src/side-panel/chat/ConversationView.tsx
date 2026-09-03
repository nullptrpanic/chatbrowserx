import { ArrowDown, FileText, ListChecks, Search } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type {
  PanelMessage,
  PanelMessageSourcePage,
  PanelTask,
  PanelTaskRun,
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
  readonly onReply?: ((message: PanelMessage) => void) | undefined;
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
  onReply,
}: ConversationViewProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const contentVersion = conversationContentVersion(messages, tasks, task);
  const tasksById = new Map(tasks.map((item) => [item.id, item]));
  const displayMessages = messagesWithTerminalRunReplies(messages, tasks);
  const runsById = new Map(
    tasks.flatMap((item) => item.runs.map((run) => [taskRunKey(item.id, run.id), run] as const)),
  );
  const answerHostByRun = new Map<string, string>();
  for (const message of displayMessages) {
    const run =
      message.runId === undefined
        ? null
        : (runsById.get(taskRunKey(message.taskId, message.runId)) ?? null);
    if (canHostTaskDetails(message, tasksById.get(message.taskId) ?? null, run)) {
      answerHostByRun.set(messageRunKey(message), message.id);
    }
  }
  const visibleAssistantMessageIds = new Set(answerHostByRun.values());
  const taskHostMessageIds = new Map<string, string>();
  for (const message of displayMessages) {
    const messageTask = tasksById.get(message.taskId) ?? null;
    const belongsToLatestRun =
      messageTask === null ||
      messageTask.latestRunId === null ||
      message.runId === messageTask.latestRunId;
    if (
      belongsToLatestRun &&
      visibleAssistantMessageIds.has(message.id) &&
      canHostTaskDetails(
        message,
        messageTask,
        message.runId === undefined
          ? null
          : (runsById.get(taskRunKey(message.taskId, message.runId)) ?? null),
      )
    ) {
      taskHostMessageIds.set(message.taskId, message.id);
    }
  }
  const attachedTaskIds = new Set(taskHostMessageIds.keys());

  useLayoutEffect(() => {
    const element = scroller.current;
    if (following && element !== null) element.scrollTop = element.scrollHeight;
  }, [contentVersion, following]);

  const empty = displayMessages.length === 0 && task === null;
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
          {displayMessages.map((message) => {
            if (message.role === 'assistant' && !visibleAssistantMessageIds.has(message.id)) {
              return null;
            }
            const messageTask =
              taskHostMessageIds.get(message.taskId) === message.id
                ? (tasksById.get(message.taskId) ?? null)
                : null;
            const messageRun =
              message.runId === undefined
                ? null
                : (runsById.get(taskRunKey(message.taskId, message.runId)) ?? null);
            return (
              <MessageItem
                key={message.id}
                message={message}
                task={messageTask}
                run={messageRun}
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
                onReply={onReply}
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

/** Groups legacy messages by Task and new messages by their permanent execution attempt. */
function messageRunKey(message: PanelMessage): string {
  return taskRunKey(message.taskId, message.runId ?? 'legacy');
}

function taskRunKey(taskId: string, runId: string): string {
  return `${taskId}\u0000${runId}`;
}

/** Derives an empty answer from terminal Run facts when no assistant text was persisted. */
function messagesWithTerminalRunReplies(
  messages: readonly PanelMessage[],
  tasks: readonly PanelTask[],
): readonly PanelMessage[] {
  const assistantRuns = new Set(
    messages.flatMap((message) =>
      message.role === 'assistant' && message.runId !== undefined
        ? [taskRunKey(message.taskId, message.runId)]
        : [],
    ),
  );
  const taskPosition = new Map(tasks.map((task, index) => [task.id, index]));
  const runPosition = new Map(
    tasks.flatMap((task) =>
      task.runs.map((run) => [taskRunKey(task.id, run.id), run.attempt] as const),
    ),
  );
  const derived = tasks.flatMap((task) =>
    task.runs.flatMap((run): PanelMessage[] => {
      if (
        (run.status !== 'failed' && run.status !== 'cancelled') ||
        assistantRuns.has(taskRunKey(task.id, run.id))
      ) {
        return [];
      }
      const at = run.endedAt ?? run.startedAt;
      return [
        {
          id: `terminal-reply:${run.id}`,
          taskId: task.id,
          runId: run.id,
          role: 'assistant',
          status: run.status === 'failed' ? 'error' : 'interrupted',
          text: '',
          attachmentIds: [],
          createdAt: at,
          updatedAt: at,
        },
      ];
    }),
  );
  if (derived.length === 0) return messages;

  return [...messages, ...derived].sort((left, right) => {
    const timeOrder = left.createdAt - right.createdAt;
    if (timeOrder !== 0) return timeOrder;
    const taskOrder =
      (taskPosition.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) -
      (taskPosition.get(right.taskId) ?? Number.MAX_SAFE_INTEGER);
    if (taskOrder !== 0) return taskOrder;
    return (
      (runPosition.get(messageRunKey(left)) ?? Number.MAX_SAFE_INTEGER) -
      (runPosition.get(messageRunKey(right)) ?? Number.MAX_SAFE_INTEGER)
    );
  });
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
        item.runs.map((run) => `${run.id}:${run.status}`).join(','),
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
function canHostTaskDetails(
  message: PanelMessage,
  task: PanelTask | null,
  run: PanelTaskRun | null,
): boolean {
  return (
    message.role === 'assistant' &&
    !(
      message.status === 'interrupted' &&
      message.text.length === 0 &&
      message.attachmentIds.length === 0 &&
      task?.status !== 'cancelled' &&
      run?.status !== 'cancelled' &&
      task?.status !== 'failed' &&
      run?.status !== 'failed'
    )
  );
}
