import type { AppLanguage } from '../../persistence/settings-store';
import { en } from './messages.en';
import { ja } from './messages.ja';
import { zhCN, type MessageKey } from './messages.zh-CN';

export type ResolvedLanguage = Exclude<AppLanguage, 'system'>;
export type Translator = (
  key: MessageKey,
  parameters?: Readonly<Record<string, string | number>>,
) => string;

const catalogs = { 'zh-CN': zhCN, en, ja } as const;

/** Resolves a stored language choice against the browser locale with an English fallback. */
export function resolveLanguage(setting: AppLanguage, systemLanguage: string): ResolvedLanguage {
  if (setting !== 'system') return setting;
  const normalized = systemLanguage.toLowerCase();
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('ja')) return 'ja';
  return 'en';
}

/** Creates a plain-text translator with named string and number interpolation only. */
export function createTranslator(language: ResolvedLanguage): Translator {
  const catalog = catalogs[language];
  return (key, parameters = {}) =>
    Object.entries(parameters).reduce(
      (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
      catalog[key],
    );
}
