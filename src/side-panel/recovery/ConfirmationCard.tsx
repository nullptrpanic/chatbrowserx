import { ShieldAlert } from 'lucide-react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelPendingConfirmation } from '../../shared/protocol/panel-types';

export interface ConfirmationCardProps {
  readonly confirmation: PanelPendingConfirmation;
  readonly t: Translator;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Renders an explicit digest-bound confirmation for one high-risk browser action. */
export function ConfirmationCard({ confirmation, t, onConfirm, onCancel }: ConfirmationCardProps) {
  return (
    <section className="confirmation-card" aria-labelledby="confirmation-title">
      <div className="confirmation-icon" aria-hidden="true">
        <ShieldAlert size={18} />
      </div>
      <div>
        <h2 id="confirmation-title">{t('confirmationTitle')}</h2>
        <p>
          {t('confirmationBody', {
            action: confirmation.actionKind,
            target: confirmation.targetLabel === null ? '' : ` · ${confirmation.targetLabel}`,
          })}
        </p>
        <div className="confirmation-actions">
          <button type="button" className="danger-button" onClick={onConfirm}>
            {t('confirmAction')}
          </button>
          <button type="button" className="secondary-button" onClick={onCancel}>
            {t('rejectAction')}
          </button>
        </div>
      </div>
    </section>
  );
}
