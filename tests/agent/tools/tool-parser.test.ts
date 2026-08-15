import { describe, expect, it } from 'vitest';
import {
  BROWSER_TOOL_DEFINITION,
  serializeModelTarget,
} from '../../../src/agent/tools/browser-tool-schema';
import { parseToolCall } from '../../../src/agent/tools/tool-parser';
import type { ElementTarget } from '../../../src/browser/contracts/target';

const TARGET: ElementTarget = {
  framePath: [],
  shadowPath: [],
  role: 'button',
  name: 'Continue',
  label: null,
  text: 'Continue',
  stableAttributes: { 'data-testid': 'continue' },
  ancestorHint: 'Checkout',
  lastKnownRect: { x: 10, y: 20, width: 100, height: 30 },
};

describe('parseToolCall', () => {
  it('round-trips the strict model-visible target without dynamic object properties', () => {
    const serializedTarget = serializeModelTarget(TARGET);
    const parsed = parseToolCall({
      name: 'browser.act',
      argumentsJson: JSON.stringify({
        action: {
          type: 'click',
          target: serializedTarget,
          riskHint: 'low',
          expected: { type: 'page.stable', quietMs: 500 },
        },
      }),
    });

    expect(parsed).toEqual({
      name: 'browser.act',
      arguments: {
        type: 'click',
        target: TARGET,
        riskHint: 'low',
        expected: { type: 'page.stable', quietMs: 500 },
      },
    });
    expect(JSON.stringify(BROWSER_TOOL_DEFINITION.parameters)).not.toMatch(
      /selector|eval|javascript|code/i,
    );
  });

  it('accepts one structured browser action with a required expected condition', () => {
    const action = {
      type: 'click',
      target: TARGET,
      riskHint: 'low',
      expected: { type: 'url.matches', pattern: '/next' },
    } as const;

    expect(parseToolCall({ name: 'browser.act', argumentsJson: JSON.stringify(action) })).toEqual({
      name: 'browser.act',
      arguments: action,
    });
  });

  it.each([
    {
      type: 'type',
      target: TARGET,
      text: 'hello',
      replace: true,
      riskHint: 'low',
      expected: { type: 'element.value', target: TARGET, equals: 'hello' },
    },
    {
      type: 'clear',
      target: TARGET,
      riskHint: 'low',
      expected: { type: 'element.value', target: TARGET, equals: '' },
    },
    {
      type: 'select',
      target: TARGET,
      value: 'cn',
      riskHint: 'low',
      expected: { type: 'element.value', target: TARGET, equals: 'cn' },
    },
    {
      type: 'check',
      target: TARGET,
      checked: true,
      riskHint: 'low',
      expected: { type: 'element.checked', target: TARGET, checked: true },
    },
    {
      type: 'hover',
      target: TARGET,
      riskHint: 'low',
      expected: { type: 'element.visible', target: TARGET, visible: true },
    },
    {
      type: 'pressKey',
      target: null,
      key: 'Escape',
      riskHint: 'low',
      expected: { type: 'page.stable', quietMs: 500 },
    },
    {
      type: 'scroll',
      target: null,
      deltaX: 0,
      deltaY: 600,
      riskHint: 'low',
      expected: { type: 'text.contains', text: 'More results' },
    },
    {
      type: 'drag',
      target: TARGET,
      destination: { ...TARGET, name: 'Destination' },
      riskHint: 'low',
      expected: { type: 'page.stable', quietMs: 500 },
    },
    {
      type: 'waitFor',
      timeoutMs: 1_000,
      riskHint: 'low',
      expected: { type: 'text.contains', text: 'Ready' },
    },
  ])('accepts the bounded $type action', (action) => {
    expect(parseToolCall({ name: 'browser.act', argumentsJson: JSON.stringify(action) })).toEqual({
      name: 'browser.act',
      arguments: action,
    });
  });

  it('accepts only bounded Tavily operations', () => {
    expect(
      parseToolCall({
        name: 'tavily.search',
        argumentsJson: '{"query":"browser reliability","maxResults":8}',
      }),
    ).toEqual({
      name: 'tavily.search',
      arguments: { query: 'browser reliability', maxResults: 8 },
    });
    expect(
      parseToolCall({
        name: 'tavily.extract',
        argumentsJson: '{"urls":["https://example.test/a"]}',
      }),
    ).toEqual({
      name: 'tavily.extract',
      arguments: { urls: ['https://example.test/a'] },
    });
    expect(
      parseToolCall({
        name: 'tavily.crawl',
        argumentsJson: '{"url":"https://example.test","maxDepth":2,"maxBreadth":10}',
      }),
    ).toEqual({
      name: 'tavily.crawl',
      arguments: { url: 'https://example.test', maxDepth: 2, maxBreadth: 10 },
    });
  });

  it.each([
    { name: 'browser.eval', argumentsJson: '{"code":"document.cookie"}' },
    { name: 'browser.act', argumentsJson: '{"code":"document.cookie"}' },
    {
      name: 'browser.act',
      argumentsJson:
        '{"type":"click","selector":"#pay","riskHint":"low","expected":{"type":"page.stable","quietMs":500}}',
    },
    {
      name: 'browser.act',
      argumentsJson: JSON.stringify({
        actions: [
          {
            type: 'click',
            target: TARGET,
            riskHint: 'low',
            expected: { type: 'page.stable', quietMs: 500 },
          },
        ],
      }),
    },
    {
      name: 'browser.act',
      argumentsJson: JSON.stringify({
        type: 'click',
        target: { selector: '#pay' },
        riskHint: 'high',
        expected: { type: 'page.stable', quietMs: 500 },
      }),
    },
    { name: 'tavily.extract', argumentsJson: '{"urls":["file:///etc/passwd"]}' },
    {
      name: 'tavily.crawl',
      argumentsJson: '{"url":"https://example.test","maxDepth":3,"maxBreadth":10}',
    },
  ])('rejects unsupported or unsafe call %#', (call) => {
    expect(() => parseToolCall(call)).toThrow(/unsupported tool|invalid tool arguments/i);
  });

  it('rejects malformed JSON without including it in the error', () => {
    const unsafe = '{"secret":"token-value"';
    let thrown: unknown;
    try {
      parseToolCall({ name: 'browser.act', argumentsJson: unsafe });
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toMatch(/invalid tool arguments/i);
    expect(String(thrown)).not.toContain('token-value');
  });
});
