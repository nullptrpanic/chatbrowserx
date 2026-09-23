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

it.each([
  '使用链接。',
  '使用 <m1>链接</m1>。',
  '<m0>链接</m0><m0>重复</m0>',
  '<m0>链接',
  '<m0>链<m1>接</m1></m0>',
])(
  'rejects lost, invented or broken source style markers before displaying a preview: %s',
  async (translation) => {
    const updates: TranslationTextResult[] = [];
    await expect(
      translateTexts(
        {
          async *stream() {
            yield {
              type: 'text.delta' as const,
              delta: JSON.stringify({ blocks: [{ id: 'p', translation }] }),
            };
            yield { type: 'response.completed' as const, responseId: 'r', usage: null };
          },
        },
        [{ id: 'p', text: 'Use <m0>the link</m0>.' }],
        'm',
        'medium',
        'zh-CN',
        new AbortController().signal,
        (result) => updates.push(result),
      ),
    ).rejects.toMatchObject({ code: 'TRANSLATION_RESPONSE_INVALID' });
    expect(updates).toEqual([]);
  },
);

function translate(
  provider: ModelProviderPort,
  updates: TranslationTextResult[],
  signal = new AbortController().signal,
) {
  return translateTexts(provider, texts, 'm', 'medium', 'zh-CN', signal, (result) =>
    updates.push(result),
  );
}

it.each(['Read the guide.', 'Read the guide</m0>.', '', null])(
  'isolates an invalid known block and continues the stream: %j',
  async (translation) => {
    const updates: TranslationTextResult[] = [];
    const before = { id: 'p', translation: 'First translated paragraph.' };
    const after = { id: 'r', translation: 'Last translated paragraph.' };
    let completed = false;
    const result = await translateTexts(
      {
        async *stream() {
          yield { type: 'text.delta', delta: '{"blocks":[' + JSON.stringify(before) };
          yield { type: 'text.delta', delta: ',' + JSON.stringify({ id: 'q', translation }) };
          yield { type: 'text.delta', delta: ',' + JSON.stringify(after) + ']}' };
          completed = true;
          yield { type: 'response.completed', responseId: 'r', usage: null };
        },
      },
      [
        { id: 'p', text: 'First paragraph.' },
        { id: 'q', text: 'Read <m0>the guide</m0>.' },
        { id: 'r', text: 'Last paragraph.' },
      ],
      'm',
      'medium',
      'en',
      new AbortController().signal,
      (update) => updates.push(update),
    );
    expect(completed).toBe(true);
    expect(result).toEqual({ blocks: [before, after] });
    expect(updates).toEqual([{ blocks: [before] }, { blocks: [before, after] }]);
  },
);

it('returns validated blocks when a completed response omits another requested ID', async () => {
  expect(
    await translate(
      {
        async *stream() {
          yield { type: 'text.delta', delta: JSON.stringify({ blocks: [first] }) };
          yield { type: 'response.completed', responseId: 'r', usage: null };
        },
      },
      [],
    ),
  ).toEqual({ blocks: [first] });
});

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
  { translation: '缺少来源' },
])('rejects ambiguous source identities before accepting their batch: %j', async (invalid) => {
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

it.each(['interrupted', 'cancelled'] as const)(
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
