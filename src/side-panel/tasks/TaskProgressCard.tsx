import { ChevronDown, ChevronUp, CircleStop, Pause, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelTask } from '../../shared/protocol/panel-types';
import { isTerminalToolName, TerminalToolResult } from './TerminalToolResult';
import { TaskStatusLabel, taskEventLabel, taskStatusLabel } from './TaskStatusLabel';

const runningStatuses = new Set<PanelTask['status']>(['queued', 'planning']);
const resumableStatuses = new Set<PanelTask['status']>(['paused', 'waiting_for_auth']);

export interface TaskProgressCardProps {
  readonly task: PanelTask;
  readonly t: Translator;
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
  t,
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
        {expanded ? <TaskDetailContent task={task} t={t} /> : null}
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
      {expanded ? <TaskDetailContent task={task} t={t} /> : null}
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

function TaskDetailContent({ task, t }: { readonly task: PanelTask; readonly t: Translator }) {
  return (
    <div className="task-detail-content">
      {task.events.length === 0 && task.completedToolResults.length === 0 ? (
        <p className="task-detail-empty">{t('noEvents')}</p>
      ) : null}
      {task.events.length === 0 ? null : (
        <ol className="task-event-list">
          {task.events.map((event) => (
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
            </li>
          ))}
        </ol>
      )}
      {task.completedToolResults.length === 0 ? null : (
        <div className="task-tool-results">
          {task.completedToolResults.map((result) =>
            isTerminalToolName(result.toolName) ? (
              <TerminalToolResult key={result.callId} result={result} t={t} />
            ) : (
              <section className="tool-result" key={result.callId}>
                <div className="tool-result-title">
                  <span>{result.toolName}</span>
                  <span>{t('toolCompleted')}</span>
                </div>
                {result.argumentsJson.length === 0 ? null : (
                  <pre>
                    <code>{result.argumentsJson}</code>
                  </pre>
                )}
                {result.output.length === 0 ? null : (
                  <pre>
                    <code>{result.output}</code>
                  </pre>
                )}
              </section>
            ),
          )}
        </div>
      )}
    </div>
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

/** Creates a concise accessible label for the complete task progress card. */
function taskStatusLabelForAria(task: PanelTask, t: Translator): string {
  return `${task.goal}: ${taskStatusLabel(task.status, t)}`;
}
