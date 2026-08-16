import type { Translator } from '../../shared/i18n/i18n';
import type { MessageKey } from '../../shared/i18n/messages.zh-CN';
import type { PanelTaskStatus } from '../../shared/protocol/panel-types';

const statusKeys: Readonly<Record<PanelTaskStatus, MessageKey>> = {
  queued: 'taskQueued',
  planning: 'taskPlanning',
  waiting_for_auth: 'taskWaitingAuth',
  paused: 'taskPaused',
  completed: 'taskCompleted',
  failed: 'taskFailed',
  cancelled: 'taskCancelled',
};

const eventKeys: Readonly<Record<string, MessageKey>> = {
  'planning.started': 'taskPlanning',
  'task.auth-required': 'taskWaitingAuth',
  'task.paused': 'taskPaused',
  'task.resumed': 'taskQueued',
  'task.completed': 'taskCompleted',
  'task.failed': 'taskFailed',
  'task.cancelled': 'taskCancelled',
};

/** Returns the localized human-readable status for one durable task state. */
export function taskStatusLabel(status: PanelTaskStatus, t: Translator): string {
  return t(statusKeys[status]);
}

/** Returns a localized user-facing label for one internal durable event discriminator. */
export function taskEventLabel(type: string, t: Translator): string {
  return t(eventKeys[type] ?? 'taskUnknownEvent');
}

/** Renders one semantic task status dot and localized label. */
export function TaskStatusLabel({ status, t }: { status: PanelTaskStatus; t: Translator }) {
  return (
    <span className={`task-status task-status-${status}`}>
      <span className="task-status-dot" aria-hidden="true" />
      {taskStatusLabel(status, t)}
    </span>
  );
}
