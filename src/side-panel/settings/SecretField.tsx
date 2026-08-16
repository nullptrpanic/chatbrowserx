import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';

export interface SecretFieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly t: Translator;
}

/** Renders a trusted-context secret value masked until the user explicitly reveals it. */
export function SecretField({ id, label, hint, value, onChange, t }: SecretFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="form-field" htmlFor={id}>
      <span>{label}</span>
      <div className="secret-input-wrap">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder={hint}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          aria-label={visible ? t('hideSecret') : t('showSecret')}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
      <small>{hint}</small>
    </label>
  );
}
