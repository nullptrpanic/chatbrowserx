import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelTaskSupplement } from '../../shared/protocol/panel-types';
import { MessageImages } from '../chat/MessageImages';
import type { AttachmentDraftClient } from '../chat/use-image-draft';

interface TaskSupplementProps {
  readonly supplement: PanelTaskSupplement;
  readonly applicationState: 'applied' | 'pending';
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
}

/** Renders one queued or applied runtime supplement as a compact task detail. */
export function TaskSupplement({
  supplement,
  applicationState,
  attachments,
  t,
  onOpenImagePreview,
}: TaskSupplementProps) {
  const [expanded, setExpanded] = useState(false);
  const toggleLabel = expanded ? t('collapseUserSupplement') : t('expandUserSupplement');
  const stateLabel = t(
    applicationState === 'applied' ? 'userSupplementApplied' : 'userSupplementPending',
  );

  return (
    <section className="task-event-supplement" aria-label={t('userSupplement')}>
      <button
        type="button"
        className="task-supplement-toggle"
        aria-expanded={expanded}
        aria-label={toggleLabel}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="task-supplement-title">{t('userSupplement')}</span>
        <span className={`task-supplement-state is-${applicationState}`}>{stateLabel}</span>
        <time dateTime={new Date(supplement.createdAt).toISOString()}>
          {new Intl.DateTimeFormat(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(supplement.createdAt)}
        </time>
        {expanded ? (
          <ChevronUp size={13} aria-hidden="true" />
        ) : (
          <ChevronDown size={13} aria-hidden="true" />
        )}
      </button>
      {expanded ? (
        <div className="task-supplement-content">
          {supplement.text.length === 0 ? null : (
            <p className="task-supplement-text">{supplement.text}</p>
          )}
          <MessageImages
            attachmentIds={supplement.attachmentIds}
            client={attachments}
            t={t}
            onOpenImagePreview={onOpenImagePreview}
          />
        </div>
      ) : null}
    </section>
  );
}
