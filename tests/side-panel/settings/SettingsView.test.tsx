import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  SettingsView,
  type SettingsViewProps,
} from '../../../src/side-panel/settings/SettingsView';
import { DEFAULT_APP_SETTINGS } from '../../../src/persistence/settings-store';
import { createTranslator } from '../../../src/shared/i18n/i18n';
import type { SavePanelSettingsInput } from '../../../src/tasks/panel-service';

const settings = {
  ...DEFAULT_APP_SETTINGS,
  model: 'configured-model',
  reasoningEffort: 'medium',
  authPath: '/fixture/auth.json',
  hasAccessToken: true,
  hasTavilyKey: false,
};
const loaded = {
  ...settings,
  accessToken: 'manual-secret',
  tavilyKey: '',
  models: [
    {
      id: 'discovered-model',
      name: 'Discovered model',
      contextWindow: 100000,
      defaultReasoningEffort: 'deep',
      reasoningEfforts: ['fast', 'deep'],
    },
  ] as const,
};
const t = createTranslator('en');
const syncToken = async () => 'synced' as const;

describe('backend-driven settings', () => {
  it('does not reset an unsaved model when a snapshot repeats the provider catalog', async () => {
    const user = userEvent.setup();
    const onLoad = async () => loaded;
    const onSave = vi.fn(async () => undefined);
    const { rerender } = render(
      <SettingsView
        settings={{ ...settings, providers: [] }}
        t={t}
        onLoad={onLoad}
        onSave={onSave}
        onSyncToken={syncToken}
      />,
    );
    await screen.findByDisplayValue('manual-secret');
    const model = screen.getByRole('textbox', { name: 'Custom model' });
    await user.clear(model);
    await user.type(model, 'unsaved-model');
    rerender(
      <SettingsView
        settings={{ ...settings, providers: [] }}
        t={t}
        onLoad={onLoad}
        onSave={onSave}
        onSyncToken={syncToken}
      />,
    );
    expect(model).toHaveValue('unsaved-model');
  });

  it('selects registered provider defaults without carrying the previous provider secret', async () => {
    const user = userEvent.setup();
    const providers = ['first', 'second'].map((id) => ({
      id,
      name: id,
      defaults: {
        model: `${id}-model`,
        reasoningEffort: 'deep',
        authPath: `/${id}/auth`,
      },
    }));
    const onSave = vi.fn<(input: SavePanelSettingsInput) => Promise<void>>(async () => undefined);
    render(
      <SettingsView
        settings={{ ...settings, providerId: 'first', providers }}
        t={t}
        onLoad={async () => ({ ...loaded, providerId: 'first', providers })}
        onSave={onSave}
        onSyncToken={syncToken}
      />,
    );
    await screen.findByDisplayValue('manual-secret');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model provider' }), 'second');
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('second-model');
    expect(screen.getByLabelText('Reasoning effort')).toHaveValue('deep');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      providerId: 'second',
      model: 'second-model',
      authPath: '/second/auth',
    });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('accessToken');
  });

  it.each([{ models: [] }, { models: loaded.models }])(
    'keeps reasoning editable when the configured model is absent from the catalog ($models)',
    async ({ models }) => {
      const user = userEvent.setup();
      const onSave = vi.fn<(input: SavePanelSettingsInput) => Promise<void>>(async () => undefined);
      render(
        <SettingsView
          settings={settings}
          t={t}
          onLoad={async () => ({ ...loaded, models })}
          onSave={onSave}
          onSyncToken={syncToken}
        />,
      );
      await screen.findByDisplayValue('manual-secret');
      const effort = screen.getByRole('textbox', { name: 'Reasoning effort' });
      await user.clear(effort);
      await user.type(effort, 'high');
      await user.click(screen.getByRole('button', { name: 'Save settings' }));
      await waitFor(() =>
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({
            model: settings.model,
            reasoningEffort: 'high',
          }),
        ),
      );
    },
  );

  it('uses discovered model defaults and supported efforts while preserving an unlisted configured model', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<(input: SavePanelSettingsInput) => Promise<void>>(async () => undefined);
    const onLoad = async () => ({ ...loaded, models: [...loaded.models, ...loaded.models] });
    render(
      <SettingsView
        settings={settings}
        t={t}
        onLoad={onLoad}
        onSave={onSave}
        onSyncToken={syncToken}
      />,
    );
    const model = await screen.findByRole('combobox', { name: 'Model' });
    expect(model.tagName).toBe('SELECT');
    expect(screen.getAllByRole('option', { name: 'discovered-model' })).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Custom model' })).toHaveValue(settings.model);
    await user.selectOptions(model, 'discovered-model');
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('deep');
    expect(screen.queryByRole('option', { name: 'ultra' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'discovered-model',
          reasoningEffort: 'deep',
        }),
      ),
    );
  });

  it('keeps hidden models out of suggestions and uses metadata for an explicit selection', async () => {
    const user = userEvent.setup();
    const hidden = {
      ...loaded.models[0],
      id: 'hidden-model',
      hidden: true,
    };
    render(
      <SettingsView
        settings={settings}
        t={t}
        onLoad={async () => ({ ...loaded, models: [...loaded.models, hidden] })}
        onSave={async () => undefined}
        onSyncToken={syncToken}
      />,
    );
    await screen.findByDisplayValue('manual-secret');
    expect(screen.queryByRole('option', { name: hidden.id })).not.toBeInTheDocument();
    const model = screen.getByRole('textbox', { name: 'Custom model' });
    await user.clear(model);
    await user.type(model, hidden.id);
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('deep');
  });

  it('saves the Sandbox source and custom path without submitting the manual token', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn<(input: SavePanelSettingsInput) => Promise<void>>(async () => undefined);
    render(
      <SettingsView
        settings={settings}
        t={t}
        onLoad={async () => loaded}
        onSave={onSave}
        onSyncToken={syncToken}
      />,
    );
    await screen.findByDisplayValue('manual-secret');
    await user.click(screen.getByRole('radio', { name: 'Sync from Sandbox' }));
    const path = screen.getByLabelText('Sandbox authentication file');
    expect(path).toHaveValue('/fixture/auth.json');
    await user.clear(path);
    await user.type(path, '/private/auth custom.json');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      credentialSource: 'sandbox',
      authPath: '/private/auth custom.json',
    });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('accessToken');
  });

  it('syncs immediately on selection, shows a failure, and retries the edited path without saving', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);
    const onSyncToken = vi
      .fn<SettingsViewProps['onSyncToken']>(syncToken)
      .mockResolvedValueOnce('failed');
    render(
      <SettingsView
        settings={settings}
        t={t}
        onLoad={async () => loaded}
        onSave={onSave}
        onSyncToken={onSyncToken}
      />,
    );
    await screen.findByDisplayValue('manual-secret');
    await user.click(screen.getByRole('radio', { name: 'Sync from Sandbox' }));
    expect(await screen.findByText(/Token sync failed/)).toBeVisible();
    expect(onSyncToken).toHaveBeenCalledWith({ authPath: '/fixture/auth.json' });
    const path = screen.getByLabelText('Sandbox authentication file');
    await user.clear(path);
    await user.type(path, '/new/auth.json');
    await user.click(screen.getByRole('button', { name: 'Sync Token' }));
    expect(await screen.findByText('Token synced')).toBeVisible();
    expect(onSyncToken).toHaveBeenLastCalledWith({ authPath: '/new/auth.json' });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows a newer background failure after a successful manual sync of saved settings', async () => {
    const user = userEvent.setup();
    const onLoad = async () => loaded;
    const saved = {
      ...settings,
      credentialSource: 'sandbox' as const,
      credentialSyncStatus: 'synced' as const,
    };
    const props = { t, onLoad, onSave: async () => undefined, onSyncToken: syncToken };
    const { rerender } = render(<SettingsView {...props} settings={saved} />);
    await user.click(screen.getByRole('button', { name: 'Sync Token' }));
    expect(await screen.findByText('Token synced')).toBeVisible();
    rerender(<SettingsView {...props} settings={{ ...saved, credentialSyncStatus: 'failed' }} />);
    expect(screen.getByText(/Token sync failed/)).toBeVisible();
  });
});
