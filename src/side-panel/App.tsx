import { AlertCircle, KeyRound, RotateCcw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ChromeRuntimePort, type RuntimePort } from '../platform/chrome/runtime-port';
import { createTranslator, resolveLanguage } from '../shared/i18n/i18n';
import { ChatComposer } from './chat/ChatComposer';
import { ConversationView } from './chat/ConversationView';
import {
  createSidePanelAttachmentClient,
  type AttachmentDraftClient,
} from './chat/use-image-draft';
import { AppShell } from './components/AppShell';
import type { PanelView } from './components/TopBar';
import { HistoryView } from './history/HistoryView';
import { SettingsView } from './settings/SettingsView';
import {
  createChromePanelEnvironment,
  PanelClient,
  type PanelEnvironment,
} from './state/panel-client';
import { usePanelStore } from './state/use-panel-store';

export interface AppProps {
  readonly runtimePort?: RuntimePort;
  readonly environment?: PanelEnvironment;
  readonly panelClient?: PanelClient;
  readonly attachmentClient?: AttachmentDraftClient;
}

const runningStatuses = new Set(['queued', 'planning']);
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

/** Renders the complete conversation-first Side Panel over one durable background client. */
export function App({ runtimePort, environment, panelClient, attachmentClient }: AppProps) {
  const client = useMemo(
    () =>
      panelClient ??
      new PanelClient(
        runtimePort ?? new ChromeRuntimePort(),
        environment ?? createChromePanelEnvironment(),
      ),
    [environment, panelClient, runtimePort],
  );
  const attachments = useMemo(
    () => attachmentClient ?? createSidePanelAttachmentClient(),
    [attachmentClient],
  );
  const state = usePanelStore(client);
  const [view, setView] = useState<PanelView>('conversation');
  const [draftText, setDraftText] = useState('');
  const snapshot = state.snapshot;
  const language = resolveLanguage(snapshot?.settings.language ?? 'system', navigator.language);
  const t = useMemo(() => createTranslator(language), [language]);
  const running =
    snapshot?.task !== null &&
    snapshot?.task !== undefined &&
    runningStatuses.has(snapshot.task.status);
  const taskLocked =
    (snapshot?.task !== null &&
      snapshot?.task !== undefined &&
      !terminalStatuses.has(snapshot.task.status)) ||
    (snapshot?.conversations.some(
      (conversation) =>
        conversation.taskStatus !== null && !terminalStatuses.has(conversation.taskStatus),
    ) ??
      false);
  const loadSettings = useCallback(() => client.getSettings(), [client]);

  /** Starts a clean local conversation draft and returns to the main conversation view. */
  function newTask(): void {
    client.newConversation();
    setDraftText('');
    setView('conversation');
  }

  return (
    <AppShell
      view={view}
      connection={
        state.status === 'ready' ? 'ready' : state.status === 'error' ? 'error' : 'loading'
      }
      tab={snapshot?.tab ?? null}
      t={t}
      onNewTask={newTask}
      canClearConversation={snapshot?.conversation !== null && snapshot?.conversation !== undefined}
      onClearConversation={() => client.clearActiveConversation()}
      onViewChange={setView}
    >
      {state.status === 'loading' && snapshot === null ? (
        <div className="panel-loading" role="status">
          <span className="loading-spinner" aria-hidden="true" />
          {t('connecting')}
        </div>
      ) : null}
      {state.status === 'error' && snapshot === null ? (
        <section className="connection-error" role="alert">
          <AlertCircle size={22} />
          <h1>{t('unavailable')}</h1>
          <button type="button" className="secondary-button" onClick={() => void client.refresh()}>
            <RotateCcw size={14} /> {t('retryConnection')}
          </button>
        </section>
      ) : null}
      {snapshot !== null && view === 'conversation' ? (
        <div className="conversation-layout">
          <div className="conversation-content">
            {!snapshot.tab.supported ? (
              <section className="unsupported-card">
                <AlertCircle size={18} />
                <p>{t('pageUnsupported')}</p>
              </section>
            ) : null}
            {!snapshot.settings.hasCodexToken ? (
              <section className="auth-card">
                <KeyRound size={18} />
                <div>
                  <p>{t('accessTokenMissing')}</p>
                  <button type="button" onClick={() => setView('settings')}>
                    {t('openSettings')}
                  </button>
                </div>
              </section>
            ) : null}
            <ConversationView
              messages={snapshot.messages}
              tasks={snapshot.tasks}
              task={snapshot.task}
              attachments={attachments}
              t={t}
              onSuggestion={setDraftText}
              onOpenImagePreview={(attachmentId) => client.openImagePreview(attachmentId)}
              onOpenSourcePage={(source) => client.openSourcePage(source)}
              onLoadTaskDetails={(taskId) => client.loadTaskDetails(taskId)}
              onPause={() => void client.pauseTask()}
              onResume={() => void client.resumeTask()}
              onRetry={() => void client.retryTask()}
              onCancel={() => void client.cancelTask()}
              onClearTaskContext={(taskId) => client.clearTaskContext(taskId)}
            />
          </div>
          <ChatComposer
            client={client}
            attachments={attachments}
            text={draftText}
            running={running}
            taskLocked={taskLocked}
            hasToken={snapshot.settings.hasCodexToken}
            t={t}
            onTextChange={setDraftText}
            onOpenSettings={() => setView('settings')}
          />
        </div>
      ) : null}
      {snapshot !== null && view === 'history' ? (
        <HistoryView
          conversations={snapshot.conversations}
          activeId={snapshot.conversation?.id ?? null}
          t={t}
          onSelect={(id) => {
            void client.selectConversation(id).then(() => setView('conversation'));
          }}
          onNew={newTask}
          onClear={() => client.clearActiveConversation()}
          onDelete={(id) => client.deleteConversation(id)}
        />
      ) : null}
      {snapshot !== null && view === 'settings' ? (
        <SettingsView
          settings={snapshot.settings}
          t={t}
          onLoad={loadSettings}
          onSave={(input) => client.saveSettings(input)}
        />
      ) : null}
    </AppShell>
  );
}
