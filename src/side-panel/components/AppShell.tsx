import type { ReactNode } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelTabContext } from '../../shared/protocol/panel-types';
import { PageContext } from './PageContext';
import { TopBar, type PanelView } from './TopBar';

export interface AppShellProps {
  readonly view: PanelView;
  readonly connection: 'loading' | 'ready' | 'error';
  readonly tab: PanelTabContext | null;
  readonly t: Translator;
  readonly onNewTask: () => void;
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
  onViewChange,
  children,
}: AppShellProps) {
  return (
    <main className="app-shell">
      <TopBar
        view={view}
        connection={connection}
        t={t}
        onNewTask={onNewTask}
        onViewChange={onViewChange}
      />
      {tab === null ? null : <PageContext tab={tab} t={t} />}
      <div className={`panel-view panel-view-${view}`}>{children}</div>
    </main>
  );
}
