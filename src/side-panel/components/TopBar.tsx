import { ArrowLeft, History, Settings, Sparkles, SquarePen } from 'lucide-react';
import type { Translator } from '../../shared/i18n/i18n';
import { IconButton } from './IconButton';

export type PanelView = 'conversation' | 'history' | 'settings';

export interface TopBarProps {
  readonly view: PanelView;
  readonly connection: 'loading' | 'ready' | 'error';
  readonly t: Translator;
  readonly onNewTask: () => void;
  readonly onViewChange: (view: PanelView) => void;
}

/** Renders the compact product navigation and background connection indicator. */
export function TopBar({ view, connection, t, onNewTask, onViewChange }: TopBarProps) {
  return (
    <header className="top-bar">
      <div className="brand-lockup" aria-label={t('brand')}>
        <span className="brand-mark" aria-hidden="true">
          <Sparkles size={16} strokeWidth={1.8} />
        </span>
        <span className="brand-name">{t('brand')}</span>
      </div>
      <div className="top-bar-actions">
        {view === 'conversation' ? (
          <>
            <IconButton label={t('newTask')} onClick={onNewTask}>
              <SquarePen size={17} />
            </IconButton>
            <IconButton label={t('history')} onClick={() => onViewChange('history')}>
              <History size={17} />
            </IconButton>
            <IconButton label={t('settings')} onClick={() => onViewChange('settings')}>
              <Settings size={17} />
            </IconButton>
          </>
        ) : (
          <IconButton label={t('back')} onClick={() => onViewChange('conversation')}>
            <ArrowLeft size={18} />
          </IconButton>
        )}
        <span
          className={`connection-dot is-${connection}`}
          role="status"
          aria-label={
            connection === 'ready'
              ? t('connected')
              : connection === 'loading'
                ? t('connecting')
                : t('unavailable')
          }
          title={
            connection === 'ready'
              ? t('connected')
              : connection === 'loading'
                ? t('connecting')
                : t('unavailable')
          }
        />
      </div>
    </header>
  );
}
