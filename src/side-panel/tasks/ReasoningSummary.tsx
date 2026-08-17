import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import { RestrictedMarkdown } from '../chat/RestrictedMarkdown';

interface ReasoningSummaryProps {
  readonly summary: string;
  readonly t: Translator;
}

/** Renders a provider-authored reasoning summary as a compact, opt-in task detail. */
export function ReasoningSummary({ summary, t }: ReasoningSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const toggleLabel = expanded ? t('collapseReasoningSummary') : t('expandReasoningSummary');

  return (
    <section className="task-event-reasoning" aria-label={t('reasoningSummary')}>
      <button
        type="button"
        className="reasoning-summary-toggle"
        aria-expanded={expanded}
        aria-label={toggleLabel}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{t('reasoningSummary')}</span>
        {expanded ? (
          <ChevronUp size={13} aria-hidden="true" />
        ) : (
          <ChevronDown size={13} aria-hidden="true" />
        )}
      </button>
      {expanded ? (
        <div className="reasoning-summary-content">
          <RestrictedMarkdown text={summary} />
        </div>
      ) : null}
    </section>
  );
}
