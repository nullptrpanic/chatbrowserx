import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelCompletedToolResult } from '../../shared/protocol/panel-types';

const terminalToolNames = new Set(['bash', 'shell', 'terminal', 'exec_command']);

export interface TerminalToolResultProps {
  readonly result: PanelCompletedToolResult;
  readonly t: Translator;
}

/** Returns whether a persisted tool result represents a terminal-style command. */
export function isTerminalToolName(toolName: string): boolean {
  return terminalToolNames.has(toolName.trim().toLowerCase());
}

/** Extracts the human-readable command while retaining malformed or unfamiliar arguments. */
export function readTerminalCommand(argumentsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of ['cmd', 'command', 'script'] as const) {
        const value = Reflect.get(parsed, key);
        if (typeof value === 'string' && value.length > 0) return value;
      }
    }
  } catch {
    // The persisted raw arguments remain the safest useful fallback.
  }
  return argumentsJson;
}

/** Renders persisted command execution as a compact, independently collapsible terminal. */
export function TerminalToolResult({ result, t }: TerminalToolResultProps) {
  const [expanded, setExpanded] = useState(true);
  const command = readTerminalCommand(result.argumentsJson);
  return (
    <section className="terminal-result" aria-label={`${result.toolName}: ${t('toolCompleted')}`}>
      <div className="terminal-titlebar">
        <span className="terminal-lights" aria-hidden="true">
          <i /> <i /> <i />
        </span>
        <span className="terminal-title">
          <Terminal size={12} />
          <span>{result.toolName}</span>
          <span className="terminal-state">{t('toolCompleted')}</span>
        </span>
        <button
          type="button"
          aria-label={t(expanded ? 'collapseTerminalOutput' : 'expandTerminalOutput')}
          title={t(expanded ? 'collapseTerminalOutput' : 'expandTerminalOutput')}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      <div className="terminal-command">
        <span aria-hidden="true">$</span>
        <code>{command}</code>
      </div>
      {expanded && result.output.length > 0 ? (
        <pre className="terminal-output">
          <code>{result.output}</code>
        </pre>
      ) : null}
    </section>
  );
}
