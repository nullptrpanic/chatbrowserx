import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelCompletedToolResult } from '../../shared/protocol/panel-types';
import { MessageImages } from '../chat/MessageImages';
import type { AttachmentDraftClient } from '../chat/use-image-draft';
import { toolDisplayName } from './browser-tool-label';

export interface ToolResultProps {
  readonly result: PanelCompletedToolResult;
  readonly attachments: AttachmentDraftClient;
  readonly t: Translator;
  readonly onOpenImagePreview?: ((attachmentId: string) => Promise<boolean>) | undefined;
}

/** Renders one persisted non-terminal tool result behind an independent compact disclosure. */
export function ToolResult({ result, attachments, t, onOpenImagePreview }: ToolResultProps) {
  const [expanded, setExpanded] = useState(false);
  const displayName = toolDisplayName(result.toolName, t);
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
          <MessageImages
            attachmentIds={result.attachmentIds ?? []}
            client={attachments}
            t={t}
            onOpenImagePreview={onOpenImagePreview}
          />
        </div>
      ) : null}
    </section>
  );
}
