import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Translator } from '../../shared/i18n/i18n';
import type {
  PanelEditableSettings,
  PanelSettingsSnapshot,
} from '../../shared/protocol/panel-types';
import type { SavePanelSettingsInput } from '../../tasks/panel-service';
import { SecretField } from './SecretField';

export interface SettingsViewProps {
  readonly settings: PanelSettingsSnapshot;
  readonly t: Translator;
  readonly onLoad: () => Promise<PanelEditableSettings>;
  readonly onSave: (input: SavePanelSettingsInput) => Promise<unknown>;
}

/** Renders the fixed Codex settings surface plus the optional Sandbox connection. */
export function SettingsView({ settings, t, onLoad, onSave }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'sandbox'>('general');
  const [reasoningEffort, setReasoningEffort] = useState(settings.reasoningEffort);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [language, setLanguage] = useState(settings.language);
  const [historyMessageLimit, setHistoryMessageLimit] = useState(settings.historyMessageLimit);
  const [codexAccessToken, setCodexAccessToken] = useState('');
  const [tavilyKey, setTavilyKey] = useState('');
  const [sandboxServer, setSandboxServer] = useState(settings.sandboxServer ?? '');
  const [sandboxToken, setSandboxToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setReasoningEffort(settings.reasoningEffort);
    setSystemPrompt(settings.systemPrompt);
    setLanguage(settings.language);
    setHistoryMessageLimit(settings.historyMessageLimit);
    setSandboxServer(settings.sandboxServer ?? '');
  }, [
    settings.historyMessageLimit,
    settings.language,
    settings.reasoningEffort,
    settings.sandboxServer,
    settings.systemPrompt,
  ]);

  useEffect(() => {
    let active = true;
    void onLoad()
      .then((loaded) => {
        if (!active) return;
        setLoadFailed(false);
        setReasoningEffort(loaded.reasoningEffort);
        setSystemPrompt(loaded.systemPrompt);
        setLanguage(loaded.language);
        setHistoryMessageLimit(loaded.historyMessageLimit);
        setCodexAccessToken(loaded.codexAccessToken);
        setTavilyKey(loaded.tavilyKey);
        setSandboxServer(loaded.sandboxServer ?? '');
        setSandboxToken(loaded.sandboxToken ?? '');
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [onLoad]);

  /** Saves the visible settings while omitting credential fields the user leaves blank. */
  async function save(): Promise<void> {
    setLoadFailed(false);
    setStatus('saving');
    const input: SavePanelSettingsInput = {
      reasoningEffort,
      systemPrompt,
      language,
      historyMessageLimit,
      sandboxServer: sandboxServer.trim(),
      ...(codexAccessToken.trim().length === 0
        ? {}
        : { codexAccessToken: codexAccessToken.trim() }),
      ...(tavilyKey.trim().length === 0 ? {} : { tavilyKey: tavilyKey.trim() }),
      ...(sandboxToken.trim().length === 0 ? {} : { sandboxToken: sandboxToken.trim() }),
    };
    try {
      await onSave(input);
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
        <div className="settings-tabs" role="tablist" aria-label={t('settingsTitle')}>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'general'}
            aria-controls="general-settings-panel"
            className={activeTab === 'general' ? 'is-active' : undefined}
            onClick={() => setActiveTab('general')}
          >
            {t('settingsGeneralTab')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'sandbox'}
            aria-controls="sandbox-settings-panel"
            className={activeTab === 'sandbox' ? 'is-active' : undefined}
            onClick={() => setActiveTab('sandbox')}
          >
            {t('settingsSandboxTab')}
          </button>
        </div>
        {activeTab === 'general' ? (
          <div id="general-settings-panel" className="settings-tab-panel" role="tabpanel">
            <SecretField
              id="codex-access-token"
              label={t('codexToken')}
              hint={settings.hasCodexToken ? t('tokenStored') : t('codexToken')}
              value={codexAccessToken}
              onChange={setCodexAccessToken}
              t={t}
            />
            <SecretField
              id="tavily-api-key"
              label={t('tavilyKey')}
              hint={settings.hasTavilyKey ? t('tokenStored') : t('tavilyKey')}
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
            <label className="form-field" htmlFor="history-message-limit">
              <span>{t('historyMessageLimit')}</span>
              <input
                id="history-message-limit"
                type="number"
                min={1}
                max={50}
                step={1}
                value={historyMessageLimit}
                aria-label={t('historyMessageLimit')}
                onChange={(event) => setHistoryMessageLimit(Number(event.target.value))}
              />
              <small>{t('historyMessageLimitHint')}</small>
            </label>
          </div>
        ) : (
          <div id="sandbox-settings-panel" className="settings-tab-panel" role="tabpanel">
            <label className="form-field" htmlFor="sandbox-server">
              <span>{t('sandboxServer')}</span>
              <input
                id="sandbox-server"
                aria-label={t('sandboxServer')}
                type="url"
                maxLength={2_048}
                value={sandboxServer}
                placeholder="https://sandbox.example.com"
                spellCheck={false}
                onChange={(event) => setSandboxServer(event.target.value)}
              />
              <small>{t('sandboxServerHint')}</small>
            </label>
            <SecretField
              id="sandbox-token"
              label={t('sandboxToken')}
              hint={settings.hasSandboxToken ? t('tokenStored') : t('sandboxToken')}
              value={sandboxToken}
              onChange={setSandboxToken}
              t={t}
            />
          </div>
        )}
        <div className="settings-actions">
          <span
            className={`settings-save-status is-${loadFailed ? 'error' : status}`}
            role="status"
          >
            {loadFailed
              ? t('settingsLoadFailed')
              : status === 'saved'
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
