import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TranslationController } from '../../src/translation/translation-controller';
import { DEFAULT_APP_SETTINGS } from '../../src/persistence/settings-store';
import { providerErrorFromCode } from '../../src/agent/model/model-provider-error';

beforeEach(() => {
  vi.useFakeTimers();
  // Native AbortSignal.timeout uses an internal clock; keep its semantics on the test clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function start(duration: number) {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  let requests = 0;
  const controller = new TranslationController({
    getSession: async () => 's',
    toggle: async () => false,
    settings: { get: async () => DEFAULT_APP_SETTINGS },
    provider: {
      async *stream(_request, signal) {
        requests++;
        started();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, duration);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              // The real provider normalizes all aborted fetches to ABORTED.
              reject(providerErrorFromCode('ABORTED'));
            },
            { once: true },
          );
        });
        yield {
          type: 'text.delta',
          delta: JSON.stringify({
            blocks: [{ id: 'p', translation: '保存' }],
          }),
        };
        yield { type: 'response.completed', responseId: 'r', usage: null };
      },
    },
  });
  const result = controller.read(7, { sessionId: 's', texts: [{ id: 'p', text: 'Save' }] }).then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
  await ready;
  return { controller, result, requests: () => requests };
}

it('lets text finish within its deadline without retrying the model', async () => {
  const run = await start(90_000);
  await vi.advanceTimersByTimeAsync(90_000);
  expect((await run.result).value?.blocks[0]?.translation).toBe('保存');
  expect(run.requests()).toBe(1);
});

it('reports the text deadline as a timeout, not MODEL_ABORTED', async () => {
  const deadline = 120_000;
  const run = await start(deadline + 5000);
  let settled = false;
  void run.result.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(deadline - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect((await run.result).error).toMatchObject({ name: 'TimeoutError' });
  expect(run.requests()).toBe(1);
});

it('keeps closing the lens an explicit cancellation, not a timeout or retry', async () => {
  const run = await start(45_000);
  run.controller.cancel(7, 's');
  expect((await run.result).error).toMatchObject({ code: 'ABORTED' });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(run.requests()).toBe(1);
});
