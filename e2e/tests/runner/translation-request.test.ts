import { expect, it, vi } from 'vitest';
import {
  observeTranslationRequest,
  type TranslationRequestState,
} from '../../diagnostics/translation-request';

it('classifies HTTP failure without waiting for the canceled error body, retaining its status', async () => {
  const finished = vi.fn(() => new Promise<Error | null>(() => undefined));
  const record: TranslationRequestState = {};
  void observeTranslationRequest(Promise.resolve({ status: () => 503, finished }), record);
  await Promise.resolve();
  await Promise.resolve();
  expect(record).toEqual({
    status: 503,
    finished: true,
    transportFailed: false,
  });
  expect(finished).not.toHaveBeenCalled();
});

it('does not mark a successful streaming response finished before its body completes', async () => {
  let complete!: (result: Error | null) => void;
  const body = new Promise<Error | null>((resolve) => {
    complete = resolve;
  });
  const record: TranslationRequestState = {};
  const observed = observeTranslationRequest(
    Promise.resolve({ status: () => 200, finished: () => body }),
    record,
  );
  await Promise.resolve();
  expect(record).toEqual({ status: 200 });
  complete(null);
  await observed;
  expect(record).toEqual({
    status: 200,
    finished: true,
    transportFailed: false,
  });
});

it('retains aborted successful streams and missing responses as transport failures', async () => {
  for (const response of [
    Promise.resolve(null),
    Promise.resolve({
      status: () => 200,
      finished: async () => new Error('Aborted'),
    }),
    Promise.reject(new Error('Connection closed')),
  ]) {
    const record: TranslationRequestState = {};
    await observeTranslationRequest(response, record);
    expect(record.finished).toBe(true);
    expect(record.transportFailed).toBe(true);
  }
});

it('observes requestfailed even when Playwright never settles the canceled response body', async () => {
  let fail!: (reason: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  const record: TranslationRequestState = {};
  const observed = observeTranslationRequest(
    Promise.resolve({
      status: () => 200,
      finished: () => new Promise<Error | null>(() => undefined),
    }),
    record,
    failed,
  );
  for (let i = 0; i < 4; i++) await Promise.resolve();
  expect(record).toEqual({ status: 200 });
  fail(new Error('Request canceled'));
  // Flush promise reactions without relying on a wall-clock timeout.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(record).toEqual({
    status: 200,
    finished: true,
    transportFailed: true,
  });
  await observed;
});

it('retains failure before response headers without waiting on an unresolved response', async () => {
  const record: TranslationRequestState = {};
  const failed = Promise.reject(new Error('Request failed'));
  const observed = observeTranslationRequest(new Promise(() => undefined), record, failed);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(record).toEqual({ finished: true, transportFailed: true });
  await observed;
});
