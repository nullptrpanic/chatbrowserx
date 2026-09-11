import { describe, expect, it, vi } from 'vitest';
import { TranslationController } from '../../src/translation/translation-controller';
import { DEFAULT_APP_SETTINGS } from '../../src/persistence/settings-store';

const selection = {
  sessionId: 'wrong',
  devicePixelRatio: 1,
  viewportWidth: 800,
  viewportHeight: 600,
  rect: { x: 0, y: 0, width: 300, height: 200 },
};

describe('translation authorization', () => {
  it('delivers text previews to their originating request without waiting on page delivery', async () => {
    const updates: unknown[] = [];
    let calls = 0;
    const first = { id: 'p', translation: '第一段' };
    const second = { id: 'q', translation: '第二段' };
    const controller = new TranslationController({
      getSession: async () => 's',
      toggle: async () => false,
      capture: vi.fn(),
      settings: { get: async () => DEFAULT_APP_SETTINGS },
      progress: (tabId, value) => {
        updates.push({ tabId, ...value });
        return new Promise(() => {});
      },
      provider: {
        async *stream() {
          calls++;
          yield { type: 'text.delta' as const, delta: '{"blocks":[' + JSON.stringify(first) };
          expect(updates).toEqual([
            {
              tabId: 7,
              version: 1,
              type: 'translation.progress',
              sessionId: 's',
              requestId: 'text-1',
              result: { blocks: [first] },
            },
          ]);
          yield { type: 'text.delta' as const, delta: ',' + JSON.stringify(second) + ']}' };
          yield { type: 'response.completed' as const, responseId: 'r', usage: null };
        },
      },
    });
    const result = await controller.read(
      7,
      {
        sessionId: 's',
        texts: [
          { id: 'p', text: 'First.' },
          { id: 'q', text: 'Second.' },
        ],
      },
      'text-1',
    );
    expect(result).toEqual({
      blocks: [first, second],
      cacheKey: '["gpt-5.6-terra","medium","en"]',
    });
    expect(calls).toBe(1);
  });

  it('sends correlated colored previews before completion without making another model request', async () => {
    const updates: unknown[] = [];
    const bitmap = { width: 300, height: 200, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', async () => bitmap);
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage() {}, getImageData: () => ({ data: [240, 240, 240, 255] }) };
        }
      },
    );
    const block = { text: 'Save', translation: '保存', box: [100, 200, 300, 40] };
    let calls = 0;
    try {
      const controller = new TranslationController({
        getSession: async () => 's',
        toggle: async () => false,
        capture: async () => new Blob(),
        settings: { get: async () => DEFAULT_APP_SETTINGS },
        progress: async (tabId, value) => {
          updates.push({ tabId, ...value });
        },
        provider: {
          async *stream() {
            calls++;
            yield { type: 'text.delta' as const, delta: '{"blocks":[' + JSON.stringify(block) };
            expect(updates).toEqual([
              {
                tabId: 7,
                version: 1,
                type: 'translation.progress',
                sessionId: 's',
                requestId: 'read-1',
                result: {
                  incomplete: true,
                  blocks: [block],
                  colors: [{ background: 'rgb(240,240,240)', color: '#172642' }],
                },
              },
            ]);
            yield { type: 'text.delta' as const, delta: ']}' };
            yield { type: 'response.completed' as const, responseId: 'r', usage: null };
          },
        },
      });
      const result = await controller.read(7, { ...selection, sessionId: 's' }, 'read-1');
      expect(result).toEqual({
        blocks: [block],
        cacheKey: '["gpt-5.6-terra","medium","en"]',
        colors: [{ background: 'rgb(240,240,240)', color: '#172642' }],
      });
      expect(calls).toBe(1);
      expect(updates).toHaveLength(1);
      expect(bitmap.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps two text requests independent, bounds admission, and cancels both on close', async () => {
    const pending: { signal: AbortSignal; finish: () => void }[] = [];
    const controller = new TranslationController({
      getSession: async () => 's',
      toggle: async () => false,
      capture: vi.fn(),
      settings: { get: async () => DEFAULT_APP_SETTINGS },
      provider: {
        async *stream(_request, signal) {
          await new Promise<void>((resolve, reject) => {
            pending.push({ signal, finish: resolve });
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          yield {
            type: 'text.delta' as const,
            delta: '{"blocks":[{"id":"p","translation":"完成"}]}',
          };
          yield { type: 'response.completed' as const, responseId: 'r', usage: null };
        },
      },
    });
    const input = { sessionId: 's', texts: [{ id: 'p', text: 'Paragraph' }] };
    const first = controller.read(7, input).catch((error) => error);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = controller
      .read(7, { ...input, texts: [{ id: 'q', text: 'New paragraph' }] })
      .catch((error) => error);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    try {
      expect(pending.map((p) => p.signal.aborted)).toEqual([false, false]);
      await expect(controller.read(7, input)).rejects.toMatchObject({ code: 'TRANSLATION_BUSY' });
      await expect(controller.read(7, { ...input, sessionId: 'old' })).rejects.toThrow();
      expect(pending.map((p) => p.signal.aborted)).toEqual([false, false]);
    } finally {
      controller.cancel(7, 's');
      await Promise.all([first, second]);
    }
    expect(pending.map((p) => p.signal.aborted)).toEqual([true, true]);
    const next = controller.read(7, input);
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2]?.finish();
    expect(await next).toEqual({
      blocks: [{ id: 'p', translation: '完成' }],
      cacheKey: '["gpt-5.6-terra","medium","en"]',
    });
  });
  it('lets text and pixels finish independently and cancels both when the session closes', async () => {
    let textSignal: AbortSignal | undefined;
    let pixelSignal: AbortSignal | undefined;
    const controller = new TranslationController({
      getSession: async () => 's',
      toggle: async () => false,
      settings: { get: async () => DEFAULT_APP_SETTINGS },
      capture: async (_tab, _selection, signal) => {
        pixelSignal = signal;
        return new Promise<Blob>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
      provider: {
        async *stream(_request, signal) {
          textSignal = signal;
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
          yield { type: 'response.completed' as const, responseId: 'r', usage: null };
        },
      },
    });
    const text = expect(
      controller.read(7, {
        sessionId: 's',
        texts: [{ id: 'p', text: 'Hello' }],
      }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(textSignal).toBeDefined());
    const pixels = expect(controller.read(7, { ...selection, sessionId: 's' })).rejects.toThrow();
    await vi.waitFor(() => expect(pixelSignal).toBeDefined());
    try {
      expect(textSignal?.aborted).toBe(false);
      expect(pixelSignal?.aborted).toBe(false);
      controller.cancel(7, 's', false, 'pixels');
      expect(pixelSignal?.aborted).toBe(true);
      expect(textSignal?.aborted).toBe(false);
    } finally {
      controller.cancel(7, 's');
      await Promise.all([text, pixels]);
    }
  });

  it.each(['low', 'medium', 'high', 'xhigh'] as const)(
    'translates source text using configured effort %s without capturing pixels',
    async (reasoningEffort) => {
      const requests: unknown[] = [];
      const capture = vi.fn();
      const controller = new TranslationController({
        getSession: async () => 's',
        toggle: async () => false,
        capture,
        settings: {
          get: async () => ({
            ...DEFAULT_APP_SETTINGS,
            model: 'custom-model',
            reasoningEffort,
            language: 'zh-CN' as const,
          }),
        },
        provider: {
          async *stream(request) {
            requests.push(request);
            yield {
              type: 'text.delta' as const,
              delta: '{"blocks":[{"id":"p","translation":"完整段落。"}]}',
            };
            yield { type: 'response.completed' as const, responseId: 'r', usage: null };
          },
        },
      });
      const input = { sessionId: 's', texts: [{ id: 'p', text: 'A complete paragraph.' }] };
      expect(await controller.read(7, input)).toEqual({
        blocks: [{ id: 'p', translation: '完整段落。' }],
        cacheKey: JSON.stringify(['custom-model', reasoningEffort, 'zh-CN']),
      });
      expect(capture).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: 'custom-model',
        reasoningEffort,
        tools: [],
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({ language: 'zh-CN', texts: input.texts }),
              },
            ],
          },
        ],
      });
      await expect(controller.read(7, { ...input, sessionId: 'other' })).rejects.toThrow(
        'not enabled',
      );
      expect(requests).toHaveLength(1);
    },
  );

  it('uses the latest configured effort for each image request in the same session', async () => {
    const requests: unknown[] = [];
    const settings = {
      get: vi.fn().mockResolvedValue({ ...DEFAULT_APP_SETTINGS, reasoningEffort: 'high' }),
    };
    const bitmap = { width: 300, height: 200, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', async () => bitmap);
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext() {
          return { drawImage() {} };
        }
      },
    );
    try {
      const controller = new TranslationController({
        getSession: async () => 's',
        toggle: async () => false,
        capture: async () => new Blob(),
        settings,
        provider: {
          async *stream(request) {
            requests.push(request);
            yield { type: 'text.delta' as const, delta: '{"blocks":[]}' };
            yield { type: 'response.completed' as const, responseId: 'r', usage: null };
          },
        },
      });
      await controller.read(7, { ...selection, sessionId: 's' });
      settings.get.mockResolvedValue({ ...DEFAULT_APP_SETTINGS, reasoningEffort: 'medium' });
      await controller.read(7, { ...selection, sessionId: 's' });
      expect(requests).toMatchObject([
        { model: DEFAULT_APP_SETTINGS.model, reasoningEffort: 'high', tools: [] },
        { model: DEFAULT_APP_SETTINGS.model, reasoningEffort: 'medium', tools: [] },
      ]);
      expect(bitmap.close).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { blocks: [] },
    {
      blocks: [
        { id: 'p', translation: '完整' },
        { id: 'p', translation: '重复' },
      ],
    },
    { blocks: [{ id: 'unknown', translation: '错误' }] },
  ])(
    'does not treat missing or duplicated text results as a complete translation: %j',
    async ({ blocks }) => {
      const controller = new TranslationController({
        getSession: async () => 's',
        toggle: async () => false,
        capture: async () => {
          throw new Error('Text unexpectedly captured pixels');
        },
        settings: { get: async () => DEFAULT_APP_SETTINGS },
        provider: {
          async *stream() {
            yield { type: 'text.delta' as const, delta: JSON.stringify({ blocks }) };
            yield { type: 'response.completed' as const, responseId: 'r', usage: null };
          },
        },
      });
      await expect(
        controller.read(7, { sessionId: 's', texts: [{ id: 'p', text: 'Complete.' }] }),
      ).rejects.toThrow('Incomplete translation');
    },
  );
  it('rejects inspection for an unowned session without capturing or calling the model', async () => {
    const capture = vi.fn(),
      stream = vi.fn();
    const controller = new TranslationController({
      getSession: async () => 'actual',
      toggle: async () => false,
      capture,
      provider: { stream },
      settings: { get: async () => DEFAULT_APP_SETTINGS },
    });
    await expect(controller.inspect(7, selection)).rejects.toThrow('not enabled');
    expect(capture).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('keeps inspection independent of model cancellation and aborts both on close', async () => {
    const signals: AbortSignal[] = [];
    const controller = new TranslationController({
      getSession: async () => 's',
      toggle: async () => false,
      capture: async (_tab, _selection, signal) => {
        signals.push(signal);
        return new Promise<Blob>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
      provider: { stream: vi.fn() },
      settings: { get: async () => DEFAULT_APP_SETTINGS },
    });
    const read = expect(controller.read(7, { ...selection, sessionId: 's' })).rejects.toThrow();
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const inspect = expect(
      controller.inspect(7, { ...selection, sessionId: 's' }),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    controller.cancel(7, 's', false);
    await read;
    expect(signals[1]?.aborted).toBe(false);
    controller.cancelTab(7);
    await inspect;
    expect(signals[1]?.aborted).toBe(true);
  });
  it('never captures for a tab or session the user did not enable', async () => {
    let captures = 0,
      sessionId = '';
    const controller = new TranslationController({
      getSession: async (tab) => (tab === 7 ? sessionId || null : null),
      toggle: async (_tab, options) => {
        sessionId = options.sessionId;
        return true;
      },
      capture: async () => {
        captures++;
        return new Blob();
      },
      settings: { get: async () => DEFAULT_APP_SETTINGS },
      provider: {
        stream() {
          throw new Error('not called');
        },
      },
    });
    await expect(controller.read(7, selection)).rejects.toThrow();
    await controller.toggle(7);
    await expect(controller.read(7, selection)).rejects.toThrow();
    await expect(controller.read(8, { ...selection, sessionId })).rejects.toThrow();
    controller.cancel(7, sessionId);
    sessionId = '';
    await expect(controller.read(7, { ...selection, sessionId })).rejects.toThrow();
    expect(captures).toBe(0);
  });

  it('aborts an in-flight capture on close without retaining a session', async () => {
    let sessionId = '',
      captureStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    const controller = new TranslationController({
      getSession: async () => sessionId || null,
      toggle: async (_tab, options) => {
        sessionId = options.sessionId;
        return true;
      },
      capture: async (_tab, _region, signal) => {
        captureStarted();
        return new Promise<Blob>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        );
      },
      settings: { get: async () => DEFAULT_APP_SETTINGS },
      provider: {
        stream() {
          throw new Error('not called');
        },
      },
    });
    await controller.toggle(7);
    const pending = controller.read(7, { ...selection, sessionId });
    const rejected = expect(pending).rejects.toThrow();
    await started;
    controller.cancel(7, sessionId);
    sessionId = '';
    await rejected;
    await expect(controller.read(7, { ...selection, sessionId })).rejects.toThrow();
  });

  it('revalidates the page-owned session after an MV3 worker restart', async () => {
    let pageSession: string | null = 'still-open';
    const capture = vi.fn(async () => {
      throw new Error('capture reached');
    });
    const controller = new TranslationController({
      getSession: async (tabId) => (tabId === 7 ? pageSession : null),
      toggle: async () => false,
      capture,
      settings: { get: async () => DEFAULT_APP_SETTINGS },
      provider: {
        stream() {
          throw new Error('not reached');
        },
      },
    });
    expect(await controller.getState(7)).toEqual({ active: true });
    await expect(controller.read(7, { ...selection, sessionId: 'still-open' })).rejects.toThrow(
      'capture reached',
    );
    expect(capture).toHaveBeenCalledOnce();
    pageSession = null;
    expect(await controller.getState(7)).toEqual({ active: false });
    await expect(controller.read(7, { ...selection, sessionId: 'still-open' })).rejects.toThrow(
      'not enabled',
    );
    expect(capture).toHaveBeenCalledOnce();
  });

  it('cancels authorization still in flight when the target tab navigates', async () => {
    let authorize!: (id: string) => void;
    const capture = vi.fn();
    const controller = new TranslationController({
      getSession: () =>
        new Promise<string>((resolve) => {
          authorize = resolve;
        }),
      toggle: async () => false,
      capture,
      settings: { get: async () => DEFAULT_APP_SETTINGS },
      provider: {
        stream() {
          throw new Error('not reached');
        },
      },
    });
    const reading = controller.read(7, { ...selection, sessionId: 'before-navigation' });
    const rejected = expect(reading).rejects.toThrow();
    controller.cancelTab(7);
    authorize('before-navigation');
    await rejected;
    expect(capture).not.toHaveBeenCalled();
  });
});
