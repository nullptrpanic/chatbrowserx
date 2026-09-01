import { describe, expect, it } from 'vitest';
import { evaluateLiveRun, sanitizeToolPayload } from '../../runner/live-policy';
import type { LiveRunInput, LiveScenario, LiveToolResult } from '../../runner/live-types';

const scenario: LiveScenario = {
  contractVersion: 1,
  name: 'read-chat',
  description: 'Reads one chat.',
  exclusiveResources: [],
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

  it('rejects a section traversal that can run through many segments before reassessment', () => {
    const boundedScenario: LiveScenario = {
      ...scenario,
      requiredTools: ['browser_inspect', 'browser_scroll'],
      maxScrollSegmentsPerCall: 1,
    };
    const accepted = evaluateLiveRun(boundedScenario, {
      ...completedInput(),
      toolResults: [
        ...completedInput().toolResults,
        tool('browser_scroll', {
          tabId: 0,
          target: 'ref_document',
          deltaX: 0,
          deltaY: 600,
          maxSegments: 1,
          stopText: '',
        }),
      ],
    });
    expect(accepted.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'scroll-segment-limit', passed: true }),
      ]),
    );
    expect(accepted.passed).toBe(true);

    const oversizedTraversal = evaluateLiveRun(boundedScenario, {
      ...completedInput(),
      toolResults: [
        ...completedInput().toolResults,
        tool('browser_scroll', {
          tabId: 0,
          target: 'ref_document',
          deltaX: 0,
          deltaY: 600,
          maxSegments: 8,
          stopText: 'Distant section',
        }),
      ],
    });
    expect(oversizedTraversal.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'scroll-segment-limit',
          passed: false,
        }),
      ]),
    );
    expect(oversizedTraversal.passed).toBe(false);
  });

  it('limits actual traversal across every scroll call instead of the requested per-call budget', () => {
    const input = {
      ...completedInput(),
      toolResults: [
        ...completedInput().toolResults,
        tool(
          'browser_scroll',
          {
            tabId: 0,
            target: 'ref_document',
            deltaX: 0,
            deltaY: 600,
            maxSegments: 24,
            stopText: '',
          },
          {
            output: JSON.stringify({
              ok: true,
              data: { observations: [{ segment: 1 }, { segment: 2 }] },
            }),
          },
        ),
        tool(
          'browser_scroll',
          {
            tabId: 0,
            target: 'ref_document',
            deltaX: 0,
            deltaY: 600,
            maxSegments: 24,
            stopText: '',
          },
          {
            output: JSON.stringify({
              ok: true,
              data: { observations: [{ segment: 3 }, { segment: 4 }] },
            }),
          },
        ),
      ],
    } satisfies LiveRunInput;
    const boundedScenario: LiveScenario = {
      ...scenario,
      requiredTools: ['browser_inspect', 'browser_scroll'],
      maxTraversalSegments: 4,
    };

    const accepted = evaluateLiveRun(boundedScenario, input);
    const rejected = evaluateLiveRun({ ...boundedScenario, maxTraversalSegments: 3 }, input);

    expect(accepted.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'scroll-traversal-limit', passed: true }),
      ]),
    );
    expect(accepted.passed).toBe(true);
    expect(rejected.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'scroll-traversal-limit', passed: false }),
      ]),
    );
    expect(rejected.passed).toBe(false);
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

  it('allows only explicitly declared navigation keypresses', () => {
    const keypressScenario = {
      ...scenario,
      allowedKeypresses: ['HOME'],
    } as LiveScenario & { readonly allowedKeypresses: readonly string[] };
    const withKeypress = (keys: string): LiveRunInput => ({
      ...completedInput(),
      toolResults: [...completedInput().toolResults, tool('browser_keypress', { tabId: 0, keys })],
    });

    const accepted = evaluateLiveRun(keypressScenario, withKeypress('HOME'));
    const rejected = evaluateLiveRun(keypressScenario, withKeypress('A'));

    expect(accepted.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'allowed-keypresses', passed: true }),
      ]),
    );
    expect(accepted.passed).toBe(true);
    expect(rejected.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'allowed-keypresses', passed: false }),
      ]),
    );
    expect(rejected.passed).toBe(false);
  });

  it('allows one declared screenshot asset and requires exact delivery tool counts', () => {
    const deliveryScenario: LiveScenario = {
      ...scenario,
      allowRemoteMutation: true,
      maxAttachmentCount: 1,
      expectedToolCounts: {
        browser_capture_screenshot: 1,
        browser_paste_image: 1,
      },
    };
    const toolResults = [
      ...completedInput().toolResults,
      tool('browser_capture_screenshot', { tabId: 0 }, { attachmentIds: ['attachment_capture'] }),
      tool('browser_paste_image', {
        tabId: 0,
        ref: 'ref_editor',
        assetId: 'attachment_capture',
      }),
    ];
    const accepted = evaluateLiveRun(deliveryScenario, {
      ...completedInput(),
      toolResults,
    });

    expect(accepted.passed).toBe(true);

    const duplicatePaste = evaluateLiveRun(deliveryScenario, {
      ...completedInput(),
      toolResults: [...toolResults, tool('browser_paste_image', {})],
    });
    expect(duplicatePaste.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'expected-tool-counts',
          passed: false,
        }),
      ]),
    );
  });

  it('rejects a required verified tool when the model reports success after its action failed', () => {
    const verifiedScenario: LiveScenario = {
      ...scenario,
      requiredTools: ['browser_type'],
      requiredVerifiedTools: ['browser_type'],
      finalTextIncludes: ['replacement complete'],
    };
    const result = evaluateLiveRun(verifiedScenario, {
      ...completedInput(),
      finalText: 'replacement complete according to the model',
      toolResults: [
        tool(
          'browser_type',
          {
            tabId: 0,
            ref: 'editor',
            text: 'replacement',
            replace: true,
            submit: false,
          },
          {
            output: JSON.stringify({
              ok: false,
              code: 'TYPE_VERIFICATION_FAILED',
              message: 'The page did not retain the requested text.',
            }),
          },
        ),
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'required-tool-verification',
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

  it('rejects a nominally completed answer that declares an unresolved scenario blocker', () => {
    const guardedScenario: LiveScenario = {
      ...scenario,
      finalTextExcludes: ['唯一阻塞点', '无法确认', 'could not verify'],
    };
    const result = evaluateLiveRun(guardedScenario, {
      ...completedInput(),
      finalText: 'Example chat was read, but the image remains the 唯一阻塞点，无法确认。',
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'final-text-exclusions',
          passed: false,
        }),
      ]),
    );
  });

  it('matches required final evidence across harmless case and whitespace differences', () => {
    const normalizedScenario: LiveScenario = {
      ...scenario,
      finalTextIncludes: ['31 个租户', 'AuthZ', 'Local Cache', 'LogID'],
    };
    const result = evaluateLiveRun(normalizedScenario, {
      ...completedInput(),
      finalText: 'Example chat: 31个租户的 authz 判断使用 local\ncache，并以 logid 关联结果。',
    });

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'final-text-content', passed: true }),
      ]),
    );
    expect(result.passed).toBe(true);
  });

  it('does not treat a blocker word embedded in a code identifier as an unresolved blocker', () => {
    const guardedScenario: LiveScenario = {
      ...scenario,
      finalTextExcludes: ['blocked'],
    };
    const result = evaluateLiveRun(guardedScenario, {
      ...completedInput(),
      finalText:
        'Example chat was read and verified. The documented identifier IsShareBlockedByCAC is enabled.',
    });

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'final-text-exclusions',
          passed: true,
        }),
      ]),
    );
  });

  it('still rejects a standalone Latin blocker word', () => {
    const guardedScenario: LiveScenario = {
      ...scenario,
      finalTextExcludes: ['blocked'],
    };
    const result = evaluateLiveRun(guardedScenario, {
      ...completedInput(),
      finalText: 'Example chat was read, but verification is blocked by authentication.',
    });

    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'final-text-exclusions',
          passed: false,
        }),
      ]),
    );
  });

  it('checks declared literals against complete raw tool results', () => {
    const required = 'CHATBROWSERX_TAIL_DIAGNOSTIC_9471';
    const guardedScenario = {
      ...scenario,
      requiredToolResultIncludes: [required],
    } as LiveScenario & {
      readonly requiredToolResultIncludes: readonly string[];
    };
    const present = evaluateLiveRun(guardedScenario, {
      ...completedInput(),
      toolResults: [
        tool(
          'sandbox_exec',
          { command: 'produce-output', cwd: null },
          {
            output: JSON.stringify({
              code: 0,
              stdout: required,
              stderr: '',
              truncated: true,
            }),
          },
        ),
      ],
    });
    const missing = evaluateLiveRun(guardedScenario, {
      ...completedInput(),
      toolResults: [
        tool(
          'sandbox_exec',
          { command: 'produce-output', cwd: null },
          {
            output: JSON.stringify({
              code: 0,
              stdout: 'head only',
              stderr: '',
              truncated: true,
            }),
          },
        ),
      ],
    });

    expect(present.checks).toContainEqual(
      expect.objectContaining({
        name: 'required-tool-result-content',
        passed: true,
      }),
    );
    expect(missing.checks).toContainEqual(
      expect.objectContaining({
        name: 'required-tool-result-content',
        passed: false,
      }),
    );
  });

  it('verifies one declared submitted message from its call and structural readback', () => {
    const marker = 'ChatBrowserX live self-check live_123';
    const mutationScenario: LiveScenario = {
      ...scenario,
      allowRemoteMutation: true,
      forbidSubmittedType: false,
      requiredTools: ['browser_type'],
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
        expect.objectContaining({
          name: 'submitted-state-readback',
          passed: false,
        }),
      ]),
    );
  });

  it('accepts structural readback produced by the submitting action itself', () => {
    const marker = 'ChatBrowserX live self-check live_123';
    const mutationScenario: LiveScenario = {
      ...scenario,
      allowRemoteMutation: true,
      forbidSubmittedType: false,
      requiredTools: ['browser_type'],
      expectedSubmittedTypeCount: 1,
      requiredTypedTextIncludes: [marker],
      requiredToolOutputIncludes: [marker],
      finalTextIncludes: [marker],
    };

    const result = evaluateLiveRun(mutationScenario, {
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
              data: {
                submitted: true,
                submissionVerified: true,
                pageVerification: {
                  mode: 'full',
                  elements: [
                    { r: 'statictext', n: `${marker}: result 2` },
                    { r: 'textbox', n: '' },
                  ],
                },
              },
            }),
          },
        ),
      ],
    });

    expect(result.passed).toBe(true);
  });

  it('requires structural readback after a submit-like click', () => {
    const marker = 'ChatBrowserX mail self-check live_123';
    const mutationScenario: LiveScenario = {
      ...scenario,
      allowRemoteMutation: true,
      forbidSubmittedType: true,
      requiredTools: ['browser_inspect', 'browser_click'],
      requiredToolOutputIncludes: [marker],
      finalTextIncludes: [marker],
    };
    const beforeSubmit = [
      tool(
        'browser_inspect',
        { tabId: 0, mode: 'interactive', since: '' },
        {
          output: JSON.stringify({
            ok: true,
            data: {
              elements: [
                { r: 'button', n: 'Send', ref: 'send-button' },
                { r: 'statictext', n: marker },
              ],
            },
          }),
        },
      ),
      tool('browser_click', {
        tabId: 0,
        ref: 'send-button',
        button: 'left',
        count: 1,
      }),
    ];

    const notReadBack = evaluateLiveRun(mutationScenario, {
      terminalStatus: 'completed',
      finalText: `Sent and verified ${marker}`,
      toolResults: beforeSubmit,
    });
    expect(notReadBack.checks).toContainEqual(
      expect.objectContaining({
        name: 'required-tool-readback',
        passed: false,
      }),
    );

    const readBack = evaluateLiveRun(mutationScenario, {
      terminalStatus: 'completed',
      finalText: `Sent and verified ${marker}`,
      toolResults: [
        ...beforeSubmit,
        tool(
          'browser_click',
          { tabId: 0, ref: 'sent-message', button: 'left', count: 1 },
          {
            output: JSON.stringify({
              ok: true,
              data: {
                verification: {
                  upsert: [{ e: { r: 'statictext', n: marker } }],
                },
              },
            }),
          },
        ),
      ],
    });
    expect(readBack.checks).toContainEqual(
      expect.objectContaining({ name: 'required-tool-readback', passed: true }),
    );
  });

  it('retains structural readback evidence across multiple submit-like clicks', () => {
    const firstMarker = 'ChatBrowserX first message live_123';
    const secondMarker = 'ChatBrowserX second message live_123';
    const mutationScenario: LiveScenario = {
      ...scenario,
      allowRemoteMutation: true,
      forbidSubmittedType: true,
      requiredTools: ['browser_inspect', 'browser_type', 'browser_click'],
      requiredToolOutputIncludes: [firstMarker, secondMarker],
      finalTextIncludes: [firstMarker, secondMarker],
    };
    const result = evaluateLiveRun(mutationScenario, {
      terminalStatus: 'completed',
      finalText: `${firstMarker}\n${secondMarker}`,
      toolResults: [
        tool(
          'browser_inspect',
          { tabId: 0, mode: 'interactive', since: '' },
          {
            output: JSON.stringify({
              ok: true,
              data: {
                elements: [{ r: 'button', n: 'Send', ref: 'send-button' }],
              },
            }),
          },
        ),
        tool('browser_type', {
          tabId: 0,
          ref: 'message-editor',
          text: firstMarker,
          replace: true,
          submit: false,
        }),
        tool(
          'browser_click',
          { tabId: 0, ref: 'send-button', button: 'left', count: 1 },
          {
            output: JSON.stringify({
              ok: true,
              data: {
                verification: {
                  upsert: [{ e: { r: 'statictext', n: firstMarker } }],
                },
              },
            }),
          },
        ),
        tool('browser_type', {
          tabId: 0,
          ref: 'message-editor',
          text: secondMarker,
          replace: true,
          submit: false,
        }),
        tool(
          'browser_click',
          { tabId: 0, ref: 'send-button', button: 'left', count: 1 },
          {
            output: JSON.stringify({
              ok: true,
              data: {
                verification: {
                  upsert: [{ e: { r: 'statictext', n: secondMarker } }],
                },
              },
            }),
          },
        ),
      ],
    });

    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: 'required-tool-readback', passed: true }),
    );
  });

  it('requires each declared mutation to be read back after its named action', () => {
    const calendarMarker = 'ChatBrowserX calendar live_123';
    const mailMarker = 'ChatBrowserX mail live_123';
    const mutationScenario = {
      ...scenario,
      allowRemoteMutation: true,
      forbidSubmittedType: true,
      requiredTools: ['browser_inspect', 'browser_click'],
      requiredMutationReadbacks: [
        { actionName: 'Save', includes: [calendarMarker, 'Saved'] },
        { actionName: 'Send', includes: [mailMarker, 'Me', 'Content image'] },
      ],
      finalTextIncludes: [calendarMarker, mailMarker],
    } as LiveScenario & {
      readonly requiredMutationReadbacks: readonly {
        readonly actionName: string;
        readonly includes: readonly string[];
      }[];
    };
    const controls = tool(
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: '' },
      {
        output: JSON.stringify({
          ok: true,
          data: {
            elements: [
              { r: 'button', n: 'Save', ref: 'save-button' },
              { r: 'button', n: 'Send', ref: 'send-button' },
              { r: 'statictext', n: calendarMarker },
              { r: 'statictext', n: mailMarker },
              { r: 'image', n: 'Content image' },
            ],
          },
        }),
      },
    );
    const save = tool(
      'browser_click',
      { tabId: 0, ref: 'save-button', button: 'left', count: 1 },
      {
        output: JSON.stringify({
          ok: true,
          data: {
            verification: {
              upsert: [
                { e: { r: 'statictext', n: calendarMarker } },
                { e: { r: 'statictext', n: 'Saved' } },
              ],
            },
          },
        }),
      },
    );
    const send = tool(
      'browser_click',
      { tabId: 0, ref: 'send-button', button: 'left', count: 1 },
      {
        output: JSON.stringify({
          ok: true,
          data: {
            verification: {
              upsert: [{ e: { r: 'statictext', n: 'Sending...' } }],
            },
          },
        }),
      },
    );

    const missingSentReadback = evaluateLiveRun(mutationScenario, {
      terminalStatus: 'completed',
      finalText: `${calendarMarker}; ${mailMarker}`,
      toolResults: [controls, save, send],
    });
    expect(missingSentReadback.checks).toContainEqual(
      expect.objectContaining({
        name: 'required-mutation-readback',
        passed: false,
      }),
    );

    const completeReadback = evaluateLiveRun(mutationScenario, {
      terminalStatus: 'completed',
      finalText: `${calendarMarker}; ${mailMarker}`,
      toolResults: [
        controls,
        save,
        send,
        tool(
          'browser_inspect',
          { tabId: 0, mode: 'interactive', since: '' },
          {
            output: JSON.stringify({
              ok: true,
              data: {
                elements: [
                  { r: 'statictext', n: mailMarker },
                  { r: 'statictext', n: 'Me' },
                  { r: 'image', n: 'Content image' },
                ],
              },
            }),
          },
        ),
      ],
    });
    expect(completeReadback.checks).toContainEqual(
      expect.objectContaining({
        name: 'required-mutation-readback',
        passed: true,
      }),
    );
  });

  it('accepts a required typed marker contained inside a longer submitted message', () => {
    const marker = 'ChatBrowserX summary live_123';
    const mutationScenario: LiveScenario = {
      ...scenario,
      allowRemoteMutation: true,
      forbidSubmittedType: false,
      requiredTools: ['browser_type'],
      expectedSubmittedTypeCount: 1,
      requiredTypedTextIncludes: [marker, '| Group | Summary |'],
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
            text: `${marker}\n| Group | Summary |\n| --- | --- |\n| A | Recent content |`,
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
      ],
    };

    expect(evaluateLiveRun(mutationScenario, input).passed).toBe(true);
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
      toolDefinitionCharacters: 256,
      toolDefinitionFingerprint: 'aaaaaaaaaaaaaaaa',
      skillCatalogDisclosureCount: 0,
      toolChoice: 'auto',
      inputItems: [
        {
          position: 0,
          type: 'message',
          role: 'user',
          contentTypes: ['input_text'],
          textCharacters: 64,
          matchesActiveUserRequest: true,
        },
      ],
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

    const recoveredTransportRetry = evaluateLiveRun(scenario, {
      ...completedInput(),
      providerRetryReasons: ['transient_model_retry:upstream_failure'],
      providerTrace: {
        requestCount: 2,
        requests: [
          {
            ...request,
            response: {
              status: null,
              contentType: null,
              bodyBytes: 0,
              bodyTooLarge: false,
              completed: false,
              failed: false,
              eventTypes: [],
              encryptedReasoningOutputCount: 0,
              captureError: null,
            },
          },
          {
            ...request,
            sequence: 2,
            response: { ...request.response, encryptedReasoningOutputCount: 0 },
          },
        ],
      },
    });
    expect(recoveredTransportRetry.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'provider-response-evidence',
          passed: true,
        }),
      ]),
    );
    expect(recoveredTransportRetry.passed).toBe(true);

    const recoveredHttpRetry = evaluateLiveRun(scenario, {
      ...completedInput(),
      providerRetryReasons: ['transient_model_retry:upstream_failure'],
      providerTrace: {
        requestCount: 2,
        requests: [
          {
            ...request,
            response: {
              ...request.response,
              status: 503,
              completed: false,
              failed: true,
              eventTypes: ['response.failed'],
              encryptedReasoningOutputCount: 0,
            },
          },
          {
            ...request,
            sequence: 2,
            response: { ...request.response, encryptedReasoningOutputCount: 0 },
          },
        ],
      },
    });
    expect(recoveredHttpRetry.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'provider-response-evidence',
          passed: true,
        }),
      ]),
    );
    expect(recoveredHttpRetry.passed).toBe(true);

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
        expect.objectContaining({
          name: 'provider-request-contract',
          passed: false,
        }),
        expect.objectContaining({
          name: 'encrypted-reasoning-continuation',
          passed: false,
        }),
      ]),
    );

    const freshScenario: LiveScenario = {
      ...scenario,
      requireFreshProviderContext: true,
    };
    const fresh = evaluateLiveRun(freshScenario, input);
    expect(fresh.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'fresh-provider-context',
          passed: true,
        }),
      ]),
    );

    const providerTrace = input.providerTrace;
    const secondRequest = providerTrace?.requests[1];
    if (providerTrace === undefined || secondRequest === undefined) {
      throw new Error('Expected the provider trace fixture to contain two requests.');
    }

    const contaminated = evaluateLiveRun(freshScenario, {
      ...input,
      providerTrace: {
        ...providerTrace,
        requests: [
          {
            ...request,
            inputItems: [
              ...request.inputItems,
              {
                position: 1,
                type: 'message',
                role: 'assistant',
                contentTypes: ['output_text'],
                textCharacters: 20,
                matchesActiveUserRequest: false,
              },
            ],
          },
          secondRequest,
        ],
      },
    });
    expect(contaminated.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'fresh-provider-context',
          passed: false,
        }),
      ]),
    );
    expect(contaminated.passed).toBe(false);
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

  it('keeps bounded JSON parseable when only pretty printing would exceed the report limit', () => {
    const value = JSON.stringify({
      ok: true,
      observations: Array.from({ length: 40 }, (_, index) => ({
        index,
        text: `message-${String(index)}`,
      })),
    });
    const limit = value.length + 1;

    const sanitized = sanitizeToolPayload(value, limit);

    expect(sanitized.length).toBeLessThanOrEqual(limit);
    expect(JSON.parse(sanitized)).toMatchObject({ ok: true });
  });

  it('structurally truncates oversized JSON and records that evidence was omitted', () => {
    const value = JSON.stringify({
      ok: true,
      authorization: 'Bearer secret-value',
      observations: Array.from({ length: 80 }, (_, index) => ({
        index,
        text: `message-${String(index)}-${'x'.repeat(80)}`,
      })),
    });

    const sanitized = sanitizeToolPayload(value, 320);
    const parsed = JSON.parse(sanitized) as Readonly<Record<string, unknown>>;

    expect(sanitized.length).toBeLessThanOrEqual(320);
    expect(parsed).toMatchObject({ ok: true, __truncated__: true });
    expect(sanitized).not.toContain('secret-value');
  });
});
