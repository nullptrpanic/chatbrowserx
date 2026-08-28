import { describe, expect, it } from 'vitest';
import { settingsTransferPayload } from '../../runner/settings-transfer';

describe('live settings transfer', () => {
  it('copies the execution settings and credentials needed by an isolated baseline build', () => {
    expect(
      settingsTransferPayload({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        systemPrompt: 'Keep browser actions bounded.',
        language: 'zh-CN',
        historyMessageLimit: 42,
        sandboxServer: 'https://sandbox.example.test',
        codexAccessToken: 'codex-test-token',
        tavilyKey: 'tavily-test-key',
        sandboxToken: 'sandbox-test-token',
        ignored: 'not copied',
      }),
    ).toEqual({
      reasoningEffort: 'high',
      systemPrompt: 'Keep browser actions bounded.',
      language: 'zh-CN',
      historyMessageLimit: 42,
      sandboxServer: 'https://sandbox.example.test',
      codexAccessToken: 'codex-test-token',
      tavilyKey: 'tavily-test-key',
      sandboxToken: 'sandbox-test-token',
    });
  });

  it('rejects a source extension without a Codex credential', () => {
    expect(() =>
      settingsTransferPayload({
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'system',
        historyMessageLimit: 50,
        codexAccessToken: '',
        tavilyKey: '',
      }),
    ).toThrow('Codex access token');
  });

  it('omits empty optional credentials rejected by the settings protocol', () => {
    expect(
      settingsTransferPayload({
        reasoningEffort: 'medium',
        systemPrompt: '',
        language: 'system',
        historyMessageLimit: 50,
        sandboxServer: '',
        codexAccessToken: 'codex-test-token',
        tavilyKey: '',
        sandboxToken: '',
      }),
    ).toEqual({
      reasoningEffort: 'medium',
      systemPrompt: '',
      language: 'system',
      historyMessageLimit: 50,
      sandboxServer: '',
      codexAccessToken: 'codex-test-token',
    });
  });
});
