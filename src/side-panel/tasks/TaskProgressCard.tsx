import { ChevronDown, ChevronUp, CircleStop, Pause, Play } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelTask } from '../../shared/protocol/panel-types';
import { TaskStatusLabel, taskEventLabel, taskStatusLabel } from './TaskStatusLabel';

const runningStatuses = new Set<PanelTask['status']>([
  'queued',
  'observing',
  'planning',
  'acting',
  'verifying',
  'checkpointed',
]);
const resumableStatuses = new Set<PanelTask['status']>([
  'paused',
  'waiting_for_tab',
  'waiting_for_auth',
]);

export interface TaskProgressCardProps {
  readonly task: PanelTask;
  readonly t: Translator;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
}

/** Renders compact durable progress with expandable audit events and recovery controls. */
export function TaskProgressCard({ task, t, onPause, onResume, onCancel }: TaskProgressCardProps) {
  const [expanded, setExpanded] = useState(false);
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  const latestEvent = task.events.at(-1);

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
        <span>
          {t('actionsProgress', {
            used: task.browserActionsUsed,
            limit: task.browserActionsLimit,
          })}
        </span>
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
        <ol className="task-event-list">
          {task.events.length === 0 ? <li>{t('noEvents')}</li> : null}
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
      ) : null}
      {terminal || task.status === 'waiting_for_confirmation' ? null : (
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
          <button type="button" className="text-danger-button" onClick={onCancel}>
            <CircleStop size={14} /> {t('cancel')}
          </button>
        </div>
      )}
    </section>
  );
}

/** Creates a concise accessible label for the complete task progress card. */
function taskStatusLabelForAria(task: PanelTask, t: Translator): string {
  return `${task.goal}: ${taskStatusLabel(task.status, t)}`;
}
