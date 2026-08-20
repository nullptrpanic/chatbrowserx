import { describe, expect, it } from 'vitest';
import { evaluateLiveRun, sanitizeToolPayload } from '../../../scripts/live-e2e/live-policy';
import type {
  LiveRunInput,
  LiveScenario,
  LiveToolResult,
} from '../../../scripts/live-e2e/live-types';

const scenario: LiveScenario = {
  name: 'read-chat',
  description: 'Reads one chat.',
  startUrl: 'https://example.com/chat',
  expectedOrigin: 'https://example.com',
  taskText: 'Read the latest messages without changing anything.',
  readinessTimeoutMs: 10_000,
  taskTimeoutMs: 60_000,
  maxToolCalls: 12,
  requiredTools: ['browser_inspect'],
  forbiddenTools: ['browser_click_point', 'browser_drag_point'],
  forbidScreenshotInspect: true,
  forbidSubmittedType: true,
  finalTextIncludes: ['Example chat'],
  minFinalTextLength: 20,
  allowRemoteMutation: false,
};

function tool(
  toolName: string,
  arguments_: unknown,
  overrides: Partial<LiveToolResult> = {},
): LiveToolResult {
  return {
    toolName,
    argumentsJson: JSON.stringify(arguments_),
    output: JSON.stringify({ ok: true }),
    attachmentIds: [],
    ...overrides,
  };
}

function completedInput(): LiveRunInput {
  return {
    terminalStatus: 'completed',
    finalText: 'Example chat contains several recent messages.',
    toolResults: [tool('browser_inspect', { tabId: 0, mode: 'interactive', since: '' })],
  };
}

describe('live E2E acceptance policy', () => {
  it('accepts one completed structural read', () => {
    const result = evaluateLiveRun(scenario, completedInput());

    expect(result.passed).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it('rejects screenshot inspection and submitted typing', () => {
    const input: LiveRunInput = {
      ...completedInput(),
      toolResults: [
        tool('browser_inspect', { tabId: 0, mode: 'screenshot', since: '' }),
        tool('browser_type', {
          tabId: 0,
          ref: 'e1',
          text: 'message',
          replace: true,
          submit: true,
        }),
      ],
    };

    const result = evaluateLiveRun(scenario, input);

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'no-screenshot-inspection',
          passed: false,
        }),
        expect.objectContaining({ name: 'no-submitted-typing', passed: false }),
      ]),
    );
  });

  it('rejects forbidden tools, attachments, missing requirements, and excessive calls', () => {
    const input: LiveRunInput = {
      ...completedInput(),
      toolResults: Array.from({ length: 13 }, (_, index) =>
        index === 0
          ? tool('browser_click_point', { x: 10, y: 20 }, { attachmentIds: ['image_1'] })
          : tool('browser_scroll', {
              tabId: 0,
              target: '',
              deltaX: 0,
              deltaY: 100,
            }),
      ),
    };

    const result = evaluateLiveRun(scenario, input);

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tool-call-ceiling', passed: false }),
        expect.objectContaining({ name: 'required-tools', passed: false }),
        expect.objectContaining({ name: 'forbidden-tools', passed: false }),
        expect.objectContaining({
          name: 'no-image-attachments',
          passed: false,
        }),
      ]),
    );
  });

  it('rejects non-completed tasks and incomplete final answers', () => {
    const result = evaluateLiveRun(scenario, {
      ...completedInput(),
      terminalStatus: 'failed',
      finalText: 'Too short',
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'terminal-status', passed: false }),
        expect.objectContaining({ name: 'final-text-content', passed: false }),
        expect.objectContaining({ name: 'final-text-length', passed: false }),
      ]),
    );
  });

  it('verifies one declared submitted message from its call and structural readback', () => {
    const marker = 'ChatBrowserX live self-check live_123';
    const mutationScenario: LiveScenario = {
      ...scenario,
      allowRemoteMutation: true,
      forbidSubmittedType: false,
      expectedSubmittedTypeCount: 1,
      requiredTypedTextIncludes: [marker],
      requiredToolOutputIncludes: [marker],
      finalTextIncludes: [marker],
    };
    const input: LiveRunInput = {
      terminalStatus: 'completed',
      finalText: `Sent and verified ${marker}`,
      toolResults: [
        tool(
          'browser_type',
          {
            tabId: 0,
            ref: 'message-editor',
            text: marker,
            replace: true,
            submit: true,
          },
          {
            output: JSON.stringify({
              ok: true,
              data: { submitted: true, submissionVerified: true },
            }),
          },
        ),
        tool(
          'browser_inspect',
          { tabId: 0, mode: 'interactive', since: '' },
          {
            output: JSON.stringify({
              ok: true,
              data: {
                elements: [
                  { r: 'statictext', n: marker },
                  { r: 'textbox', n: '' },
                ],
              },
            }),
          },
        ),
      ],
    };

    expect(evaluateLiveRun(mutationScenario, input).passed).toBe(true);
    const submittedTool = input.toolResults[0];
    if (submittedTool === undefined) throw new Error('Submitted tool fixture is missing.');

    const duplicate = evaluateLiveRun(mutationScenario, {
      ...input,
      toolResults: [...input.toolResults, submittedTool],
    });
    expect(duplicate.passed).toBe(false);
    expect(duplicate.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'submitted-type-count',
          passed: false,
        }),
      ]),
    );

    const editorMirror = evaluateLiveRun(mutationScenario, {
      ...input,
      toolResults: [
        tool(
          'browser_type',
          {
            tabId: 0,
            ref: 'message-editor',
            text: marker,
            replace: true,
            submit: true,
          },
          {
            output: JSON.stringify({
              ok: true,
              data: { submitted: true, submissionVerified: false },
            }),
          },
        ),
        tool(
          'browser_inspect',
          { tabId: 0, mode: 'interactive', since: '' },
          {
            output: JSON.stringify({
              ok: true,
              data: {
                elements: [
                  { r: 'statictext', n: marker },
                  { r: 'textbox', n: marker },
                ],
              },
            }),
          },
        ),
      ],
    });
    expect(editorMirror.passed).toBe(false);
    expect(editorMirror.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'submitted-state-readback', passed: false }),
      ]),
    );
  });

  it('requires five distinct markdown table rows when the scenario declares them', () => {
    const tableScenario: LiveScenario = {
      ...scenario,
      minimumMarkdownTableRows: 5,
      finalTextIncludes: ['群聊', '最近24小时'],
    };
    const accepted = evaluateLiveRun(tableScenario, {
      ...completedInput(),
      finalText: [
        '| 群聊 | 最近24小时 |',
        '| --- | --- |',
        '| 群聊 A | 内容 A |',
        '| 群聊 B | 内容 B |',
        '| 群聊 C | 内容 C |',
        '| 群聊 D | 内容 D |',
        '| 群聊 E | 内容 E |',
      ].join('\n'),
    });
    expect(accepted.passed).toBe(true);

    const duplicate = evaluateLiveRun(tableScenario, {
      ...completedInput(),
      finalText: [
        '| 群聊 | 最近24小时 |',
        '| --- | --- |',
        '| 群聊 A | 内容 1 |',
        '| 群聊 A | 内容 2 |',
        '| 群聊 B | 内容 B |',
        '| 群聊 C | 内容 C |',
        '| 群聊 D | 内容 D |',
      ].join('\n'),
    });
    expect(duplicate.passed).toBe(false);
    expect(duplicate.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'markdown-table-rows', passed: false }),
      ]),
    );
  });

  it('rejects a broken provider request chain and accepts encrypted reasoning replay', () => {
    const request = {
      sequence: 1,
      extensionOwned: true,
      bodyValid: true,
      model: 'gpt-5.6-terra',
      instructionCharacters: 10,
      store: false,
      stream: true,
      parallelToolCalls: false,
      includesEncryptedReasoning: true,
      toolNames: ['browser_inspect'],
      toolChoice: 'auto',
      inputItems: [],
      activeUserRequestOccurrences: 1,
      runtimeSupplementOccurrences: 0,
      functionCallCount: 0,
      functionOutputCount: 0,
      orphanFunctionOutputCount: 0,
      unpairedFunctionCallCount: 0,
      duplicateFunctionCallIds: false,
      encryptedReasoningInputCount: 0,
      response: {
        status: 200,
        contentType: 'text/event-stream',
        bodyBytes: 100,
        bodyTooLarge: false,
        completed: true,
        failed: false,
        eventTypes: ['response.completed'],
        encryptedReasoningOutputCount: 1,
        captureError: null,
      },
    } as const;
    const input: LiveRunInput = {
      ...completedInput(),
      providerTrace: {
        requestCount: 2,
        requests: [
          request,
          {
            ...request,
            sequence: 2,
            encryptedReasoningInputCount: 1,
            response: { ...request.response, encryptedReasoningOutputCount: 0 },
          },
        ],
      },
    };

    expect(evaluateLiveRun(scenario, input).passed).toBe(true);

    const broken = evaluateLiveRun(scenario, {
      ...input,
      providerTrace: {
        requestCount: 2,
        requests: [
          request,
          {
            ...request,
            sequence: 2,
            includesEncryptedReasoning: false,
            encryptedReasoningInputCount: 0,
            response: { ...request.response, encryptedReasoningOutputCount: 0 },
          },
        ],
      },
    });
    expect(broken.passed).toBe(false);
    expect(broken.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'provider-request-contract', passed: false }),
        expect.objectContaining({ name: 'encrypted-reasoning-continuation', passed: false }),
      ]),
    );
  });
});

describe('live E2E report payload sanitization', () => {
  it('redacts nested credential-shaped JSON fields without hiding normal page data', () => {
    const value = JSON.stringify({
      authorization: 'Bearer secret-one',
      query: 'recent messages',
      nested: { apiKey: 'secret-two', result: 'visible text' },
    });

    const sanitized = sanitizeToolPayload(value, 1_000);

    expect(sanitized).not.toContain('secret-one');
    expect(sanitized).not.toContain('secret-two');
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).toContain('recent messages');
    expect(sanitized).toContain('visible text');
  });

  it('redacts bearer tokens in plain text and enforces the exact character bound', () => {
    const sanitized = sanitizeToolPayload(
      `prefix Authorization: Bearer abc.def.ghi ${'x'.repeat(100)}`,
      48,
    );

    expect(sanitized).not.toContain('abc.def.ghi');
    expect(sanitized.length).toBeLessThanOrEqual(48);
  });
});
