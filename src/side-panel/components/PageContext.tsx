import { Globe2, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelTabContext } from '../../shared/protocol/panel-types';

export interface PageContextProps {
  readonly tab: PanelTabContext;
  readonly t: Translator;
}

/** Renders a quiet one-row page identity and permission summary. */
export function PageContext({ tab, t }: PageContextProps) {
  const host = (() => {
    try {
      return new URL(tab.url).hostname;
    } catch {
      return tab.origin;
    }
  })();
  return (
    <section className="page-context" aria-label={t('pageContext')}>
      <Globe2 size={15} aria-hidden="true" />
      <div className="page-context-copy">
        <span className="page-title" title={tab.title || tab.url}>
          {tab.title || host || t('pageUnsupported')}
        </span>
        <span className="page-origin" title={tab.url}>
          {host}
        </span>
      </div>
      <span
        className={`permission-indicator ${tab.hasPermission ? 'is-ready' : 'is-needed'}`}
        title={tab.hasPermission ? t('pageAccessReady') : t('pageAccessNeeded')}
      >
        {tab.hasPermission ? <ShieldCheck size={14} /> : <ShieldQuestion size={14} />}
      </span>
    </section>
  );
}
