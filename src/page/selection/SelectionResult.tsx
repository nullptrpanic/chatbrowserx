import type { SelectionLabels } from './selection-i18n';

export interface SelectionResultProps {
  readonly text: string;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onAsk: () => void;
  readonly onClose: () => void;
  readonly labels: SelectionLabels;
}

/** Renders a bounded translation result with copy and conversation continuation actions. */
export function SelectionResult({
  text,
  copied,
  onCopy,
  onAsk,
  onClose,
  labels,
}: SelectionResultProps) {
  return (
    <div className="cbx-selection-result" aria-live="polite">
      <p>{text}</p>
      <div className="cbx-selection-actions">
        <button type="button" onClick={onCopy}>
          {copied ? labels.copied : labels.copy}
        </button>
        <button type="button" onClick={onAsk}>
          {labels.askAi}
        </button>
        <button type="button" aria-label={labels.close} onClick={onClose}>
          ×
        </button>
      </div>
    </div>
  );
}
