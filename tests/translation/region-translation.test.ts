import { describe, expect, it } from 'vitest';
import type { ModelRequest, ModelProviderPort } from '../../src/agent/model/model-provider';
import type { ModelStreamEvent } from '../../src/agent/model/model-stream-event';
import { extensionMessageSchema } from '../../src/shared/protocol/message-schema';
import {
  translateRegion,
  translationSelectionSchema,
  translationResultSchema,
} from '../../src/translation/region-translation';

const block = { text: 'Save', translation: '保存', box: [100, 200, 300, 40] };

function provider(events: ModelStreamEvent[], requests: ModelRequest[] = []): ModelProviderPort {
  return {
    async *stream(request) {
      requests.push(request);
      yield* events;
    },
  };
}

describe('region translation', () => {
  it('allows full-viewport pixel inspection but keeps model image requests bounded', () => {
    const message = {
      version: 1,
      requestId: 'viewport',
      type: 'translation.inspect',
      payload: {
        sessionId: 's',
        devicePixelRatio: 2,
        viewportWidth: 3840,
        viewportHeight: 2160,
        rect: { x: 0, y: 0, width: 3840, height: 2160 },
      },
    };
    expect(extensionMessageSchema.safeParse(message).success).toBe(true);
    expect(extensionMessageSchema.safeParse({ ...message, type: 'translation.read' }).success).toBe(
      false,
    );
  });
  it('does not accept image blocks missing the required source text as complete', async () => {
    const translated = { translation: '保存', box: [100, 200, 300, 40] };
    const result = await translateRegion(
      provider([
        { type: 'text.delta', delta: JSON.stringify({ blocks: [translated] }) },
        { type: 'response.completed', responseId: 'r', usage: null },
      ]),
      'data:image/png;base64,cG5n',
      'm',
      'medium',
      'zh-CN',
      new AbortController().signal,
    );
    expect(result).toEqual({ blocks: [], incomplete: true });
    expect(translationResultSchema.safeParse({ blocks: [translated] }).success).toBe(false);
  });

  it('emits complete validated blocks before completion, never partial JSON or invalid coordinates', async () => {
    const updates: unknown[] = [];
    const translated = {
      text: 'Save "file" } ] \\ path',
      translation: '保存 "文件" } ] \\ 路径',
      box: [100, 200, 300, 40],
    };
    const second = { text: 'Close', translation: '关闭', box: [100, 300, 300, 40] };
    const result = await translateRegion(
      {
        async *stream() {
          const prefix = '```json\n{"blocks":[' + JSON.stringify(translated);
          for (const delta of prefix) yield { type: 'text.delta' as const, delta };
          expect(updates).toEqual([{ blocks: [translated], incomplete: true }]);
          yield {
            type: 'text.delta' as const,
            delta: ',' + JSON.stringify({ ...second, box: [900, 20, 200, 40] }),
          };
          expect(updates).toHaveLength(1);
          yield { type: 'text.delta' as const, delta: ',' + JSON.stringify(second) + ']}\n```' };
          expect(updates).toEqual([
            { blocks: [translated], incomplete: true },
            { blocks: [translated, second], incomplete: true },
          ]);
          yield { type: 'response.completed' as const, responseId: 'r', usage: null };
        },
      },
      'data:image/png;base64,cG5n',
      'm',
      'medium',
      'zh-CN',
      new AbortController().signal,
      (result) => updates.push(result),
    );
    expect(result).toEqual({ blocks: [translated, second], incomplete: true });
  });

  it('still rejects an interrupted stream after emitting valid preview blocks', async () => {
    const updates: unknown[] = [];
    await expect(
      translateRegion(
        provider([{ type: 'text.delta', delta: '{"blocks":[' + JSON.stringify(block) }]),
        'data:image/png;base64,cG5n',
        'm',
        'medium',
        'zh-CN',
        new AbortController().signal,
        (result) => updates.push(result),
      ),
    ).rejects.toThrow();
    expect(updates).toEqual([{ blocks: [block], incomplete: true }]);
  });

  it('does not emit later blocks after cancellation', async () => {
    const updates: unknown[] = [];
    const abort = new AbortController();
    await expect(
      translateRegion(
        {
          async *stream() {
            yield { type: 'text.delta' as const, delta: '{"blocks":[' + JSON.stringify(block) };
            abort.abort();
            yield { type: 'text.delta' as const, delta: ',' + JSON.stringify(block) + ']}' };
            yield { type: 'response.completed' as const, responseId: 'r', usage: null };
          },
        },
        'data:image/png;base64,cG5n',
        'm',
        'medium',
        'zh-CN',
        abort.signal,
        (result) => updates.push(result),
      ),
    ).rejects.toThrow();
    expect(updates).toHaveLength(1);
  });

  it('clips tiny edge rounding errors without losing the rest of a completed image response', async () => {
    const blocks = [
      block,
      { text: '65 Answers', translation: '65 个回答', box: [282, 984, 46, 17] },
      { text: 'Footer', translation: '页脚', box: [202, 989, 70, 13] },
    ];
    const result = await translateRegion(
      provider([
        { type: 'text.delta', delta: JSON.stringify({ blocks }) },
        { type: 'response.completed', responseId: 'r', usage: null },
      ]),
      'data:image/png;base64,cG5n',
      'm',
      'low',
      'zh-CN',
      new AbortController().signal,
    );
    expect(result.blocks).toEqual([
      block,
      { ...blocks[1], box: [282, 984, 46, 16] },
      { ...blocks[2], box: [202, 989, 70, 11] },
    ]);
    expect(result.incomplete).not.toBe(true);
  });

  it('isolates a genuinely invalid image block and reports incomplete coverage', async () => {
    const result = await translateRegion(
      provider([
        {
          type: 'text.delta',
          delta: JSON.stringify({ blocks: [block, { ...block, box: [900, 20, 200, 40] }, null] }),
        },
        { type: 'response.completed', responseId: 'r', usage: null },
      ]),
      'data:image/png;base64,cG5n',
      'm',
      'low',
      'zh-CN',
      new AbortController().signal,
    );
    expect(result.blocks).toEqual([block]);
    expect(result.incomplete).toBe(true);
  });

  it('uses one image-only request with the selected model, effort and language, without tools or history', async () => {
    const requests: ModelRequest[] = [];
    const result = await translateRegion(
      provider(
        [
          { type: 'text.delta', delta: JSON.stringify({ blocks: [block] }) },
          { type: 'response.completed', responseId: 'r', usage: null },
        ],
        requests,
      ),
      'data:image/png;base64,cG5n',
      'custom-model',
      'high',
      'zh-CN',
      new AbortController().signal,
    );
    expect(result.blocks).toEqual([block]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: 'custom-model',
      reasoningEffort: 'high',
      tools: [],
    });
    expect(requests[0]?.systemPrompt).toContain('"text":"original line"');
    expect(requests[0]?.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Target language: zh-CN.' },
          { type: 'input_image', imageUrl: 'data:image/png;base64,cG5n', detail: 'original' },
        ],
      },
    ]);
  });

  it('rejects a valid JSON draft when the provider never completed', async () => {
    await expect(
      translateRegion(
        provider([{ type: 'text.delta', delta: '{"blocks":[]}' }]),
        'data:image/png;base64,cG5n',
        'm',
        'low',
        'en',
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it('rejects aborted requests instead of accepting late text', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      translateRegion(
        provider([{ type: 'response.completed', responseId: 'r', usage: null }]),
        'data:image/png;base64,cG5n',
        'm',
        'low',
        'en',
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it.each([
    [900, 20, 200, 40],
    [-1, 0, 20, 20],
    [0, 0, 0, 20],
  ])('rejects out-of-image boxes: %j', (...box) => {
    expect(translationResultSchema.safeParse({ blocks: [{ ...block, box }] }).success).toBe(false);
  });

  it('rejects captures extending outside the originating viewport', () => {
    expect(
      translationSelectionSchema.safeParse({
        sessionId: 's',
        devicePixelRatio: 2,
        viewportWidth: 800,
        viewportHeight: 600,
        rect: { x: 700, y: 0, width: 200, height: 100 },
      }).success,
    ).toBe(false);
  });
});
