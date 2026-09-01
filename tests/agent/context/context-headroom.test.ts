import { describe, expect, it } from 'vitest';
import { estimateUnmeasuredContextTokens } from '../../../src/agent/context/context-headroom';
import type { ModelInputItem } from '../../../src/agent/model/model-provider';

describe('context headroom', () => {
  it('returns zero when the latest completed call is not present', () => {
    const input: ModelInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'start' }],
      },
    ];

    expect(estimateUnmeasuredContextTokens(input, 'call_missing')).toBe(0);
  });

  it('counts model output, the latest call/result, and trailing supplements only', () => {
    const priorOutput = 'x'.repeat(30_000);
    const latestOutput = '页面结果'.repeat(4_000);
    const input: ModelInputItem[] = [
      {
        type: 'function_call',
        callId: 'call_prior',
        name: 'browser_inspect',
        argumentsJson: '{}',
      },
      {
        type: 'function_call_output',
        callId: 'call_prior',
        output: priorOutput,
      },
      {
        type: 'reasoning',
        itemId: 'reasoning_latest',
        encryptedContent: 'a'.repeat(3_000),
        summary: [{ type: 'summary_text', text: '继续处理页面' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '正在检查' }],
      },
      {
        type: 'function_call',
        callId: 'call_latest',
        name: 'browser_inspect',
        argumentsJson: '{"mode":"interactive"}',
      },
      {
        type: 'function_call_output',
        callId: 'call_latest',
        output: latestOutput,
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '用户在工具执行时新补充的内容' }],
      },
    ];

    const estimate = estimateUnmeasuredContextTokens(input, 'call_latest');

    expect(estimate).toBeGreaterThan(17_000);
    expect(estimate).toBeLessThan(28_000);
    expect(estimate).toBeLessThan(estimateUnmeasuredContextTokens(input, 'call_prior'));
  });

  it('uses a bounded image estimate instead of counting an image data URL as text', () => {
    const imageUrl = `data:image/png;base64,${'A'.repeat(100_000)}`;
    const input: ModelInputItem[] = [
      {
        type: 'function_call',
        callId: 'call_capture',
        name: 'browser_capture',
        argumentsJson: '{}',
      },
      {
        type: 'function_call_output',
        callId: 'call_capture',
        output: [
          { type: 'input_text', text: '{"ok":true}' },
          { type: 'input_image', imageUrl, detail: 'original' },
        ],
      },
    ];

    const estimate = estimateUnmeasuredContextTokens(input, 'call_capture');

    expect(estimate).toBeGreaterThan(2_000);
    expect(estimate).toBeLessThan(10_000);
  });
});
