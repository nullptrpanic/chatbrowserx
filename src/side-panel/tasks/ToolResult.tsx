import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelCompletedToolResult } from '../../shared/protocol/panel-types';

export interface ToolResultProps {
  readonly result: PanelCompletedToolResult;
  readonly t: Translator;
}

/** Renders one persisted non-terminal tool result behind an independent compact disclosure. */
export function ToolResult({ result, t }: ToolResultProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="tool-result" aria-label={`${result.toolName}: ${t('toolCompleted')}`}>
      <button
        type="button"
        className="tool-result-title"
        aria-expanded={expanded}
        aria-label={t(expanded ? 'collapseToolOutput' : 'expandToolOutput', {
          tool: result.toolName,
        })}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{result.toolName}</span>
        <span className="tool-result-state">
          {t('toolCompleted')}
          {expanded ? (
            <ChevronUp size={13} aria-hidden="true" />
          ) : (
            <ChevronDown size={13} aria-hidden="true" />
          )}
        </span>
      </button>
      {expanded ? (
        <div className="tool-result-content">
          {result.argumentsJson.length === 0 ? null : (
            <pre>
              <code>{result.argumentsJson}</code>
            </pre>
          )}
          {result.output.length === 0 ? null : (
            <pre>
              <code>{result.output}</code>
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}
