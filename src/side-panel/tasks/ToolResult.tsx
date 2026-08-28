import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelToolResult } from '../../shared/protocol/panel-types';
import { MessageImages } from '../chat/MessageImages';
import { copyMessageToClipboard } from '../chat/copy-message';
import type { AttachmentDraftClient } from '../chat/use-image-draft';
import { toolDisplayName } from './browser-tool-label';
import { ToolCopyButton } from './ToolCopyButton';

export interface ToolResultProps {
  readonly result: PanelToolResult;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
}

/** Pretty-prints complete JSON containers while preserving arbitrary tool text verbatim. */
function formatToolPayload(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return value;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

/** Reads only the bounded numeric fields from a trusted internal commit result. */
function contextCommitSummary(result: PanelToolResult, t: Translator): string | null {
  if (result.toolName !== 'commit_context') return null;
  try {
    const value: unknown = JSON.parse(result.output);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const calls = record.compactedCalls;
    const chars = record.releasedTextChars;
    const images = record.releasedImages;
    if (
      record.ok !== true ||
      typeof calls !== 'number' ||
      typeof chars !== 'number' ||
      typeof images !== 'number' ||
      !Number.isSafeInteger(calls) ||
      !Number.isSafeInteger(chars) ||
      !Number.isSafeInteger(images) ||
      calls < 0 ||
      chars < 0 ||
      images < 0
    ) {
      return null;
    }
    return t('contextCommitSummary', { calls, chars, images });
  } catch {
    return null;
  }
}

/** Renders one persisted non-terminal tool result behind an independent compact disclosure. */
export function ToolResult({ result, attachments, t, onOpenImagePreview }: ToolResultProps) {
  const [expanded, setExpanded] = useState(false);
  const displayName = toolDisplayName(result.toolName, t);
  const commitSummary = contextCommitSummary(result, t);
  const formattedArguments = formatToolPayload(result.argumentsJson);
  const formattedOutput = formatToolPayload(result.output);
  return (
    <section className="tool-result" aria-label={`${displayName}: ${t('toolCompleted')}`}>
      <button
        type="button"
        className="tool-result-title"
        aria-expanded={expanded}
        aria-label={t(expanded ? 'collapseToolOutput' : 'expandToolOutput', {
          tool: displayName,
        })}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{displayName}</span>
        <span className="tool-result-state">
          {t('toolCompleted')}
          {expanded ? (
            <ChevronUp size={13} aria-hidden="true" />
          ) : (
            <ChevronDown size={13} aria-hidden="true" />
          )}
        </span>
      </button>
      {commitSummary === null ? null : <p className="tool-result-summary">{commitSummary}</p>}
      {expanded ? (
        <div className="tool-result-content">
          {result.argumentsJson.length === 0 ? null : (
            <section className="tool-result-payload">
              <header className="tool-result-payload-header">
                <span className="tool-result-payload-label">
                  <span>{t('toolInvocation')}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tool-result-tool-name" title={result.toolName}>
                    {result.toolName}
                  </span>
                </span>
                <ToolCopyButton
                  label={t('copyToolArguments')}
                  copiedLabel={t('toolArgumentsCopied')}
                  onCopy={() =>
                    copyMessageToClipboard({
                      text: formattedArguments,
                      attachmentIds: [],
                      client: attachments,
                    })
                  }
                />
              </header>
              <pre>
                <code>{formattedArguments}</code>
              </pre>
            </section>
          )}
          {result.output.length === 0 && result.attachmentIds.length === 0 ? null : (
            <section className="tool-result-payload">
              <header className="tool-result-payload-header">
                <span>{t('toolResult')}</span>
                <ToolCopyButton
                  label={t('copyToolResult')}
                  copiedLabel={t('toolResultCopied')}
                  onCopy={() =>
                    copyMessageToClipboard({
                      text: formattedOutput,
                      attachmentIds: result.attachmentIds,
                      client: attachments,
                    })
                  }
                />
              </header>
              {result.output.length === 0 ? null : (
                <pre>
                  <code>{formattedOutput}</code>
                </pre>
              )}
              <MessageImages
                attachmentIds={result.attachmentIds}
                client={attachments}
                t={t}
                onOpenImagePreview={onOpenImagePreview}
              />
            </section>
          )}
        </div>
      ) : null}
    </section>
  );
}
