import type { ReactNode } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelTabContext } from '../../shared/protocol/panel-types';
import { TopBar, type PanelView, type SandboxConsoleStatus } from './TopBar';

export interface AppShellProps {
  readonly view: PanelView;
  readonly connection: 'loading' | 'ready' | 'error';
  readonly tab: PanelTabContext | null;
  readonly t: Translator;
  readonly onNewTask: () => void;
  readonly sandboxConsoleStatus: SandboxConsoleStatus;
  readonly onOpenSandboxConsole: () => Promise<void>;
  readonly canClearConversation: boolean;
  readonly onClearConversation: () => Promise<void>;
  readonly onViewChange: (view: PanelView) => void;
  readonly children: ReactNode;
}

/** Composes the fixed Side Panel chrome around one replaceable main content view. */
export function AppShell({
  view,
  connection,
  tab,
  t,
  onNewTask,
  sandboxConsoleStatus,
  onOpenSandboxConsole,
  canClearConversation,
  onClearConversation,
  onViewChange,
  children,
}: AppShellProps) {
  return (
    <main className="app-shell">
      <TopBar
        view={view}
        connection={connection}
        tab={tab}
        t={t}
        onNewTask={onNewTask}
        sandboxConsoleStatus={sandboxConsoleStatus}
        onOpenSandboxConsole={onOpenSandboxConsole}
        canClearConversation={canClearConversation}
        onClearConversation={onClearConversation}
        onViewChange={onViewChange}
      />
      <div className={`panel-view panel-view-${view}`}>{children}</div>
    </main>
  );
}
