import { Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CredentialSyncSelection, CredentialSyncStatus } from '../../providers/provider';
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
  readonly onSyncToken: (selection: CredentialSyncSelection) => Promise<CredentialSyncStatus>;
}

/** Renders registered provider settings plus the optional Sandbox connection. */
export function SettingsView({ settings, t, onLoad, onSave, onSyncToken }: SettingsViewProps) {
  const [providerId, setProviderId] = useState(settings.providerId ?? '');
  const providers = settings.providers ?? [];
  const [activeTab, setActiveTab] = useState<'general' | 'sandbox'>('general');
  const [model, setModel] = useState(settings.model);
  const [editingCustomModel, setEditingCustomModel] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState(settings.reasoningEffort);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [language, setLanguage] = useState(settings.language);
  const [accessToken, setAccessToken] = useState('');
  const [credentialSource, setCredentialSource] = useState(settings.credentialSource ?? 'manual');
  const [authPath, setAuthPath] = useState(settings.authPath ?? '');
  const [models, setModels] = useState<NonNullable<PanelEditableSettings['models']>>([]);
  const [modelDiscoveryFailed, setModelDiscoveryFailed] = useState(false);
  const [sandboxServer, setSandboxServer] = useState(settings.sandboxServer ?? '');
  const [sandboxToken, setSandboxToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loadFailed, setLoadFailed] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    readonly status: CredentialSyncStatus | 'syncing';
    readonly snapshot?: PanelSettingsSnapshot;
  } | null>(null);
  const syncRequest = useRef(0);
  const visibleModelIds = [
    ...new Set(models.filter((item) => !item.hidden).map((item) => item.id)),
  ];
  const customModel = editingCustomModel || !visibleModelIds.includes(model);
  const supportedEfforts = models.find((item) => item.id === model)?.reasoningEfforts;
  const savedCredential =
    settings.credentialSource === 'sandbox' &&
    providerId === (settings.providerId ?? '') &&
    authPath.trim() === (settings.authPath ?? '');
  const localSyncStatus =
    !syncResult?.snapshot || syncResult.snapshot === settings ? syncResult?.status : undefined;
  const syncStatus =
    localSyncStatus ?? (savedCredential ? settings.credentialSyncStatus : undefined) ?? 'idle';

  useEffect(() => {
    setProviderId(settings.providerId ?? '');
    setModel(settings.model);
    setEditingCustomModel(false);
    setReasoningEffort(settings.reasoningEffort);
    setSystemPrompt(settings.systemPrompt);
    setLanguage(settings.language);
    setCredentialSource(settings.credentialSource ?? 'manual');
    setAuthPath(settings.authPath ?? '');
    setSandboxServer(settings.sandboxServer ?? '');
  }, [
    settings.providerId,
    settings.credentialSource,
    settings.authPath,
    settings.language,
    settings.model,
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
        setAccessToken(loaded.accessToken);
        setModels(loaded.models ?? []);
        setModelDiscoveryFailed(loaded.modelDiscoveryFailed ?? false);
        setSandboxToken(loaded.sandboxToken ?? '');
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [onLoad]);

  function clearSyncResult(): void {
    syncRequest.current++;
    setSyncResult(null);
  }

  function selectModel(value: string): void {
    setModel(value);
    const selected = models.find((item) => item.id === value);
    if (selected) setReasoningEffort(selected.defaultReasoningEffort);
  }

  async function syncToken(): Promise<void> {
    const request = ++syncRequest.current;
    setSyncResult({ status: 'syncing' });
    const result = await onSyncToken({
      ...(providerId ? { providerId } : {}),
      authPath: authPath.trim(),
    }).catch(() => 'failed' as const);
    if (request === syncRequest.current) {
      // For saved settings, subsequent background snapshots own the latest status.
      setSyncResult({ status: result, ...(savedCredential ? { snapshot: settings } : {}) });
    }
  }

  /** Saves the visible settings while omitting credential fields the user leaves blank. */
  async function save(): Promise<void> {
    setLoadFailed(false);
    setStatus('saving');
    const input: SavePanelSettingsInput = {
      ...(providerId ? { providerId } : {}),
      model: model.trim(),
      reasoningEffort,
      systemPrompt,
      language,
      credentialSource: credentialSource,
      authPath: authPath.trim(),
      sandboxServer: sandboxServer.trim(),
      ...(credentialSource !== 'manual' || accessToken.trim().length === 0
        ? {}
        : { accessToken: accessToken.trim() }),
      ...(sandboxToken.trim().length === 0 ? {} : { sandboxToken: sandboxToken.trim() }),
    };
    try {
      await onSave(input);
      const loaded = await onLoad();
      setModels(loaded.models ?? []);
      setModelDiscoveryFailed(loaded.modelDiscoveryFailed ?? false);
      clearSyncResult();
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
            {providers.length > 1 ? (
              <label className="form-field" htmlFor="model-provider">
                <span>{t('modelProvider')}</span>
                <select
                  id="model-provider"
                  value={providerId}
                  onChange={(event) => {
                    const selected = providers.find(
                      (provider) => provider.id === event.target.value,
                    );
                    if (!selected) return;
                    setProviderId(selected.id);
                    setModel(selected.defaults.model);
                    setEditingCustomModel(false);
                    setReasoningEffort(selected.defaults.reasoningEffort);
                    setAuthPath(selected.defaults.authPath);
                    setCredentialSource('manual');
                    setAccessToken('');
                    setModels([]);
                    clearSyncResult();
                  }}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <fieldset className="form-field credential-source">
              <legend>{t('credentialSource')}</legend>
              <label>
                <input
                  type="radio"
                  name="credential-source"
                  checked={credentialSource === 'sandbox'}
                  onChange={() => {
                    setCredentialSource('sandbox');
                    void syncToken();
                  }}
                />
                {t('credentialSandbox')}
              </label>
              <label>
                <input
                  type="radio"
                  name="credential-source"
                  checked={credentialSource === 'manual'}
                  onChange={() => {
                    setCredentialSource('manual');
                    clearSyncResult();
                  }}
                />
                {t('credentialManual')}
              </label>
            </fieldset>
            {credentialSource === 'sandbox' ? (
              <div className="form-field">
                <label className="form-field" htmlFor="provider-auth-path">
                  <span>{t('credentialPath')}</span>
                  <input
                    id="provider-auth-path"
                    aria-label={t('credentialPath')}
                    value={authPath}
                    required
                    maxLength={4096}
                    spellCheck={false}
                    onChange={(event) => {
                      setAuthPath(event.target.value);
                      clearSyncResult();
                    }}
                  />
                  <small>{t('credentialSandboxHint')}</small>
                </label>
                <div className="credential-sync-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={syncStatus === 'syncing' || status === 'saving'}
                    onClick={() => void syncToken()}
                  >
                    {t('credentialSyncToken')}
                  </button>
                  <small className={`credential-sync-status is-${syncStatus}`} role="status">
                    {syncStatus === 'syncing'
                      ? t('credentialSyncing')
                      : syncStatus === 'synced'
                        ? t('credentialSynced')
                        : syncStatus === 'failed'
                          ? t('credentialSyncFailed')
                          : ''}
                  </small>
                </div>
              </div>
            ) : (
              <SecretField
                id="provider-access-token"
                label={t('providerToken')}
                hint={
                  settings.hasAccessToken && providerId === (settings.providerId ?? '')
                    ? t('tokenStored')
                    : t('providerToken')
                }
                value={accessToken}
                onChange={setAccessToken}
                t={t}
              />
            )}
            {visibleModelIds.length > 0 ? (
              <label className="form-field" htmlFor="model">
                <span>{t('model')}</span>
                <select
                  id="model"
                  value={customModel ? '' : model}
                  onChange={(event) => {
                    const value = event.target.value;
                    setEditingCustomModel(value === '');
                    if (value) selectModel(value);
                  }}
                >
                  {visibleModelIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                  <option value="">{t('customModelOption')}</option>
                </select>
              </label>
            ) : null}
            {visibleModelIds.length === 0 || customModel ? (
              <label className="form-field" htmlFor="custom-model">
                <span>{t(visibleModelIds.length === 0 ? 'model' : 'customModel')}</span>
                <input
                  id="custom-model"
                  value={model}
                  required
                  maxLength={256}
                  spellCheck={false}
                  onChange={(event) => {
                    setEditingCustomModel(true);
                    selectModel(event.target.value);
                  }}
                />
              </label>
            ) : null}
            {modelDiscoveryFailed ? (
              <div className="form-field">
                <small role="status">{t('modelDiscoveryFailed')}</small>
              </div>
            ) : null}
            <label className="form-field" htmlFor="reasoning-effort">
              <span>{t('reasoningEffort')}</span>
              {supportedEfforts?.length ? (
                <select
                  id="reasoning-effort"
                  value={reasoningEffort}
                  onChange={(event) => setReasoningEffort(event.target.value)}
                >
                  {[...new Set([...supportedEfforts, reasoningEffort])].map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id="reasoning-effort"
                  value={reasoningEffort}
                  required
                  maxLength={64}
                  spellCheck={false}
                  onChange={(event) => setReasoningEffort(event.target.value)}
                />
              )}
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
