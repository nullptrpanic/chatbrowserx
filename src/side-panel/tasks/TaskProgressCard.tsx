import { ChevronDown, ChevronUp, CircleStop, Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type {
  PanelToolResult,
  PanelTask,
  PanelTaskSupplement,
} from '../../shared/protocol/panel-types';
import type { AttachmentDraftClient } from '../chat/use-image-draft';
import { isTerminalToolName, TerminalToolResult } from './TerminalToolResult';
import { TaskStatusLabel, taskEventLabel, taskStatusLabel } from './TaskStatusLabel';
import { TaskSupplement } from './TaskSupplement';
import { ToolResult } from './ToolResult';
import { toolResultEventLabel } from './browser-tool-label';

const runningStatuses = new Set<PanelTask['status']>(['queued', 'planning']);
const resumableStatuses = new Set<PanelTask['status']>(['paused', 'waiting_for_auth']);

export interface TaskProgressCardProps {
  readonly task: PanelTask;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
  readonly onLoadTaskDetails?: ((taskId: string) => Promise<void>) | undefined;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
  readonly embedded?: boolean;
  readonly interactive?: boolean;
}

/** Renders durable progress with completed tools, user supplements, and recovery controls. */
export function TaskProgressCard({
  task,
  attachments,
  t,
  onOpenImagePreview,
  onLoadTaskDetails,
  onPause,
  onResume,
  onRetry,
  onCancel,
  embedded = false,
  interactive = true,
}: TaskProgressCardProps) {
  const [expanded, setExpanded] = useState(false);
  const requestedDetailKey = useRef<string | null>(null);
  const latestEvent = task.detailLevel === 'full' ? undefined : task.events.at(-1);
  const detailItemCount = taskDetailItemCount(task);

  useEffect(() => {
    if (!expanded || task.detailLevel === 'full' || onLoadTaskDetails === undefined) return;
    const detailKey = `${task.id}:${String(task.sequence)}`;
    if (requestedDetailKey.current === detailKey) return;
    requestedDetailKey.current = detailKey;
    void onLoadTaskDetails(task.id).catch(() => {
      if (requestedDetailKey.current === detailKey) requestedDetailKey.current = null;
    });
  }, [expanded, onLoadTaskDetails, task.detailLevel, task.id, task.sequence]);

  if (embedded) {
    const summaryMeta = t('taskSummaryMeta', {
      toolCalls: detailItemCount,
      duration: formatTaskDuration(task),
    });
    return (
      <section className="task-card is-embedded" aria-label={taskStatusLabelForAria(task, t)}>
        <button
          type="button"
          className="task-summary-toggle"
          aria-expanded={expanded}
          aria-label={`${taskStatusLabel(task.status, t)} ${summaryMeta}`}
          onClick={() => setExpanded((value) => !value)}
        >
          <TaskStatusLabel status={task.status} t={t} />
          <span className="task-summary-meta">{summaryMeta}</span>
          {expanded ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
        </button>
        {task.lastError === null ? null : (
          <p className="task-error" role="alert">
            {task.lastError.userMessage}
          </p>
        )}
        {expanded ? (
          <TaskDetailContent
            task={task}
            attachments={attachments}
            t={t}
            onOpenImagePreview={onOpenImagePreview}
          />
        ) : null}
        <TaskControls
          task={task}
          t={t}
          interactive={interactive}
          onPause={onPause}
          onResume={onResume}
          onRetry={onRetry}
          onCancel={onCancel}
        />
      </section>
    );
  }

  return (
    <section className="task-card" aria-label={taskStatusLabelForAria(task, t)}>
      <div className="task-card-header">
        <TaskStatusLabel status={task.status} t={t} />
        <span className="task-updated">
          {new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          }).format(task.updatedAt)}
        </span>
      </div>
      <p className="task-current-step">
        {task.detailLevel === 'full'
          ? taskStatusLabel(task.status, t)
          : latestEvent === undefined
            ? task.goal
            : taskEventLabel(latestEvent.type, t)}
      </p>
      <div className="task-progress-row">
        <button
          type="button"
          className="task-details-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? t('hideTaskDetails') : t('taskDetails')}({detailItemCount})
        </button>
      </div>
      {task.lastError === null ? null : (
        <p className="task-error" role="alert">
          {task.lastError.userMessage}
        </p>
      )}
      {expanded ? (
        <TaskDetailContent
          task={task}
          attachments={attachments}
          t={t}
          onOpenImagePreview={onOpenImagePreview}
        />
      ) : null}
      <TaskControls
        task={task}
        t={t}
        interactive={interactive}
        onPause={onPause}
        onResume={onResume}
        onRetry={onRetry}
        onCancel={onCancel}
      />
    </section>
  );
}

function TaskDetailContent({
  task,
  attachments,
  t,
  onOpenImagePreview,
}: {
  readonly task: PanelTask;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
}) {
  const detailItems = taskDetailItems(task);
  return (
    <div className="task-detail-content">
      {task.toolResults.length === 0 && task.supplements.length === 0 ? (
        <p className="task-detail-empty">{t('noEvents')}</p>
      ) : null}
      {task.toolResults.length === 0 && task.supplements.length === 0 ? null : (
        <ol className="task-event-list">
          {detailItems.map((item) =>
            item.type === 'tool' ? (
              <CompletedToolEvent
                key={item.result.callId}
                result={item.result}
                number={item.result.detailIndex}
                at={item.at}
                attachments={attachments}
                t={t}
                onOpenImagePreview={onOpenImagePreview}
              />
            ) : (
              <li className="task-supplement-entry" key={item.supplement.id}>
                <span className="task-event-index">{item.supplement.detailIndex}</span>
                <TaskSupplement
                  supplement={item.supplement}
                  applicationState={item.supplement.applicationState}
                  attachments={attachments}
                  t={t}
                  onOpenImagePreview={onOpenImagePreview}
                />
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}

function CompletedToolEvent({
  result,
  number,
  at,
  attachments,
  t,
  onOpenImagePreview,
}: {
  readonly result: PanelToolResult;
  readonly number: number;
  readonly at?: number | undefined;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
}) {
  return (
    <li>
      <span className="task-event-index">{number}</span>
      <span>{toolResultEventLabel(result.toolName, t)}</span>
      {at === undefined ? (
        <span />
      ) : (
        <time dateTime={new Date(at).toISOString()}>
          {new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(at)}
        </time>
      )}
      <div className="task-event-tool-results">
        <RenderedToolResult
          result={result}
          attachments={attachments}
          t={t}
          onOpenImagePreview={onOpenImagePreview}
        />
      </div>
    </li>
  );
}

type TaskDetailItem =
  | {
      readonly type: 'tool';
      readonly result: PanelToolResult;
      readonly at: number | undefined;
    }
  | { readonly type: 'supplement'; readonly supplement: PanelTaskSupplement };

/** Merges permanent detail projections by their TaskEvent-derived display index. */
function taskDetailItems(task: PanelTask): readonly TaskDetailItem[] {
  const resultTimeById = new Map(
    task.events.flatMap((event) =>
      event.type === 'tool.result-recorded' && event.resultId !== undefined
        ? ([[event.resultId, event.at]] as const)
        : [],
    ),
  );
  return [
    ...task.toolResults.map((result): TaskDetailItem => ({
      type: 'tool',
      result,
      at: resultTimeById.get(result.resultId),
    })),
    ...task.supplements.map((supplement): TaskDetailItem => ({
      type: 'supplement',
      supplement,
    })),
  ].sort((left, right) => detailIndex(left) - detailIndex(right));
}

function detailIndex(item: TaskDetailItem): number {
  return item.type === 'tool' ? item.result.detailIndex : item.supplement.detailIndex;
}

function RenderedToolResult({
  result,
  attachments,
  t,
  onOpenImagePreview,
}: {
  readonly result: PanelToolResult;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
}) {
  return isTerminalToolName(result.toolName) ? (
    <TerminalToolResult result={result} t={t} />
  ) : (
    <ToolResult
      result={result}
      attachments={attachments}
      t={t}
      onOpenImagePreview={onOpenImagePreview}
    />
  );
}

interface TaskControlsProps {
  readonly task: PanelTask;
  readonly t: Translator;
  readonly interactive: boolean;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
}

function TaskControls({
  task,
  t,
  interactive,
  onPause,
  onResume,
  onRetry,
  onCancel,
}: TaskControlsProps) {
  if (['completed', 'cancelled'].includes(task.status) || !interactive) return null;
  return (
    <div className="task-controls">
      {runningStatuses.has(task.status) ? (
        <button type="button" className="secondary-button" onClick={onPause}>
          <Pause size={14} /> {t('pause')}
        </button>
      ) : null}
      {resumableStatuses.has(task.status) ? (
        <button type="button" className="secondary-button" onClick={onResume}>
          <Play size={14} /> {t('continue')}
        </button>
      ) : null}
      {task.status === 'failed' ? (
        <button type="button" className="secondary-button" onClick={onRetry}>
          <RotateCcw size={14} /> {t('retry')}
        </button>
      ) : (
        <button type="button" className="text-danger-button" onClick={onCancel}>
          <CircleStop size={14} /> {t('cancel')}
        </button>
      )}
    </div>
  );
}

/** Formats task elapsed time with a single useful decimal and no trailing zero. */
function formatTaskDuration(task: PanelTask): string {
  const durationMilliseconds = Math.max(0, task.updatedAt - task.createdAt);
  return String(Math.round(durationMilliseconds / 100) / 10);
}

/** Reads the exact server-projected total of user-visible detail items. */
function taskDetailItemCount(task: PanelTask): number {
  return task.detailItemCount;
}

/** Creates a concise accessible label for the complete task progress card. */
function taskStatusLabelForAria(task: PanelTask, t: Translator): string {
  return `${task.goal}: ${taskStatusLabel(task.status, t)}`;
}
