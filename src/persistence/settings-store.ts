import { z } from 'zod';
import { ChromeLocalStorageArea, type StorageAreaPort } from './storage-area';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type AppLanguage = 'system' | 'zh-CN' | 'en' | 'ja';

export interface AppSettings {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly systemPrompt: string;
  readonly language: AppLanguage;
  readonly historyMessageLimit: number;
  readonly sandboxServer?: string;
}

export interface SettingsStore {
  get(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
  reset(): Promise<AppSettings>;
}

const SETTINGS_KEY = 'settings.app';
const sandboxServerSchema = z
  .string()
  .trim()
  .max(2_048)
  .transform((value, context) => {
    if (value.length === 0) {
      return '';
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Sandbox Server must be a valid URL.' });
      return z.NEVER;
    }

    const isLoopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      context.addIssue({ code: 'custom', message: 'Sandbox Server URL is not allowed.' });
      return z.NEVER;
    }

    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  });
const storedAppSettingsSchema = z
  .object({
    model: z.string().trim().min(1).max(256),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']),
    systemPrompt: z.string().max(20_000),
    language: z.enum(['system', 'zh-CN', 'en', 'ja']),
    historyMessageLimit: z.number().int().min(1).max(200).default(50),
    sandboxServer: sandboxServerSchema.default(''),
  })
  .strict();
const appSettingsSchema = storedAppSettingsSchema.extend({
  historyMessageLimit: z.number().int().min(1).max(50).default(50),
});

export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  model: 'gpt-5.6-terra',
  reasoningEffort: 'medium',
  systemPrompt: '',
  language: 'system',
  historyMessageLimit: 50,
  sandboxServer: '',
});

export class ChromeSettingsStore implements SettingsStore {
  readonly #storage: StorageAreaPort;

  /**
   * Creates a settings store backed by an injected or real Chrome local storage boundary.
   */
  constructor(storage: StorageAreaPort = new ChromeLocalStorageArea()) {
    this.#storage = storage;
  }

  /**
   * Reads validated application settings and supplies exact defaults when no value exists.
   */
  async get(): Promise<AppSettings> {
    const stored = (await this.#storage.get(SETTINGS_KEY))[SETTINGS_KEY];
    if (stored === undefined) {
      return { ...DEFAULT_APP_SETTINGS };
    }

    const parsed = storedAppSettingsSchema.safeParse(stored);
    if (!parsed.success) {
      throw new Error('Stored app settings are invalid.');
    }

    return {
      ...parsed.data,
      historyMessageLimit: Math.min(parsed.data.historyMessageLimit, 50),
    };
  }

  /**
   * Validates and saves application settings without changing any credential key.
   */
  async save(settings: AppSettings): Promise<void> {
    const parsed = appSettingsSchema.safeParse({ ...settings, model: settings.model.trim() });
    if (!parsed.success) {
      throw new Error('Invalid app settings.');
    }

    await this.#storage.set({ [SETTINGS_KEY]: parsed.data });
  }

  /**
   * Restores application defaults while preserving credentials in separate storage keys.
   */
  async reset(): Promise<AppSettings> {
    const defaults = { ...DEFAULT_APP_SETTINGS };
    await this.#storage.set({ [SETTINGS_KEY]: defaults });
    return defaults;
  }
}
