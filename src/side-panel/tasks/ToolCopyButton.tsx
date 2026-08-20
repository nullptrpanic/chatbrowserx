import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export interface ToolCopyButtonProps {
  readonly label: string;
  readonly copiedLabel: string;
  readonly onCopy: () => Promise<void>;
}

/** Copies one tool payload without changing the disclosure layout. */
export function ToolCopyButton({ label, copiedLabel, onCopy }: ToolCopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      className="tool-copy-action"
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      onClick={(event) => {
        event.stopPropagation();
        void onCopy()
          .then(() => {
            setCopied(true);
            if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(() => setCopied(false), 1_500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}
