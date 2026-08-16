import { CODEX_MODEL } from '../providers/codex/codex-constants';
import { isProviderError, providerErrorFromCode } from '../providers/provider-errors';
import type { ModelProvider } from '../providers/provider-types';
import type { SettingsStore } from '../persistence/settings-store';

const TRANSLATION_TIMEOUT_MS = 60_000;
const MAX_SELECTION_LENGTH = 8_000;
const MAX_QUESTION_LENGTH = 4_000;
const MAX_TRANSLATION_LENGTH = 30_000;
const terminalTaskStatuses = new Set(['completed', 'failed', 'cancelled']);

export type SelectionControllerErrorCode =
  'INVALID_SELECTION' | 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'CANCELLED' | 'TRANSLATION_FAILED';

export class SelectionControllerError extends Error {
  readonly code: SelectionControllerErrorCode;

  /** Creates one stable page-safe error without embedding selected text or provider details. */
  constructor(code: SelectionControllerErrorCode) {
    super('Selection operation could not be completed.');
    this.name = 'SelectionControllerError';
    this.code = code;
  }
}

export interface SelectionTextInput {
  readonly text: string;
  readonly pageUrl: string;
  readonly pageTitle: string;
}

export interface SelectionAskInput extends SelectionTextInput {
  readonly tabId: number;
  readonly question: string;
}

export interface SelectionControllerDependencies {
  readonly provider: ModelProvider;
  readonly settings: Pick<SettingsStore, 'get'>;
  readonly panel: {
    getSnapshot(tabId: number): Promise<{
      readonly conversation: { readonly id: string } | null;
      readonly task: { readonly status: string } | null;
    }>;
    submit(input: {
      readonly tabId: number;
      readonly conversationId?: string | undefined;
      readonly text: string;
      readonly attachmentIds: readonly string[];
    }): Promise<unknown>;
  };
  readonly sidePanel: { open(options: { readonly tabId: number }): Promise<void> };
}

/** Validates selected text at the trusted background boundary. */
function normalizeText(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_SELECTION_LENGTH) {
    throw new SelectionControllerError('INVALID_SELECTION');
  }
  return normalized;
}

/** Converts a provider failure into the narrow error vocabulary exposed to page UI. */
function selectionFailure(error: unknown): SelectionControllerError {
  if (error instanceof SelectionControllerError) return error;
  if (isProviderError(error)) {
    if (error.code === 'AUTH') return new SelectionControllerError('AUTH_REQUIRED');
    if (error.code === 'RATE_LIMIT') return new SelectionControllerError('RATE_LIMITED');
    if (error.code === 'ABORTED') return new SelectionControllerError('CANCELLED');
  }
  return new SelectionControllerError('TRANSLATION_FAILED');
}

/** Quotes selected text without allowing its lines to escape the Markdown quotation. */
function quoteSelection(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

export class SelectionController {
  readonly #dependencies: SelectionControllerDependencies;

  /** Creates the trusted translation and Side Panel continuation boundary. */
  constructor(dependencies: SelectionControllerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Runs one bounded text-only translation request with no registered tools. */
  async translate(
    input: SelectionTextInput,
    signal: AbortSignal = AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
  ): Promise<{ readonly text: string }> {
    const text = normalizeText(input.text);
    const settings = await this.#dependencies.settings.get();
    let responseId: string | null = null;
    let completed = false;
    let output = '';
    try {
      for await (const event of this.#dependencies.provider.stream(
        {
          model: CODEX_MODEL,
          reasoningEffort: settings.reasoningEffort,
          systemPrompt:
            'Translate the selected webpage text faithfully. Preserve meaning, tone, names, numbers, and formatting. Translate Chinese text to English; translate other languages to Simplified Chinese. Output only the translation.',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `Page title: ${input.pageTitle.slice(0, 500)}\nPage URL: ${input.pageUrl.slice(0, 4_096)}\n\nSelected text:\n${text}`,
                },
              ],
            },
          ],
          tools: [],
        },
        signal,
      )) {
        if (event.type === 'response.started') {
          if (responseId !== null) throw providerErrorFromCode('INVALID_RESPONSE');
          responseId = event.responseId;
        } else if (event.type === 'text.delta') {
          output += event.delta;
          if (output.length > MAX_TRANSLATION_LENGTH) {
            throw providerErrorFromCode('INVALID_RESPONSE');
          }
        } else if (event.type === 'response.completed') {
          if (responseId === null || event.responseId !== responseId || completed) {
            throw providerErrorFromCode('INVALID_RESPONSE');
          }
          completed = true;
        } else if (event.type.startsWith('tool.')) {
          throw providerErrorFromCode('INVALID_RESPONSE');
        }
      }
      const normalized = output.trim();
      if (!completed || normalized.length === 0) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      return { text: normalized };
    } catch (error) {
      throw selectionFailure(error);
    }
  }

  /** Opens the Side Panel from the user gesture and schedules the quoted question durably. */
  async ask(input: SelectionAskInput): Promise<void> {
    if (!Number.isInteger(input.tabId) || input.tabId < 0) {
      throw new SelectionControllerError('INVALID_SELECTION');
    }
    const text = normalizeText(input.text);
    const question = input.question.trim();
    if (question.length > MAX_QUESTION_LENGTH) {
      throw new SelectionControllerError('INVALID_SELECTION');
    }
    const opening = this.#dependencies.sidePanel
      .open({ tabId: input.tabId })
      .catch(() => undefined);
    const snapshot = await this.#dependencies.panel.getSnapshot(input.tabId);
    const conversationAvailable =
      snapshot.conversation !== null &&
      (snapshot.task === null || terminalTaskStatuses.has(snapshot.task.status));
    await this.#dependencies.panel.submit({
      tabId: input.tabId,
      ...(conversationAvailable ? { conversationId: snapshot.conversation.id } : {}),
      attachmentIds: [],
      text: `关于当前页面中的这段内容：\n\n${quoteSelection(text)}\n\n我的问题：${question || '请解释这段内容。'}`,
    });
    await opening;
  }
}
