import { expect, it } from 'vitest';
import type { ModelProviderPort, ModelRequest } from '../../src/agent/model/model-provider';
import {
  translateTexts,
  type TranslationTextResult,
} from '../../src/translation/region-translation';

const texts = [
  { id: 'p', text: 'First paragraph.' },
  { id: 'q', text: 'Second paragraph.' },
];
const first = { id: 'p', translation: '第一段 "引用" } ] \\ 路径。' };
const second = { id: 'q', translation: '第二段。' };

function translate(
  provider: ModelProviderPort,
  updates: TranslationTextResult[],
  signal = new AbortController().signal,
) {
  return translateTexts(provider, texts, 'm', 'medium', 'zh-CN', signal, (result) =>
    updates.push(result),
  );
}

it('sends exactly the same model request and returns the same final text with previews enabled', async () => {
  const requests: ModelRequest[] = [];
  const provider: ModelProviderPort = {
    async *stream(request) {
      requests.push(request);
      yield { type: 'text.delta', delta: JSON.stringify({ blocks: [first, second] }) };
      yield { type: 'response.completed', responseId: 'r', usage: null };
    },
  };
  const completed = await translateTexts(
    provider,
    texts,
    'm',
    'medium',
    'zh-CN',
    new AbortController().signal,
  );
  expect(await translate(provider, [])).toEqual(completed);
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});

it('exposes only complete text blocks before the remaining paragraph and response finish', async () => {
  const updates: TranslationTextResult[] = [];
  const result = await translate(
    {
      async *stream() {
        const prefix = '```json\n{"blocks":[' + JSON.stringify(first);
        for (const delta of prefix) yield { type: 'text.delta' as const, delta };
        expect(updates).toEqual([{ blocks: [first] }]);
        yield { type: 'text.delta' as const, delta: ',{"id":"q","translation":"第二' };
        expect(updates).toHaveLength(1);
        yield { type: 'text.delta' as const, delta: '段。"}]}\n```' };
        expect(updates).toEqual([{ blocks: [first] }, { blocks: [first, second] }]);
        yield { type: 'response.completed' as const, responseId: 'r', usage: null };
      },
    },
    updates,
  );
  expect(result).toEqual({ blocks: [first, second] });
});

it.each([
  { id: 'unknown', translation: '错误来源' },
  { id: 'p', translation: '重复来源' },
  { id: 'q', translation: '' },
  { translation: '缺少来源' },
])('never previews an invalid text block or accepts its batch: %j', async (invalid) => {
  const updates: TranslationTextResult[] = [];
  await expect(
    translate(
      {
        async *stream() {
          yield { type: 'text.delta' as const, delta: '{"blocks":[' + JSON.stringify(first) };
          yield { type: 'text.delta' as const, delta: ',' + JSON.stringify(invalid) + ']}' };
          yield { type: 'response.completed' as const, responseId: 'r', usage: null };
        },
      },
      updates,
    ),
  ).rejects.toMatchObject({ code: 'TRANSLATION_RESPONSE_INVALID' });
  expect(updates).toEqual([{ blocks: [first] }]);
});

it.each(['missing-id', 'interrupted', 'cancelled'] as const)(
  'does not turn a valid text preview into success after %s',
  async (outcome) => {
    const updates: TranslationTextResult[] = [];
    const abort = new AbortController();
    await expect(
      translate(
        {
          async *stream() {
            yield { type: 'text.delta' as const, delta: '{"blocks":[' + JSON.stringify(first) };
            if (outcome === 'cancelled') abort.abort();
            yield { type: 'text.delta' as const, delta: ']}' };
            if (outcome !== 'interrupted')
              yield { type: 'response.completed' as const, responseId: 'r', usage: null };
          },
        },
        updates,
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(updates).toEqual([{ blocks: [first] }]);
  },
);
