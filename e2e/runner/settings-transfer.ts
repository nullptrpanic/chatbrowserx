import type { ExtensionMessage } from '../../src/shared/protocol/message-types';
import { jsonRecord } from './json-contract';

type SettingsSavePayload = Extract<ExtensionMessage, { readonly type: 'settings.save' }>['payload'];

const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const LANGUAGES = new Set(['system', 'zh-CN', 'en', 'ja']);

/** Creates the in-memory settings payload used to give an isolated build the same test inputs. */
export function settingsTransferPayload(value: unknown): SettingsSavePayload {
  const settings = jsonRecord(value);
  if (settings === null) throw new Error('Source extension returned invalid editable settings.');
  if (
    typeof settings.reasoningEffort !== 'string' ||
    !REASONING_EFFORTS.has(settings.reasoningEffort)
  ) {
    throw new Error('Source extension returned an invalid reasoning effort.');
  }
  if (typeof settings.language !== 'string' || !LANGUAGES.has(settings.language)) {
    throw new Error('Source extension returned an invalid language.');
  }
  if (typeof settings.systemPrompt !== 'string') {
    throw new Error('Source extension returned an invalid system prompt.');
  }
  if (
    typeof settings.historyMessageLimit !== 'number' ||
    !Number.isSafeInteger(settings.historyMessageLimit) ||
    settings.historyMessageLimit < 1
  ) {
    throw new Error('Source extension returned an invalid history message limit.');
  }
  if (
    typeof settings.codexAccessToken !== 'string' ||
    settings.codexAccessToken.trim().length === 0
  ) {
    throw new Error('Source extension has no Codex access token to transfer.');
  }
  if (typeof settings.tavilyKey !== 'string') {
    throw new Error('Source extension returned an invalid Tavily credential.');
  }
  if (settings.sandboxServer !== undefined && typeof settings.sandboxServer !== 'string') {
    throw new Error('Source extension returned an invalid Sandbox server.');
  }
  if (settings.sandboxToken !== undefined && typeof settings.sandboxToken !== 'string') {
    throw new Error('Source extension returned an invalid Sandbox credential.');
  }

  return {
    reasoningEffort: settings.reasoningEffort as SettingsSavePayload['reasoningEffort'],
    systemPrompt: settings.systemPrompt,
    language: settings.language as SettingsSavePayload['language'],
    historyMessageLimit: settings.historyMessageLimit,
    codexAccessToken: settings.codexAccessToken,
    ...(settings.tavilyKey.trim().length === 0 ? {} : { tavilyKey: settings.tavilyKey }),
    ...(settings.sandboxServer === undefined ? {} : { sandboxServer: settings.sandboxServer }),
    ...(settings.sandboxToken === undefined || settings.sandboxToken.trim().length === 0
      ? {}
      : { sandboxToken: settings.sandboxToken }),
  };
}
