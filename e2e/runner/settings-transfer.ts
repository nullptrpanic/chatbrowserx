import type { ExtensionMessage } from '../../src/shared/protocol/message-types';
import { jsonRecord } from './json-contract';

type SettingsSavePayload = Extract<ExtensionMessage, { readonly type: 'settings.save' }>['payload'];

const LANGUAGES = new Set(['system', 'zh-CN', 'en', 'ja']);

/** Creates the in-memory settings payload used to give an isolated build the same test inputs. */
export function settingsTransferPayload(value: unknown): SettingsSavePayload {
  const settings = jsonRecord(value);
  if (settings === null) throw new Error('Source extension returned invalid editable settings.');
  if (
    typeof settings.reasoningEffort !== 'string' ||
    settings.reasoningEffort.trim().length === 0 ||
    settings.reasoningEffort.length > 64
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
    typeof settings.accessToken !== 'string' ||
    (settings.accessToken.trim().length === 0 &&
      !(
        settings.credentialSource === 'sandbox' &&
        typeof settings.sandboxServer === 'string' &&
        settings.sandboxServer.trim() &&
        typeof settings.sandboxToken === 'string' &&
        settings.sandboxToken.trim()
      ))
  ) {
    throw new Error('Source extension has no model access token to transfer.');
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

  for (const key of ['providerId', 'model', 'authPath']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'string')
      throw new Error('Source extension returned invalid provider configuration.');
  }
  if (
    settings.credentialSource !== undefined &&
    settings.credentialSource !== 'manual' &&
    settings.credentialSource !== 'sandbox'
  )
    throw new Error('Source extension returned an invalid credential source.');
  return {
    ...(settings.providerId ? { providerId: settings.providerId as string } : {}),
    ...(settings.model ? { model: settings.model as string } : {}),
    ...(settings.authPath === undefined ? {} : { authPath: settings.authPath as string }),
    ...(settings.credentialSource === undefined
      ? {}
      : { credentialSource: settings.credentialSource }),
    reasoningEffort: settings.reasoningEffort as SettingsSavePayload['reasoningEffort'],
    systemPrompt: settings.systemPrompt,
    language: settings.language as SettingsSavePayload['language'],
    historyMessageLimit: settings.historyMessageLimit,
    ...(settings.accessToken.trim() ? { accessToken: settings.accessToken } : {}),
    ...(settings.tavilyKey.trim().length === 0 ? {} : { tavilyKey: settings.tavilyKey }),
    ...(settings.sandboxServer === undefined ? {} : { sandboxServer: settings.sandboxServer }),
    ...(settings.sandboxToken === undefined || settings.sandboxToken.trim().length === 0
      ? {}
      : { sandboxToken: settings.sandboxToken }),
  };
}
