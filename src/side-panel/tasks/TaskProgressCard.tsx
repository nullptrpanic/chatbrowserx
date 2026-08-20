import { ChevronDown, ChevronUp, CircleStop, Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type {
  PanelCompletedToolResult,
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
          {new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
            task.updatedAt,
          )}
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
  const toolResultGroups = groupToolResultsByEvent(task);
  const supplementsByEvent = groupSupplementsByEvent(task);
  const detailNumbers = taskDetailNumbers(task, toolResultGroups, supplementsByEvent);
  return (
    <div className="task-detail-content">
      {task.completedToolResults.length === 0 && task.supplements.length === 0 ? (
        <p className="task-detail-empty">{t('noEvents')}</p>
      ) : null}
      {task.completedToolResults.length === 0 && task.supplements.length === 0 ? null : (
        <ol className="task-event-list">
          {toolResultGroups.unmatched.map((result) => (
            <CompletedToolEvent
              key={result.callId}
              result={result}
              number={detailNumbers.results.get(result.callId) ?? 1}
              attachments={attachments}
              t={t}
              onOpenImagePreview={onOpenImagePreview}
            />
          ))}
          {task.events.map((event, eventIndex) => {
            const toolResults = toolResultGroups.grouped.get(eventIndex) ?? [];
            const supplements = supplementsByEvent.grouped.get(eventIndex) ?? [];
            return [
              ...toolResults.map((result) => (
                <CompletedToolEvent
                  key={result.callId}
                  result={result}
                  number={detailNumbers.results.get(result.callId) ?? 1}
                  at={event.at}
                  attachments={attachments}
                  t={t}
                  onOpenImagePreview={onOpenImagePreview}
                />
              )),
              ...supplements.map((supplement) => (
                <li className="task-supplement-entry" key={supplement.id}>
                  <span className="task-event-index">
                    {detailNumbers.supplements.get(supplement.id) ?? 1}
                  </span>
                  <TaskSupplement
                    supplement={supplement}
                    applicationState={supplement.applicationState ?? 'applied'}
                    attachments={attachments}
                    t={t}
                    onOpenImagePreview={onOpenImagePreview}
                  />
                </li>
              )),
            ];
          })}
          {supplementsByEvent.unmatched.map((supplement) => (
            <li className="task-supplement-entry" key={supplement.id}>
              <span className="task-event-index">
                {detailNumbers.supplements.get(supplement.id) ?? 1}
              </span>
              <TaskSupplement
                supplement={supplement}
                applicationState={supplement.applicationState ?? 'pending'}
                attachments={attachments}
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

function CompletedToolEvent({
  result,
  number,
  at,
  attachments,
  t,
  onOpenImagePreview,
}: {
  readonly result: PanelCompletedToolResult;
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
        <CompletedToolResult
          result={result}
          attachments={attachments}
          t={t}
          onOpenImagePreview={onOpenImagePreview}
        />
      </div>
    </li>
  );
}

interface GroupedSupplements {
  readonly grouped: ReadonlyMap<number, readonly PanelTaskSupplement[]>;
  readonly unmatched: readonly PanelTaskSupplement[];
}

/** Uses persisted IDs for exact grouping and timestamps only for legacy supplement events. */
function groupSupplementsByEvent(task: PanelTask): GroupedSupplements {
  const grouped = new Map<number, PanelTaskSupplement[]>();
  const supplementsById = new Map(
    task.supplements.map((supplement) => [supplement.id, supplement]),
  );
  const assigned = new Set<string>();

  for (const [eventIndex, event] of task.events.entries()) {
    if (event.type !== 'task.supplements-applied') continue;
    const supplements =
      event.supplementIds === undefined
        ? task.supplements.filter(
            (supplement) => !assigned.has(supplement.id) && supplement.createdAt <= event.at,
          )
        : event.supplementIds.flatMap((id) => {
            const supplement = supplementsById.get(id);
            return supplement === undefined || assigned.has(id) ? [] : [supplement];
          });
    if (supplements.length === 0) continue;
    supplements.forEach(({ id }) => assigned.add(id));
    grouped.set(eventIndex, supplements);
  }

  return {
    grouped,
    unmatched: task.supplements.filter(({ id }) => !assigned.has(id)),
  };
}

interface TaskDetailNumbers {
  readonly results: ReadonlyMap<string, number>;
  readonly supplements: ReadonlyMap<string, number>;
}

/** Uses server-projected positions and derives deterministic positions for legacy snapshots. */
function taskDetailNumbers(
  task: PanelTask,
  toolResults: GroupedToolResults,
  supplements: GroupedSupplements,
): TaskDetailNumbers {
  const ordered = [
    ...toolResults.unmatched.map((result) => ({ type: 'result' as const, value: result })),
    ...task.events.flatMap((_, eventIndex) => [
      ...(toolResults.grouped.get(eventIndex) ?? []).map((result) => ({
        type: 'result' as const,
        value: result,
      })),
      ...(supplements.grouped.get(eventIndex) ?? []).map((supplement) => ({
        type: 'supplement' as const,
        value: supplement,
      })),
    ]),
    ...supplements.unmatched.map((supplement) => ({
      type: 'supplement' as const,
      value: supplement,
    })),
  ];
  const results = new Map<string, number>();
  const supplementNumbers = new Map<string, number>();
  let nextNumber = Math.max(1, taskDetailItemCount(task) - ordered.length + 1);

  for (const item of ordered) {
    const projected = item.value.detailIndex;
    const number = projected ?? nextNumber;
    nextNumber = Math.max(nextNumber + 1, number + 1);
    if (item.type === 'result') results.set(item.value.callId, number);
    else supplementNumbers.set(item.value.id, number);
  }
  return { results, supplements: supplementNumbers };
}

function CompletedToolResult({
  result,
  attachments,
  t,
  onOpenImagePreview,
}: {
  readonly result: PanelCompletedToolResult;
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

interface GroupedToolResults {
  readonly grouped: ReadonlyMap<number, readonly PanelCompletedToolResult[]>;
  readonly unmatched: readonly PanelCompletedToolResult[];
}

/** Associates retained result tails with matching retained tool events in chronological order. */
function groupToolResultsByEvent(task: PanelTask): GroupedToolResults {
  const grouped = new Map<number, PanelCompletedToolResult[]>();
  if (task.events.length === 0 || task.completedToolResults.length === 0) {
    return { grouped, unmatched: task.completedToolResults };
  }

  const resultEventIndexes = task.events.flatMap((event, index) =>
    event.type === 'tool.result-recorded' ? [index] : [],
  );
  const pairedCount = Math.min(resultEventIndexes.length, task.completedToolResults.length);
  const firstPairedEvent = resultEventIndexes.length - pairedCount;
  const firstPairedResult = task.completedToolResults.length - pairedCount;
  const appendResult = (eventIndex: number, result: PanelCompletedToolResult) => {
    const existing = grouped.get(eventIndex);
    if (existing === undefined) {
      grouped.set(eventIndex, [result]);
      return;
    }
    existing.push(result);
  };

  for (let pairIndex = 0; pairIndex < pairedCount; pairIndex += 1) {
    const eventIndex = resultEventIndexes[firstPairedEvent + pairIndex];
    const result = task.completedToolResults[firstPairedResult + pairIndex];
    if (eventIndex !== undefined && result !== undefined) appendResult(eventIndex, result);
  }

  return {
    grouped,
    unmatched: task.completedToolResults.slice(0, firstPairedResult),
  };
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

/** Uses the exact server total while retaining compatibility with an older live panel snapshot. */
function taskToolCallCount(task: PanelTask): number {
  return (
    task.completedToolCallCount ??
    Math.max(
      task.completedToolResults.length,
      task.events.filter((event) => event.type === 'tool.result-recorded').length,
    )
  );
}

/** Counts every user-visible detail while retaining older snapshot compatibility. */
function taskDetailItemCount(task: PanelTask): number {
  return task.detailItemCount ?? taskToolCallCount(task) + task.supplements.length;
}

/** Creates a concise accessible label for the complete task progress card. */
function taskStatusLabelForAria(task: PanelTask, t: Translator): string {
  return `${task.goal}: ${taskStatusLabel(task.status, t)}`;
}
