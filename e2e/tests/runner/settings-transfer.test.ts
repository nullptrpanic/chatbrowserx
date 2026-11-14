import { describe, expect, it } from 'vitest';
import { settingsTransferPayload } from '../../runner/settings-transfer';

describe('live settings transfer', () => {
  it.each(['max', 'ultra', 'provider-specific'])(
    'preserves provider effort %s for isolated builds',
    (reasoningEffort) => {
      expect(
        settingsTransferPayload({
          reasoningEffort,
          systemPrompt: '',
          language: 'en',
          historyMessageLimit: 50,
          accessToken: 'codex-test-token',
          tavilyKey: '',
        }),
      ).toMatchObject({ reasoningEffort });
    },
  );

  it('copies the execution settings and credentials needed by an isolated baseline build', () => {
    expect(
      settingsTransferPayload({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        systemPrompt: 'Keep browser actions bounded.',
        language: 'zh-CN',
        historyMessageLimit: 42,
        sandboxServer: 'https://sandbox.example.test',
        accessToken: 'codex-test-token',
        tavilyKey: 'tavily-test-key',
        sandboxToken: 'sandbox-test-token',
        ignored: 'not copied',
      }),
    ).toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'high',
      systemPrompt: 'Keep browser actions bounded.',
      language: 'zh-CN',
      historyMessageLimit: 42,
      sandboxServer: 'https://sandbox.example.test',
      accessToken: 'codex-test-token',
      tavilyKey: 'tavily-test-key',
      sandboxToken: 'sandbox-test-token',
    });
  });

  it('rejects a source extension without a model credential', () => {
    expect(() =>
      settingsTransferPayload({
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'system',
        historyMessageLimit: 50,
        accessToken: '',
        tavilyKey: '',
      }),
    ).toThrow('model access token');
  });

  it('preserves Sandbox authentication without requiring a manual model token', () => {
    expect(
      settingsTransferPayload({
        providerId: 'fixture',
        model: 'fixture-model',
        reasoningEffort: 'deep',
        systemPrompt: '',
        language: 'en',
        historyMessageLimit: 50,
        credentialSource: 'sandbox',
        authPath: '/private/fixture.json',
        sandboxServer: 'https://sandbox.example.test',
        sandboxToken: 'fixture-sandbox-token',
        accessToken: '',
        tavilyKey: '',
      }),
    ).toEqual({
      providerId: 'fixture',
      model: 'fixture-model',
      reasoningEffort: 'deep',
      systemPrompt: '',
      language: 'en',
      historyMessageLimit: 50,
      credentialSource: 'sandbox',
      authPath: '/private/fixture.json',
      sandboxServer: 'https://sandbox.example.test',
      sandboxToken: 'fixture-sandbox-token',
    });
  });

  it('omits empty optional credentials rejected by the settings protocol', () => {
    expect(
      settingsTransferPayload({
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'system',
        historyMessageLimit: 50,
        sandboxServer: '',
        accessToken: 'codex-test-token',
        tavilyKey: '',
        sandboxToken: '',
      }),
    ).toEqual({
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'system',
      historyMessageLimit: 50,
      sandboxServer: '',
      accessToken: 'codex-test-token',
    });
  });
});
