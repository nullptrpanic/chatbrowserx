import type { Translator } from '../../shared/i18n/i18n';
import type { MessageKey } from '../../shared/i18n/messages.zh-CN';
import type { PanelTaskStatus } from '../../shared/protocol/panel-types';

const statusKeys: Readonly<Record<PanelTaskStatus, MessageKey>> = {
  queued: 'taskQueued',
  observing: 'taskObserving',
  planning: 'taskPlanning',
  acting: 'taskActing',
  verifying: 'taskVerifying',
  checkpointed: 'taskCheckpointed',
  waiting_for_tab: 'taskWaitingTab',
  waiting_for_auth: 'taskWaitingAuth',
  waiting_for_confirmation: 'taskWaitingConfirmation',
  paused: 'taskPaused',
  completed: 'taskCompleted',
  failed: 'taskFailed',
  cancelled: 'taskCancelled',
};

const eventKeys: Readonly<Record<string, MessageKey>> = {
  'observation.started': 'taskObserving',
  'planning.started': 'taskPlanning',
  'planning.rejected': 'taskPlanAdjusted',
  'tool.result-recorded': 'taskToolResultSaved',
  'action.intent-recorded': 'taskActing',
  'action.evidence-recorded': 'taskVerifying',
  'action.verified': 'taskActionVerified',
  'action.verification-failed': 'taskActionNotVerified',
  'task.tab-missing': 'taskWaitingTab',
  'task.auth-required': 'taskWaitingAuth',
  'task.confirmation-required': 'taskWaitingConfirmation',
  'task.paused': 'taskPaused',
  'task.budget-exhausted': 'taskBudgetExhausted',
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
