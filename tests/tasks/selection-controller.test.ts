import { describe, expect, it, vi } from 'vitest';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import type { ModelProvider, ModelRequest } from '../../src/providers/provider-types';
import type { ModelStreamEvent } from '../../src/providers/stream-events';
import {
  SelectionController,
  SelectionControllerError,
} from '../../src/tasks/selection-controller';

const input = {
  text: 'A careful translation',
  pageUrl: 'https://example.com/article',
  pageTitle: 'Article',
};

/** Builds a complete text-only provider stream while retaining the normalized request. */
function buildProvider(events?: readonly ModelStreamEvent[]) {
  let request: ModelRequest | undefined;
  const streamEvents =
    events ??
    ([
      { type: 'response.started', responseId: 'response_1' },
      { type: 'text.delta', delta: '谨慎的' },
      { type: 'text.delta', delta: '翻译' },
      { type: 'response.completed', responseId: 'response_1', usage: null },
    ] satisfies readonly ModelStreamEvent[]);
  const provider: ModelProvider = {
    async *stream(value) {
      request = value;
      yield* streamEvents;
    },
  };
  return { provider, getRequest: () => request };
}

/** Builds the trusted background-only dependencies used by selection commands. */
function buildDependencies(provider: ModelProvider) {
  return {
    provider,
    settings: {
      get: vi.fn(async () => ({
        model: 'gpt-5.6-terra' as const,
        reasoningEffort: 'medium' as const,
        systemPrompt: '',
        language: 'zh-CN' as const,
      })),
    },
    panel: {
      getSnapshot: vi.fn(
        async (): Promise<{
          conversation: { id: string } | null;
          task: { status: string } | null;
        }> => ({ conversation: { id: 'conversation_1' }, task: null }),
      ),
      submit: vi.fn(async () => ({ task: { id: 'task_1' } })),
    },
    sidePanel: { open: vi.fn(async () => undefined) },
  };
}

describe('SelectionController', () => {
  it('runs a bounded text-only translation turn without browser or search tools', async () => {
    const provider = buildProvider();
    const controller = new SelectionController(buildDependencies(provider.provider));

    await expect(controller.translate(input)).resolves.toEqual({ text: '谨慎的翻译' });
    expect(provider.getRequest()).toMatchObject({
      reasoningEffort: 'medium',
      tools: [],
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: expect.stringContaining(input.text) }],
        },
      ],
    });
    expect(provider.getRequest()?.systemPrompt).toContain('Output only the translation');
  });

  it('opens the panel immediately and submits a quoted selection into the active conversation', async () => {
    const provider = buildProvider();
    const dependencies = buildDependencies(provider.provider);
    const controller = new SelectionController(dependencies);

    await controller.ask({ ...input, tabId: 7, question: 'What does this imply?' });

    expect(dependencies.sidePanel.open).toHaveBeenCalledWith({ tabId: 7 });
    expect(dependencies.panel.getSnapshot).toHaveBeenCalledWith(7);
    expect(dependencies.panel.submit).toHaveBeenCalledWith({
      tabId: 7,
      conversationId: 'conversation_1',
      attachmentIds: [],
      text: expect.stringMatching(/> A careful translation[\s\S]*What does this imply\?/),
    });
    expect(dependencies.sidePanel.open.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.panel.getSnapshot.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('maps authentication failures to a recoverable redacted page error', async () => {
    const provider: ModelProvider = {
      async *stream() {
        throw providerErrorFromCode('AUTH');
        yield* [];
      },
    };
    const controller = new SelectionController(buildDependencies(provider));

    await expect(controller.translate({ ...input, text: 'token-secret' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    await expect(controller.translate(input)).rejects.not.toThrow('token-secret');
    expect(new SelectionControllerError('AUTH_REQUIRED').message).not.toContain('token');
  });

  it('starts a separate conversation when selected-text Ask AI finds unfinished work', async () => {
    const provider = buildProvider();
    const dependencies = buildDependencies(provider.provider);
    dependencies.panel.getSnapshot.mockResolvedValueOnce({
      conversation: { id: 'conversation_1' },
      task: { status: 'waiting_for_confirmation' },
    });
    const controller = new SelectionController(dependencies);

    await controller.ask({ ...input, tabId: 7, question: '' });

    expect(dependencies.panel.submit).toHaveBeenCalledWith(
      expect.not.objectContaining({ conversationId: expect.anything() }),
    );
  });
});
