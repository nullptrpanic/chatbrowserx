import { ChevronDown, ChevronUp, Terminal } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelCompletedToolResult } from '../../shared/protocol/panel-types';
import { toolDisplayName } from './browser-tool-label';
import { ToolCopyButton } from './ToolCopyButton';

const terminalToolNames = new Set(['bash', 'shell', 'terminal', 'exec_command', 'sandbox_exec']);

export interface TerminalToolResultProps {
  readonly result: PanelCompletedToolResult;
  readonly t: Translator;
}

/** Returns whether a persisted tool result represents a terminal-style command. */
export function isTerminalToolName(toolName: string): boolean {
  return terminalToolNames.has(toolName.trim().toLowerCase());
}

interface TerminalInvocation {
  readonly command: string;
  readonly cwd: string | null;
}

interface TerminalOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly truncated: boolean;
}

/** Extracts terminal invocation fields while retaining malformed or unfamiliar arguments. */
function readTerminalInvocation(argumentsJson: string): TerminalInvocation {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of ['cmd', 'command', 'script'] as const) {
        const value = Reflect.get(parsed, key);
        if (typeof value === 'string' && value.length > 0) {
          const cwd = Reflect.get(parsed, 'cwd');
          return { command: value, cwd: typeof cwd === 'string' ? cwd : null };
        }
      }
    }
  } catch {
    // The persisted raw arguments remain the safest useful fallback.
  }
  return { command: argumentsJson, cwd: null };
}

/** Extracts the human-readable command while retaining malformed or unfamiliar arguments. */
export function readTerminalCommand(argumentsJson: string): string {
  return readTerminalInvocation(argumentsJson).command;
}

/** Parses only the bounded Sandbox result fields and otherwise preserves the raw output. */
function readTerminalOutput(result: PanelCompletedToolResult): TerminalOutput {
  if (result.toolName.trim().toLowerCase() !== 'sandbox_exec') {
    return { stdout: result.output, stderr: '', code: null, truncated: false };
  }
  try {
    const parsed: unknown = JSON.parse(result.output);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid result.');
    const code = Reflect.get(parsed, 'code');
    const stdout = Reflect.get(parsed, 'stdout');
    const stderr = Reflect.get(parsed, 'stderr');
    const truncated = Reflect.get(parsed, 'truncated');
    if (
      typeof code !== 'number' ||
      !Number.isSafeInteger(code) ||
      typeof stdout !== 'string' ||
      typeof stderr !== 'string' ||
      typeof truncated !== 'boolean'
    ) {
      throw new Error('Invalid result.');
    }
    return { code, stdout, stderr, truncated };
  } catch {
    return { stdout: result.output, stderr: '', code: null, truncated: false };
  }
}

/** Renders persisted command execution as a compact, independently collapsible terminal. */
export function TerminalToolResult({ result, t }: TerminalToolResultProps) {
  const [expanded, setExpanded] = useState(false);
  const invocation = readTerminalInvocation(result.argumentsJson);
  const output = readTerminalOutput(result);
  const displayName = toolDisplayName(result.toolName, t);
  return (
    <section className="terminal-result" aria-label={`${displayName}: ${t('toolCompleted')}`}>
      <div className="terminal-titlebar">
        <span className="terminal-lights" aria-hidden="true">
          <i /> <i /> <i />
        </span>
        <span className="terminal-title">
          <Terminal size={12} />
          <span>{displayName}</span>
          <span className="terminal-state">{t('toolCompleted')}</span>
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={t(expanded ? 'collapseTerminalOutput' : 'expandTerminalOutput')}
          title={t(expanded ? 'collapseTerminalOutput' : 'expandTerminalOutput')}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {expanded ? (
        <div className="terminal-content">
          <section className="terminal-payload">
            <header className="terminal-payload-header">
              <span>{t('terminalCommand')}</span>
              <ToolCopyButton
                label={t('copyTerminalCommand')}
                copiedLabel={t('terminalCommandCopied')}
                onCopy={() => navigator.clipboard.writeText(invocation.command)}
              />
            </header>
            {invocation.cwd === null ? null : (
              <p className="terminal-cwd">
                <span>{t('terminalWorkingDirectory')}</span>
                <code>{invocation.cwd}</code>
              </p>
            )}
            <div className="terminal-command">
              <span aria-hidden="true">$</span>
              <code>{invocation.command}</code>
            </div>
          </section>
          {result.output.length > 0 ? (
            <section className="terminal-payload">
              <header className="terminal-payload-header">
                <span className="terminal-output-heading">
                  <span>{t('terminalOutput')}</span>
                  {output.code === null ? null : (
                    <span>{t('terminalExitCode', { code: output.code })}</span>
                  )}
                  {output.truncated ? <span>{t('terminalOutputTruncated')}</span> : null}
                </span>
                <ToolCopyButton
                  label={t('copyTerminalOutput')}
                  copiedLabel={t('terminalOutputCopied')}
                  onCopy={() => navigator.clipboard.writeText(result.output)}
                />
              </header>
              {output.stdout.length === 0 ? null : (
                <div className="terminal-stream">
                  {output.stderr.length === 0 ? null : (
                    <span className="terminal-stream-label">{t('terminalStdout')}</span>
                  )}
                  <pre className="terminal-output">
                    <code>{output.stdout}</code>
                  </pre>
                </div>
              )}
              {output.stderr.length === 0 ? null : (
                <div className="terminal-stream is-stderr">
                  <span className="terminal-stream-label">{t('terminalStderr')}</span>
                  <pre className="terminal-output">
                    <code>{output.stderr}</code>
                  </pre>
                </div>
              )}
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
