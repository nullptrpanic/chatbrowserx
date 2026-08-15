import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';

export interface OriginPermissionCardProps {
  readonly origin: string;
  readonly t: Translator;
  readonly onGrant: () => Promise<boolean>;
}

/** Explains and requests access to exactly the active page origin from a user gesture. */
export function OriginPermissionCard({ origin, t, onGrant }: OriginPermissionCardProps) {
  const [requesting, setRequesting] = useState(false);
  return (
    <section className="permission-card">
      <ShieldCheck size={18} aria-hidden="true" />
      <div>
        <h2>{t('pageAccessNeeded')}</h2>
        <p>{t('pagePermissionExplanation')}</p>
        <code>{origin}</code>
        <button
          type="button"
          className="primary-button"
          disabled={requesting}
          onClick={() => {
            setRequesting(true);
            void onGrant().finally(() => setRequesting(false));
          }}
        >
          {requesting ? t('grantingAccess') : t('grantAccess')}
        </button>
      </div>
    </section>
  );
}
