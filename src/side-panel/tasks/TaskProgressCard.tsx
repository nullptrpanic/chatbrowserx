import { ChevronDown, ChevronUp, CircleStop, Pause, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelCompletedToolResult, PanelTask } from '../../shared/protocol/panel-types';
import { MessageImages } from '../chat/MessageImages';
import type { AttachmentDraftClient } from '../chat/use-image-draft';
import { isTerminalToolName, TerminalToolResult } from './TerminalToolResult';
import { ReasoningSummary } from './ReasoningSummary';
import { TaskStatusLabel, taskEventLabel, taskStatusLabel } from './TaskStatusLabel';
import { ToolResult } from './ToolResult';

const runningStatuses = new Set<PanelTask['status']>(['queued', 'planning']);
const resumableStatuses = new Set<PanelTask['status']>(['paused', 'waiting_for_auth']);

export interface TaskProgressCardProps {
  readonly task: PanelTask;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
  readonly embedded?: boolean;
  readonly interactive?: boolean;
}

/** Renders compact durable progress with expandable audit events and recovery controls. */
export function TaskProgressCard({
  task,
  attachments,
  t,
  onOpenImagePreview,
  onPause,
  onResume,
  onRetry,
  onCancel,
  embedded = false,
  interactive = true,
}: TaskProgressCardProps) {
  const [expanded, setExpanded] = useState(false);
  const latestEvent = task.events.at(-1);

  if (embedded) {
    const summaryMeta = t('taskSummaryMeta', {
      steps: task.sequence,
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
          {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
            task.updatedAt,
          )}
        </span>
      </div>
      <p className="task-current-step">
        {latestEvent === undefined ? task.goal : taskEventLabel(latestEvent.type, t)}
      </p>
      <div className="task-progress-row">
        <button
          type="button"
          className="task-details-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? t('hideTaskDetails') : t('taskDetails')}
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
  const toolResultsByEvent = groupToolResultsByEvent(task);
  return (
    <div className="task-detail-content">
      {task.events.length === 0 &&
      task.completedToolResults.length === 0 &&
      task.supplements.length === 0 ? (
        <p className="task-detail-empty">{t('noEvents')}</p>
      ) : null}
      {task.events.length === 0 ? null : (
        <ol className="task-event-list">
          {task.events.map((event, eventIndex) => {
            const toolResults = toolResultsByEvent.get(eventIndex) ?? [];
            return (
              <li key={`${event.sequence}:${event.type}`}>
                <span className="task-event-index">{event.sequence}</span>
                <span>{taskEventLabel(event.type, t)}</span>
                <time dateTime={new Date(event.at).toISOString()}>
                  {new Intl.DateTimeFormat(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }).format(event.at)}
                </time>
                {toolResults.length === 0 ? null : (
                  <div className="task-event-tool-results">
                    {toolResults.map((result) => (
                      <CompletedToolResult key={result.callId} result={result} t={t} />
                    ))}
                  </div>
                )}
                {event.reasoningSummary === undefined ? null : (
                  <ReasoningSummary summary={event.reasoningSummary} t={t} />
                )}
              </li>
            );
          })}
        </ol>
      )}
      {task.events.length !== 0 || task.completedToolResults.length === 0 ? null : (
        <div className="task-event-tool-results">
          {task.completedToolResults.map((result) => (
            <CompletedToolResult key={result.callId} result={result} t={t} />
          ))}
        </div>
      )}
      {task.supplements.length === 0 ? null : (
        <ol className="task-supplement-list">
          {task.supplements.map((supplement) => (
            <li key={supplement.id} className="task-supplement-item">
              <header>
                <span>{t('userSupplement')}</span>
                <time dateTime={new Date(supplement.createdAt).toISOString()}>
                  {new Intl.DateTimeFormat(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }).format(supplement.createdAt)}
                </time>
              </header>
              {supplement.text.length === 0 ? null : (
                <p className="task-supplement-text">{supplement.text}</p>
              )}
              <MessageImages
                attachmentIds={supplement.attachmentIds}
                client={attachments}
                t={t}
                onOpenImagePreview={onOpenImagePreview}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CompletedToolResult({
  result,
  t,
}: {
  readonly result: PanelCompletedToolResult;
  readonly t: Translator;
}) {
  return isTerminalToolName(result.toolName) ? (
    <TerminalToolResult result={result} t={t} />
  ) : (
    <ToolResult result={result} t={t} />
  );
}

/** Associates retained result tails with the matching retained tool events in chronological order. */
function groupToolResultsByEvent(
  task: PanelTask,
): ReadonlyMap<number, readonly PanelCompletedToolResult[]> {
  const grouped = new Map<number, PanelCompletedToolResult[]>();
  if (task.events.length === 0 || task.completedToolResults.length === 0) return grouped;

  const resultEventIndexes = task.events.flatMap((event, index) =>
    event.type === 'tool.result-recorded' ? [index] : [],
  );
  const pairedCount = Math.min(resultEventIndexes.length, task.completedToolResults.length);
  const firstPairedEvent = resultEventIndexes.length - pairedCount;
  const firstPairedResult = task.completedToolResults.length - pairedCount;
  const fallbackEvent = task.events.length - 1;
  const appendResult = (eventIndex: number, result: PanelCompletedToolResult) => {
    const existing = grouped.get(eventIndex);
    if (existing === undefined) {
      grouped.set(eventIndex, [result]);
      return;
    }
    existing.push(result);
  };

  for (let resultIndex = 0; resultIndex < firstPairedResult; resultIndex += 1) {
    const result = task.completedToolResults[resultIndex];
    if (result !== undefined) appendResult(fallbackEvent, result);
  }
  for (let pairIndex = 0; pairIndex < pairedCount; pairIndex += 1) {
    const eventIndex = resultEventIndexes[firstPairedEvent + pairIndex];
    const result = task.completedToolResults[firstPairedResult + pairIndex];
    if (eventIndex !== undefined && result !== undefined) appendResult(eventIndex, result);
  }

  return grouped;
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

/** Creates a concise accessible label for the complete task progress card. */
function taskStatusLabelForAria(task: PanelTask, t: Translator): string {
  return `${task.goal}: ${taskStatusLabel(task.status, t)}`;
}
