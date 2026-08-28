import { describe, expect, it, vi } from 'vitest';

import {
  browserToolContractForCheckpoint,
  browserToolDefinitionsForCheckpoint,
  type BrowserToolState,
} from '../../../src/agent/tools/browser-tool-availability';
import { compactBrowserModelOutput } from '../../../src/browser/browser-model-output';
import type { Checkpoint } from '../../../src/tasks/checkpoint-types';
import type {
  ContinuationItem,
  MaterializedFunctionCallOutput,
} from '../../../src/tasks/continuation-types';
import type { MaterializedToolResult } from '../../../src/tasks/tool-result-types';

type TestContinuationItem = ContinuationItem | MaterializedFunctionCallOutput;

function pair(
  callId: string,
  name: string,
  arguments_: unknown,
  output: unknown,
): readonly TestContinuationItem[] {
  return [
    {
      type: 'function_call',
      callId,
      name,
      argumentsJson: JSON.stringify(arguments_),
    },
    {
      type: 'function_call_output',
      callId,
      output: typeof output === 'string' ? output : JSON.stringify(output),
      resultId: `result_${callId}`,
      attachmentIds: [],
    },
  ];
}

function checkpoint(
  items: readonly TestContinuationItem[] = [],
  toolResults: readonly MaterializedToolResult[] = [],
): BrowserToolState {
  const calls = new Map(
    items.flatMap((item) => (item.type === 'function_call' ? [[item.callId, item] as const] : [])),
  );
  const generatedResults: MaterializedToolResult[] = [];
  const continuationItems = items.map((item): ContinuationItem => {
    if (item.type !== 'function_call_output') return item;
    const call = calls.get(item.callId);
    if (call === undefined) throw new Error('Tool result fixture is missing its call.');
    generatedResults.push({
      id: item.resultId,
      taskId: 'task_1',
      runId: 'run_1',
      callId: item.callId,
      toolName: call.name,
      argumentsJson: call.argumentsJson,
      output: item.output,
      attachmentIds: item.attachmentIds ?? [],
      createdAt: 1,
    });
    return {
      type: 'function_call_output_ref',
      callId: item.callId,
      resultId: item.resultId,
      attachmentIds: item.attachmentIds ?? [],
    };
  });
  const checkpoint: Checkpoint = {
    id: 'checkpoint_1',
    taskId: 'task_1',
    runId: 'run_1',
    continuationItems,
    pendingToolCall: null,
    browserToolCallsInAttempt: 0,
    browserTargetTabId: 7,
    createdAt: 1,
  };
  return { checkpoint, toolResults: [...toolResults, ...generatedResults] };
}

function names(value: BrowserToolState): readonly string[] {
  return browserToolDefinitionsForCheckpoint(value).map(({ name }) => name);
}

describe('browserToolDefinitionsForCheckpoint', () => {
  it('parses each stored browser result only once while building one contract', () => {
    const output = JSON.stringify({
      ok: true,
      data: {
        mode: 'interactive',
        snapshot: 'snapshot_1',
        elements: [{ d: 1, r: 'button', n: 'Submit', ref: 'ref_submit' }],
      },
    });
    const parse = vi.spyOn(JSON, 'parse');

    try {
      browserToolContractForCheckpoint(
        checkpoint(pair('inspect_once', 'browser_inspect', { tabId: 0 }, output)),
      );

      expect(parse.mock.calls.filter(([value]) => value === output)).toHaveLength(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('keeps semantic action tools stable from the first model turn', () => {
    const available = names(checkpoint());

    expect(available).toEqual(
      expect.arrayContaining([
        'browser_inspect',
        'browser_navigate',
        'browser_click',
        'browser_set_checked',
        'browser_type',
        'browser_scroll',
        'browser_wait',
        'browser_network_start',
      ]),
    );
    expect(available).not.toContain('browser_get_current_tab');
    expect(available).not.toContain('browser_click_point');

    const inspected = checkpoint(
      pair(
        'inspect_1',
        'browser_inspect',
        { tabId: 0, mode: 'interactive', since: '' },
        {
          ok: true,
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_1',
            elements: [{ d: 1, r: 'button', n: 'Submit', ref: 'ref_submit' }],
          },
        },
      ),
    );
    expect(names(inspected)).toEqual(
      expect.arrayContaining(['browser_click', 'browser_set_checked', 'browser_scroll']),
    );
    const scroll = browserToolDefinitionsForCheckpoint(inspected).find(
      ({ name }) => name === 'browser_scroll',
    );
    expect(scroll?.parameters).toMatchObject({
      properties: { target: { type: 'string' } },
    });
    expect(
      (scroll?.parameters.properties as Readonly<Record<string, Readonly<Record<string, unknown>>>>)
        .target,
    ).not.toHaveProperty('enum');
    expect(available).not.toContain('browser_paste_image');
    expect(new Set(available).size).toBe(available.length);
  });

  it('keeps semantic ref actions available after an interactive deep inspection', () => {
    const inspected = checkpoint(
      pair(
        'inspect_deep',
        'browser_inspect',
        { tabId: 0, mode: 'interactive_deep', since: '' },
        {
          ok: true,
          data: {
            mode: 'interactive_deep',
            snapshot: 'snapshot_deep',
            elements: [
              { d: 1, r: 'button', n: 'Continue', ref: 'ref_continue' },
              {
                d: 1,
                r: 'list',
                n: 'Message history',
                a: ['scroll'],
                ref: 'ref_history',
              },
            ],
          },
        },
      ),
    );

    expect(names(inspected)).toEqual(expect.arrayContaining(['browser_click', 'browser_type']));
    const scroll = browserToolDefinitionsForCheckpoint(inspected).find(
      ({ name }) => name === 'browser_scroll',
    );
    expect(scroll?.parameters).toMatchObject({
      properties: { target: { enum: ['ref_history'] } },
    });
  });

  it('keeps a retained current-tab call available while replaying the current task', () => {
    const currentTab = pair(
      'current_tab',
      'browser_get_current_tab',
      {},
      {
        ok: true,
        tabId: 7,
        url: 'https://example.com/',
        data: { title: 'Example', taskBound: true },
      },
    );

    expect(names(checkpoint(currentTab))).toContain('browser_get_current_tab');
  });

  it('binds unified scrolling to current interactive scroll refs when available', () => {
    const inspected = pair(
      'inspect_scrollable',
      'browser_inspect',
      { mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 's_scrollable',
          elements: [
            { ref: 'ref_label', r: 'statictext', n: 'Messages' },
            {
              ref: 'ref_history',
              r: 'list',
              n: 'Message history',
              a: ['scroll'],
            },
          ],
        },
      },
    );

    const definition = browserToolDefinitionsForCheckpoint(checkpoint(inspected)).find(
      ({ name }) => name === 'browser_scroll',
    );
    expect(definition).toBeDefined();
    expect(definition?.parameters).toMatchObject({
      properties: { target: { enum: ['ref_history'] } },
    });

    const navigated = pair(
      'navigate_after_scroll',
      'browser_navigate',
      { tabId: 0, url: 'https://example.com/other' },
      { ok: true, tabId: 7, data: { title: 'Other page' } },
    );
    const afterNavigation = browserToolDefinitionsForCheckpoint(
      checkpoint([...inspected, ...navigated]),
    ).find(({ name }) => name === 'browser_scroll');
    expect(afterNavigation).toBeDefined();
    expect(
      (
        afterNavigation?.parameters.properties as Readonly<
          Record<string, Readonly<Record<string, unknown>>>
        >
      ).target,
    ).not.toHaveProperty('enum');
  });

  it('binds unified scrolling to a scrollable document viewport from coverage', () => {
    const inspected = pair(
      'inspect_viewport',
      'browser_inspect',
      { mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 's_viewport',
          elements: [{ r: 'statictext', n: 'Visible document text' }],
          coverage: {
            complete: false,
            targets: ['viewport'],
            primaryTarget: 'viewport',
            recommendedAction: 'browser_scroll',
          },
        },
      },
    );

    const definition = browserToolDefinitionsForCheckpoint(checkpoint(inspected)).find(
      ({ name }) => name === 'browser_scroll',
    );

    expect(definition?.parameters).toMatchObject({
      properties: { target: { enum: ['viewport'] } },
    });
  });

  it('enables unified scrolling from a keyed interactive delta', () => {
    const full = pair(
      'inspect_full',
      'browser_inspect',
      { mode: 'interactive', since: '' },
      {
        ok: true,
        data: { mode: 'interactive', snapshot: 's1', elements: [] },
      },
    );
    const delta = pair(
      'inspect_delta',
      'browser_inspect',
      { mode: 'interactive', since: 's1' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 's2',
          base: 's1',
          upsert: [
            {
              k: 'ref:ref_history',
              e: { ref: 'ref_history', r: 'list', n: 'History', a: ['scroll'] },
            },
          ],
          remove: [],
        },
      },
    );

    expect(names(checkpoint([...full, ...delta]))).toContain('browser_scroll');
  });

  it('reconstructs current scroll refs from compact traversal evidence', () => {
    const inspected = pair(
      'inspect_old_scroll',
      'browser_inspect',
      { mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 's1',
          elements: [{ ref: 'ref_old', r: 'region', n: 'Old surface', a: ['scroll'] }],
        },
      },
    );
    const fullScrollOutput = JSON.stringify({
      ok: true,
      tabId: 7,
      url: 'https://example.com/document',
      data: {
        action: 'scroll',
        mode: 'traverse',
        stopReason: 'boundary_verified',
        observations: [
          {
            mode: 'interactive',
            snapshot: 's2',
            base: 's1',
            remove: ['node:old-copy', 'ref:ref_old'],
            upsert: [
              {
                k: 'ref:ref_new',
                e: {
                  ref: 'ref_new',
                  r: 'region',
                  n: 'Current surface',
                  a: ['scroll'],
                },
              },
            ],
          },
        ],
      },
      observation: null,
    });
    const scrolled = pair(
      'scroll_with_compact_evidence',
      'browser_scroll',
      {
        tabId: 0,
        target: 'ref_old',
        deltaX: 0,
        deltaY: 800,
        maxSegments: 8,
        stopText: '',
      },
      compactBrowserModelOutput(fullScrollOutput),
    );

    const definition = browserToolDefinitionsForCheckpoint(
      checkpoint([...inspected, ...scrolled]),
    ).find(({ name }) => name === 'browser_scroll');

    expect(definition?.parameters).toMatchObject({
      properties: { target: { enum: ['ref_new'] } },
    });
  });

  it('uses attached fresh interactive evidence from a failed action', () => {
    const failedWithFreshState = pair(
      'stale_click',
      'browser_click',
      { tabId: 0, ref: 'ref_old', button: 'left', count: 1 },
      {
        ok: false,
        code: 'STALE_REF',
        retryable: true,
        needsInspect: false,
        data: {
          verification: {
            mode: 'interactive',
            snapshot: 'snapshot_fresh',
            elements: [
              { r: 'checkbox', n: 'One', a: ['set_checked'], ref: 'ref_one' },
              { r: 'checkbox', n: 'Two', a: ['set_checked'], ref: 'ref_two' },
              { r: 'list', n: 'History', a: ['scroll'], ref: 'ref_history' },
            ],
          },
        },
      },
    );

    const available = browserToolDefinitionsForCheckpoint(checkpoint(failedWithFreshState));
    expect(available.map(({ name }) => name)).toContain('browser_set_checked_many');
    expect(available.find(({ name }) => name === 'browser_scroll')?.parameters).toMatchObject({
      properties: { target: { enum: ['ref_history'] } },
    });
  });

  it('enables coordinate actions only for the current successful screenshot inspection', () => {
    const screenshot = pair(
      'screenshot',
      'browser_inspect',
      { mode: 'screenshot', since: '' },
      {
        ok: true,
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'screenshot', width: 800, height: 600 },
      },
    );
    expect(names(checkpoint(screenshot))).toEqual(
      expect.arrayContaining(['browser_click_point', 'browser_drag_point']),
    );

    const semantic = pair(
      'semantic',
      'browser_inspect',
      { mode: 'interactive', since: '' },
      {
        ok: true,
        tabId: 7,
        data: { mode: 'interactive', snapshot: 's1', elements: [] },
      },
    );
    expect(names(checkpoint([...screenshot, ...semantic]))).not.toEqual(
      expect.arrayContaining(['browser_click_point', 'browser_drag_point']),
    );
  });

  it('keeps network readers available for a frozen capture after stop', () => {
    const started = pair(
      'start',
      'browser_network_start',
      {},
      { ok: true, data: { started: true } },
    );
    expect(names(checkpoint(started))).toEqual(
      expect.arrayContaining([
        'browser_network_list',
        'browser_network_get',
        'browser_network_stop',
      ]),
    );

    const stopped = pair('stop', 'browser_network_stop', {}, { ok: true, data: { stopped: true } });
    expect(names(checkpoint([...started, ...stopped]))).toEqual(
      expect.arrayContaining(['browser_network_list', 'browser_network_get']),
    );
  });

  it('exposes network readers only after a successful capture start', () => {
    const initial = names(checkpoint());
    expect(initial).toContain('browser_network_start');
    expect(initial).not.toEqual(
      expect.arrayContaining([
        'browser_network_list',
        'browser_network_get',
        'browser_network_stop',
      ]),
    );

    const failed = pair(
      'failed-start',
      'browser_network_start',
      {},
      { ok: false, code: 'NETWORK_CAPTURE_LOST' },
    );
    expect(names(checkpoint(failed))).not.toEqual(
      expect.arrayContaining([
        'browser_network_list',
        'browser_network_get',
        'browser_network_stop',
      ]),
    );
  });

  it('enables image delivery from a durable task-owned attachment', () => {
    const completed: MaterializedToolResult = {
      id: 'result_capture',
      taskId: 'task_1',
      runId: 'run_1',
      callId: 'capture',
      toolName: 'browser_capture_screenshot',
      argumentsJson: '{}',
      output: '{"ok":true}',
      attachmentIds: ['attachment_1'],
      createdAt: 1,
    };

    const definition = browserToolDefinitionsForCheckpoint(checkpoint([], [completed])).find(
      ({ name }) => name === 'browser_paste_image',
    );

    expect(definition).toBeDefined();
    expect(definition?.description).toContain('available after capture');
    expect(definition?.parameters).toMatchObject({
      properties: {
        assetId: {
          enum: ['attachment_1'],
        },
      },
    });
  });

  it('retains a used image-delivery definition until the replay window is compacted', () => {
    const used = pair(
      'paste',
      'browser_paste_image',
      { tabId: 0, ref: 'ref_editor', assetId: 'attachment_expired' },
      { ok: true, data: { action: 'paste_image', verified: true } },
    );

    expect(names(checkpoint(used))).toContain('browser_paste_image');

    const compacted: ContinuationItem = {
      type: 'compaction',
      itemId: 'cmp_paste',
      encryptedContent: 'opaque',
    };
    expect(names(checkpoint([...used, compacted]))).not.toContain('browser_paste_image');
  });

  it('enables batch selection after two selectable refs are present in semantic state', () => {
    const inspected = pair(
      'inspect',
      'browser_inspect',
      { mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 's1',
          elements: [
            { ref: 'ref_1', n: 'A', a: ['set_checked'] },
            { ref: 'ref_2', n: 'B', a: ['set_checked'] },
          ],
        },
      },
    );

    expect(names(checkpoint(inspected))).toContain('browser_set_checked_many');
  });

  it('retains a used advanced tool until a successful context commit', () => {
    const used = pair(
      'point',
      'browser_click_point',
      { x: 10, y: 10, button: 'left', count: 1 },
      { ok: true, data: { action: 'click_point' } },
    );
    expect(names(checkpoint(used))).toContain('browser_click_point');

    const committed = pair(
      'commit',
      'commit_context',
      { state: 'Continue from semantic state.' },
      { ok: true, compactedCalls: 1 },
    );
    expect(names(checkpoint([...used, ...committed]))).not.toContain('browser_click_point');
  });

  it('resets derived browser capabilities at a native compaction boundary', () => {
    const used = pair(
      'point',
      'browser_click_point',
      { x: 10, y: 10, button: 'left', count: 1 },
      { ok: true, data: { action: 'click_point' } },
    );
    const compacted: ContinuationItem = {
      type: 'compaction',
      itemId: 'cmp_1',
      encryptedContent: 'opaque',
    };

    expect(names(checkpoint([...used, compacted]))).not.toContain('browser_click_point');
  });

  it('fails closed when a prior capability output is malformed', () => {
    const malformed = pair(
      'inspect',
      'browser_inspect',
      { mode: 'screenshot', since: '' },
      'not-json',
    );

    expect(names(checkpoint(malformed))).not.toContain('browser_click_point');
  });

  it('requires an interactive inspection after a virtualized scroll leaves requested distance', () => {
    const incompleteScroll = pair(
      'scroll_incomplete',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -10_000 },
      {
        ok: true,
        tabId: 7,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -9_035,
          loadedMore: true,
          boundaryVerified: false,
        },
      },
    );

    const contract = browserToolContractForCheckpoint(checkpoint(incompleteScroll));

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_inspect',
    });
    expect(contract.tools.map(({ name }) => name)).toEqual(['browser_inspect']);
    expect(contract.tools[0]?.parameters).toMatchObject({
      properties: {
        tabId: { enum: [0] },
        mode: { enum: ['interactive'] },
      },
    });
    expect(contract.scrollContinuation).toEqual({
      next: 'inspect',
      mode: 'distance',
      tabId: 0,
      target: 'ref_history',
      remainingDeltaX: 0,
      remainingDeltaY: -9_035,
      maxSegments: 1,
      stopText: '',
    });
  });

  it('continues an unfinished scroll directly when the action already returned interactive evidence', () => {
    const incompleteScroll = pair(
      'scroll_with_evidence',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -10_000 },
      {
        ok: true,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -8_800,
          loadedMore: true,
          boundaryVerified: false,
          observations: [
            {
              mode: 'interactive',
              snapshot: 'snapshot_1',
              base: 'snapshot_0',
              upsert: [],
            },
            {
              mode: 'interactive',
              snapshot: 'snapshot_2',
              base: 'snapshot_1',
              upsert: [],
            },
          ],
        },
      },
    );

    const contract = browserToolContractForCheckpoint(checkpoint(incompleteScroll));

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_scroll',
    });
    expect(contract.tools.map(({ name }) => name)).toEqual(['browser_scroll']);
    expect(contract.scrollContinuation).toMatchObject({
      next: 'scroll',
      remainingDeltaX: 0,
      remainingDeltaY: -8_800,
    });
  });

  it('leaves an objective-level traversal optional after its evidence budget is exhausted', () => {
    const boundedTraversal = pair(
      'scroll_traversal_evidence_budget',
      'browser_scroll',
      {
        tabId: 0,
        target: 'ref_history',
        deltaX: 0,
        deltaY: -800,
        maxSegments: 12,
        stopText: '2026年7月',
      },
      {
        ok: true,
        tabId: 7,
        data: {
          action: 'scroll',
          mode: 'traverse',
          target: 'ref_history',
          stopReason: 'evidence_budget',
          continuationRequired: true,
          nextDeltaX: 0,
          nextDeltaY: -800,
          observations: [
            {
              mode: 'interactive',
              snapshot: 'snapshot_2',
              base: 'snapshot_1',
              upsert: [],
            },
          ],
        },
      },
    );

    const contract = browserToolContractForCheckpoint(checkpoint(boundedTraversal));

    expect(contract.toolChoice).toBeUndefined();
    expect(contract.scrollContinuation).toBeUndefined();
    expect(contract.tools.map(({ name }) => name)).toContain('browser_scroll');
    expect(contract.tools.map(({ name }) => name)).toContain('browser_inspect');
  });

  it('inspects and then resumes the same bounded traversal after observation loss', () => {
    const interruptedTraversal = pair(
      'scroll_traversal_observation_loss',
      'browser_scroll',
      {
        tabId: 0,
        target: 'ref_old',
        deltaX: 0,
        deltaY: 900,
        maxSegments: 8,
        stopText: '',
      },
      {
        ok: true,
        data: {
          action: 'scroll',
          mode: 'traverse',
          stopReason: 'observation_unavailable',
          continuationRequired: true,
          verificationUnavailable: true,
          observations: [],
        },
      },
    );

    const inspectContract = browserToolContractForCheckpoint(checkpoint(interruptedTraversal));
    expect(inspectContract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_inspect',
    });
    expect(inspectContract.scrollContinuation).toMatchObject({
      next: 'inspect',
      mode: 'traverse',
    });

    const refreshed = pair(
      'inspect_traversal_replacement',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 'snapshot_3',
          elements: [
            {
              d: 40,
              r: 'region',
              n: 'Message history',
              a: ['scroll'],
              ref: 'ref_new',
            },
          ],
        },
      },
    );
    const resumed = browserToolContractForCheckpoint(
      checkpoint([...interruptedTraversal, ...refreshed]),
    );

    expect(resumed.toolChoice).toEqual({
      type: 'function',
      name: 'browser_scroll',
    });
    expect(resumed.tools[0]?.parameters).toMatchObject({
      properties: {
        target: { enum: ['ref_new'] },
        deltaX: { enum: [0] },
        deltaY: { enum: [900] },
        maxSegments: { enum: [8] },
        stopText: { enum: [''] },
      },
    });
  });

  it('keeps a bounded traversal mandatory when refresh exposes multiple replacement targets', () => {
    const interruptedTraversal = pair(
      'scroll_traversal_multiple_replacements',
      'browser_scroll',
      {
        tabId: 0,
        target: 'ref_old',
        deltaX: 0,
        deltaY: -700,
        maxSegments: 10,
        stopText: 'July',
      },
      {
        ok: true,
        data: {
          action: 'scroll',
          mode: 'traverse',
          stopReason: 'observation_unavailable',
          continuationRequired: true,
          verificationUnavailable: true,
          observations: [],
        },
      },
    );
    const refreshed = pair(
      'inspect_multiple_replacements',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 'snapshot_replacements',
          elements: [
            {
              d: 20,
              r: 'region',
              n: 'Document',
              a: ['scroll'],
              ref: 'ref_document',
            },
            {
              d: 24,
              r: 'region',
              n: 'Comments',
              a: ['scroll'],
              ref: 'ref_comments',
            },
          ],
        },
      },
    );

    const contract = browserToolContractForCheckpoint(
      checkpoint([...interruptedTraversal, ...refreshed]),
    );

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_scroll',
    });
    expect(contract.tools[0]?.parameters).toMatchObject({
      properties: {
        target: { enum: ['ref_document', 'ref_comments'] },
        deltaY: { enum: [-700] },
        maxSegments: { enum: [10] },
        stopText: { enum: ['July'] },
      },
    });
  });

  it('releases the bounded traversal contract after a verified terminal receipt', () => {
    const completedTraversal = pair(
      'scroll_traversal_boundary',
      'browser_scroll',
      {
        tabId: 0,
        target: 'ref_document',
        deltaX: 0,
        deltaY: 900,
        maxSegments: 8,
        stopText: '',
      },
      {
        ok: true,
        data: {
          action: 'scroll',
          mode: 'traverse',
          stopReason: 'boundary_verified',
          continuationRequired: false,
          boundaryVerified: true,
          observations: [
            {
              mode: 'interactive',
              snapshot: 'snapshot_boundary',
              upsert: [],
            },
          ],
        },
      },
    );

    const contract = browserToolContractForCheckpoint(checkpoint(completedTraversal));

    expect(contract.toolChoice).toBeUndefined();
    expect(contract.scrollContinuation).toBeUndefined();
    expect(contract.tools.map(({ name }) => name)).toContain('browser_scroll');
  });

  it('does not force a redundant inspection after a completed scroll returned interactive evidence', () => {
    const completedScroll = pair(
      'completed_scroll_with_evidence',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -600 },
      {
        ok: true,
        data: {
          action: 'scroll',
          requestedDeltaApplied: true,
          remainingDeltaX: 0,
          remainingDeltaY: 0,
          boundaryVerified: false,
          verification: {
            mode: 'interactive',
            snapshot: 'snapshot_3',
            base: 'snapshot_2',
            unchanged: true,
          },
        },
      },
    );

    const contract = browserToolContractForCheckpoint(checkpoint(completedScroll));

    expect(contract.toolChoice).toBeUndefined();
    expect(contract.scrollContinuation).toBeUndefined();
    expect(contract.tools.map(({ name }) => name)).not.toContain('browser_inspect');
    expect(contract.tools.map(({ name }) => name)).toContain('browser_scroll');
  });

  it('keeps inspection available when the embedded scroll evidence was truncated', () => {
    const completedScroll = pair(
      'completed_scroll_with_truncated_evidence',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -600 },
      {
        ok: true,
        data: {
          action: 'scroll',
          requestedDeltaApplied: true,
          remainingDeltaX: 0,
          remainingDeltaY: 0,
          boundaryVerified: false,
          verification: {
            mode: 'interactive',
            snapshot: 'snapshot_3',
            base: 'snapshot_2',
            truncated: true,
          },
        },
      },
    );

    const contract = browserToolContractForCheckpoint(checkpoint(completedScroll));

    expect(contract.tools.map(({ name }) => name)).toContain('browser_inspect');
  });

  it('requires inspection when a later internal scroll segment could not be observed', () => {
    const partiallyObservedScroll = pair(
      'partially_observed_scroll',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -3_000 },
      {
        ok: true,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -1_000,
          boundaryVerified: false,
          verificationUnavailable: true,
          continuationLimited: 'observation_unavailable',
          observations: [
            {
              mode: 'interactive',
              snapshot: 'snapshot_1',
              base: 'snapshot_0',
              upsert: [],
            },
          ],
        },
      },
    );

    const contract = browserToolContractForCheckpoint(checkpoint(partiallyObservedScroll));

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_inspect',
    });
    expect(contract.scrollContinuation).toMatchObject({ next: 'inspect' });
  });

  it('rebinds one failed scroll continuation to the sole fresh scrollable ref', () => {
    const initial = pair(
      'scroll_partial',
      'browser_scroll',
      { tabId: 0, target: 'ref_old', deltaX: 0, deltaY: -3_000 },
      {
        ok: true,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -900,
          boundaryVerified: false,
          verification: {
            mode: 'interactive',
            snapshot: 'snapshot_1',
            unchanged: true,
          },
        },
      },
    );
    const stale = pair(
      'scroll_stale',
      'browser_scroll',
      { tabId: 0, target: 'ref_old', deltaX: 0, deltaY: -900 },
      { ok: false, code: 'STALE_REF', retryable: true, needsInspect: true },
    );
    const refreshed = pair(
      'inspect_replacement',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 'snapshot_2',
          elements: [
            {
              d: 40,
              r: 'region',
              n: 'Message history',
              a: ['scroll'],
              ref: 'ref_new',
            },
          ],
        },
      },
    );

    const contract = browserToolContractForCheckpoint(
      checkpoint([...initial, ...stale, ...refreshed]),
    );

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_scroll',
    });
    expect(contract.tools[0]?.parameters).toMatchObject({
      properties: { target: { enum: ['ref_new'] }, deltaY: { enum: [-900] } },
    });
  });

  it('releases a scroll continuation after a second target failure instead of looping', () => {
    const initial = pair(
      'scroll_partial',
      'browser_scroll',
      { tabId: 0, target: 'ref_old', deltaX: 0, deltaY: -3_000 },
      {
        ok: true,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -900,
          boundaryVerified: false,
          verification: {
            mode: 'interactive',
            snapshot: 'snapshot_1',
            unchanged: true,
          },
        },
      },
    );
    const firstFailure = pair(
      'scroll_stale_old',
      'browser_scroll',
      { tabId: 0, target: 'ref_old', deltaX: 0, deltaY: -900 },
      { ok: false, code: 'STALE_REF', retryable: true, needsInspect: true },
    );
    const firstRefresh = pair(
      'inspect_new_ref',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 'snapshot_2',
          elements: [
            {
              d: 40,
              r: 'region',
              n: 'Message history',
              a: ['scroll'],
              ref: 'ref_new',
            },
          ],
        },
      },
    );
    const secondFailure = pair(
      'scroll_stale_new',
      'browser_scroll',
      { tabId: 0, target: 'ref_new', deltaX: 0, deltaY: -900 },
      { ok: false, code: 'STALE_REF', retryable: true, needsInspect: true },
    );
    const secondRefresh = pair(
      'inspect_after_second_failure',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: '' },
      {
        ok: true,
        data: {
          mode: 'interactive',
          snapshot: 'snapshot_3',
          elements: [
            {
              d: 40,
              r: 'region',
              n: 'Message history',
              a: ['scroll'],
              ref: 'ref_newer',
            },
          ],
        },
      },
    );

    const contract = browserToolContractForCheckpoint(
      checkpoint([
        ...initial,
        ...firstFailure,
        ...firstRefresh,
        ...secondFailure,
        ...secondRefresh,
      ]),
    );

    expect(contract.toolChoice).toBeUndefined();
    expect(contract.scrollContinuation).toBeUndefined();
    expect(contract.tools.map(({ name }) => name)).toContain('browser_scroll');
  });

  it('requires the exact remaining scroll after the newly exposed batch is inspected', () => {
    const incompleteScroll = pair(
      'scroll_incomplete',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -10_000 },
      {
        ok: true,
        tabId: 7,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -9_035,
          loadedMore: true,
          boundaryVerified: false,
        },
      },
    );
    const inspected = pair(
      'inspect_batch',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: 'snapshot_1' },
      {
        ok: true,
        tabId: 7,
        data: { mode: 'interactive', snapshot: 'snapshot_2', elements: [] },
      },
    );

    const contract = browserToolContractForCheckpoint(
      checkpoint([...incompleteScroll, ...inspected]),
    );

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_scroll',
    });
    expect(contract.tools.map(({ name }) => name)).toEqual(['browser_scroll']);
    expect(contract.tools[0]?.parameters).toMatchObject({
      properties: {
        tabId: { enum: [0] },
        target: { enum: ['ref_history'] },
        deltaX: { enum: [0] },
        deltaY: { enum: [-9_035] },
      },
    });
    expect(contract.scrollContinuation?.next).toBe('scroll');
  });

  it('constrains fractional browser measurements to a valid integer continuation delta', () => {
    const fractionalScroll = pair(
      'scroll_fractional_remaining',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -1_500 },
      {
        ok: true,
        tabId: 7,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -163.5,
          loadedMore: true,
          boundaryVerified: false,
        },
      },
    );
    const inspected = pair(
      'inspect_fractional_batch',
      'browser_inspect',
      { tabId: 0, mode: 'interactive' },
      {
        ok: true,
        tabId: 7,
        data: { mode: 'interactive', snapshot: 'snapshot_fractional' },
      },
    );

    const contract = browserToolContractForCheckpoint(
      checkpoint([...fractionalScroll, ...inspected]),
    );

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_scroll',
    });
    expect(contract.tools[0]?.parameters).toMatchObject({
      properties: {
        deltaX: { enum: [0] },
        deltaY: { type: 'integer', enum: [-164] },
      },
    });
    expect(contract.scrollContinuation).toMatchObject({
      remainingDeltaX: 0,
      remainingDeltaY: -164,
    });
  });

  it('requires a final inspection after the remaining scroll distance is applied', () => {
    const incompleteScroll = pair(
      'scroll_incomplete',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -10_000 },
      {
        ok: true,
        tabId: 7,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -9_035,
          boundaryVerified: false,
        },
      },
    );
    const inspected = pair(
      'inspect_batch',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: 'snapshot_1' },
      {
        ok: true,
        tabId: 7,
        data: { mode: 'interactive', snapshot: 'snapshot_2' },
      },
    );
    const completedScroll = pair(
      'scroll_completed',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -9_035 },
      {
        ok: true,
        tabId: 7,
        data: {
          action: 'scroll',
          requestedDeltaApplied: true,
          remainingDeltaX: 0,
          remainingDeltaY: 0,
          boundaryVerified: false,
        },
      },
    );

    const contract = browserToolContractForCheckpoint(
      checkpoint([...incompleteScroll, ...inspected, ...completedScroll]),
    );

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_inspect',
    });
    expect(contract.tools.map(({ name }) => name)).toEqual(['browser_inspect']);
    expect(contract.scrollContinuation).toEqual({
      next: 'inspect',
      mode: 'distance',
      tabId: 0,
      target: 'ref_history',
      remainingDeltaX: 0,
      remainingDeltaY: 0,
      maxSegments: 1,
      stopText: '',
    });
  });

  it('requires a same-direction probe after inspection when a scroll only just reached a boundary', () => {
    const reachedBoundary = pair(
      'scroll_reached_boundary',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -1_200 },
      {
        ok: true,
        tabId: 7,
        data: {
          action: 'scroll',
          requestedDeltaApplied: true,
          remainingDeltaX: 0,
          remainingDeltaY: 0,
          boundaryVerified: false,
          needsBoundaryProbe: true,
        },
      },
    );
    const inspected = pair(
      'inspect_boundary_batch',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: 'snapshot_2' },
      {
        ok: true,
        tabId: 7,
        data: { mode: 'interactive', snapshot: 'snapshot_3' },
      },
    );

    const contract = browserToolContractForCheckpoint(
      checkpoint([...reachedBoundary, ...inspected]),
    );

    expect(contract.toolChoice).toEqual({
      type: 'function',
      name: 'browser_scroll',
    });
    expect(contract.tools.map(({ name }) => name)).toEqual(['browser_scroll']);
    expect(contract.tools[0]?.parameters).toMatchObject({
      properties: {
        tabId: { enum: [0] },
        target: { enum: ['ref_history'] },
        deltaX: { enum: [0] },
        deltaY: { enum: [-1_200] },
      },
    });
    expect(contract.scrollContinuation?.next).toBe('scroll');
  });

  it('releases the boundary probe only after its result is inspected', () => {
    const reachedBoundary = pair(
      'scroll_reached_boundary',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -1_200 },
      {
        ok: true,
        data: {
          action: 'scroll',
          requestedDeltaApplied: true,
          remainingDeltaX: 0,
          remainingDeltaY: 0,
          boundaryVerified: false,
          needsBoundaryProbe: true,
        },
      },
    );
    const inspectedBatch = pair(
      'inspect_boundary_batch',
      'browser_inspect',
      { tabId: 0, mode: 'interactive' },
      { ok: true, data: { mode: 'interactive', snapshot: 'snapshot_3' } },
    );
    const verifiedBoundary = pair(
      'scroll_verified_boundary',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -1_200 },
      {
        ok: true,
        data: {
          action: 'scroll',
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: -1_200,
          boundaryVerified: true,
          needsBoundaryProbe: false,
        },
      },
    );

    const beforeInspection = browserToolContractForCheckpoint(
      checkpoint([...reachedBoundary, ...inspectedBatch, ...verifiedBoundary]),
    );

    expect(beforeInspection.toolChoice).toEqual({
      type: 'function',
      name: 'browser_inspect',
    });
    expect(beforeInspection.scrollContinuation).toMatchObject({
      next: 'inspect',
    });

    const inspectedBoundary = pair(
      'inspect_verified_boundary',
      'browser_inspect',
      { tabId: 0, mode: 'interactive' },
      {
        ok: true,
        data: { mode: 'interactive', snapshot: 'snapshot_4', unchanged: true },
      },
    );
    const afterInspection = browserToolContractForCheckpoint(
      checkpoint([
        ...reachedBoundary,
        ...inspectedBatch,
        ...verifiedBoundary,
        ...inspectedBoundary,
      ]),
    );

    expect(afterInspection.toolChoice).toBeUndefined();
    expect(afterInspection.scrollContinuation).toBeUndefined();
  });

  it('releases the forced scroll contract after the completed scroll is inspected', () => {
    const completedScroll = pair(
      'scroll_completed',
      'browser_scroll',
      { tabId: 0, target: 'ref_history', deltaX: 0, deltaY: -600 },
      {
        ok: true,
        tabId: 7,
        data: {
          action: 'scroll',
          requestedDeltaApplied: true,
          remainingDeltaX: 0,
          remainingDeltaY: 0,
          boundaryVerified: false,
        },
      },
    );
    const inspected = pair(
      'inspect_after_scroll',
      'browser_inspect',
      { tabId: 0, mode: 'interactive', since: 'snapshot_2' },
      {
        ok: true,
        tabId: 7,
        data: { mode: 'interactive', snapshot: 'snapshot_3' },
      },
    );

    const contract = browserToolContractForCheckpoint(
      checkpoint([...completedScroll, ...inspected]),
    );

    expect(contract.toolChoice).toBeUndefined();
    expect(contract.scrollContinuation).toBeUndefined();
    expect(contract.tools.map(({ name }) => name)).toContain('browser_inspect');
    expect(contract.tools.map(({ name }) => name)).toContain('browser_scroll');
  });
});
