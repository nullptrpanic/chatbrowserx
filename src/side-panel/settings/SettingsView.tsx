import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type { PanelSettingsSnapshot } from '../../shared/protocol/panel-types';
import type { SavePanelSettingsInput } from '../../tasks/panel-service';
import { SecretField } from './SecretField';

export interface SettingsViewProps {
  readonly settings: PanelSettingsSnapshot;
  readonly t: Translator;
  readonly onSave: (input: SavePanelSettingsInput) => Promise<unknown>;
}

/** Renders the fixed Codex/Tavily settings surface without generic Provider or Base URL fields. */
export function SettingsView({ settings, t, onSave }: SettingsViewProps) {
  const [reasoningEffort, setReasoningEffort] = useState(settings.reasoningEffort);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [language, setLanguage] = useState(settings.language);
  const [codexAccessToken, setCodexAccessToken] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    setReasoningEffort(settings.reasoningEffort);
    setSystemPrompt(settings.systemPrompt);
    setLanguage(settings.language);
  }, [settings.language, settings.reasoningEffort, settings.systemPrompt]);

  /** Saves the visible settings while omitting untouched credential fields. */
  async function save(): Promise<void> {
    setStatus('saving');
    const input: SavePanelSettingsInput = {
      reasoningEffort,
      systemPrompt,
      language,
      ...(codexAccessToken.trim().length === 0
        ? {}
        : { codexAccessToken: codexAccessToken.trim() }),
      ...(tavilyKey.trim().length === 0 ? {} : { tavilyKey: tavilyKey.trim() }),
    };
    try {
      await onSave(input);
      setCodexAccessToken('');
      setTavilyKey('');
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }

  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <div className="view-heading">
        <div>
          <span className="eyebrow">ChatBrowserX</span>
          <h1 id="settings-title">{t('settingsTitle')}</h1>
        </div>
      </div>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <SecretField
          id="codex-access-token"
          label={t('codexToken')}
          hint={settings.hasCodexToken ? t('tokenStored') : t('codexToken')}
          value={codexAccessToken}
          onChange={setCodexAccessToken}
          t={t}
        />
        <SecretField
          id="tavily-key"
          label={t('tavilyKey')}
          hint={settings.hasTavilyKey ? t('tavilyStored') : t('tavilyKey')}
          value={tavilyKey}
          onChange={setTavilyKey}
          t={t}
        />
        <label className="form-field" htmlFor="model">
          <span>{t('model')}</span>
          <input id="model" value={settings.model} readOnly />
        </label>
        <label className="form-field" htmlFor="reasoning-effort">
          <span>{t('reasoningEffort')}</span>
          <select
            id="reasoning-effort"
            value={reasoningEffort}
            onChange={(event) =>
              setReasoningEffort(event.target.value as PanelSettingsSnapshot['reasoningEffort'])
            }
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">XHigh</option>
          </select>
        </label>
        <label className="form-field" htmlFor="system-prompt">
          <span>{t('systemPrompt')}</span>
          <textarea
            id="system-prompt"
            value={systemPrompt}
            maxLength={20_000}
            rows={5}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor="language">
          <span>{t('language')}</span>
          <select
            id="language"
            value={language}
            onChange={(event) =>
              setLanguage(event.target.value as PanelSettingsSnapshot['language'])
            }
          >
            <option value="system">{t('languageSystem')}</option>
            <option value="zh-CN">{t('languageChinese')}</option>
            <option value="en">{t('languageEnglish')}</option>
            <option value="ja">{t('languageJapanese')}</option>
          </select>
        </label>
        <div className="settings-actions">
          <span className={`settings-save-status is-${status}`} role="status">
            {status === 'saved'
              ? t('settingsSaved')
              : status === 'error'
                ? t('settingsSaveFailed')
                : ''}
          </span>
          <button type="submit" className="primary-button" disabled={status === 'saving'}>
            <Save size={15} /> {t('saveSettings')}
          </button>
        </div>
      </form>
    </section>
  );
}
