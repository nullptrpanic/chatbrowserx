import { describe, expect, it } from 'vitest';

import {
  browserToolContractForCheckpoint,
  browserToolDefinitionsForCheckpoint,
} from '../../../src/agent/tools/browser-tool-availability';
import type { Checkpoint, CompletedToolResult } from '../../../src/tasks/checkpoint-types';
import type { ContinuationItem } from '../../../src/tasks/continuation-types';

function pair(
  callId: string,
  name: string,
  arguments_: unknown,
  output: unknown,
): readonly ContinuationItem[] {
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
      resultRef: `result_${callId}`,
      attachmentIds: [],
    },
  ];
}

function checkpoint(
  continuationItems: readonly ContinuationItem[] = [],
  completedToolResults: readonly CompletedToolResult[] = [],
): Checkpoint {
  return {
    id: 'checkpoint_1',
    taskId: 'task_1',
    sequence: 1,
    taskStatus: 'planning',
    completedToolResults,
    continuationItems,
    pendingToolCall: null,
    createdAt: 1,
  };
}

function names(value: Checkpoint): readonly string[] {
  return browserToolDefinitionsForCheckpoint(value).map(({ name }) => name);
}

describe('browserToolDefinitionsForCheckpoint', () => {
  it('starts with core semantic tools and no unsupported advanced capability', () => {
    const available = names(checkpoint());

    expect(available).toEqual(
      expect.arrayContaining([
        'browser_get_current_tab',
        'browser_inspect',
        'browser_click',
        'browser_set_checked',
        'browser_network_start',
      ]),
    );
    expect(available).not.toEqual(
      expect.arrayContaining([
        'browser_click_point',
        'browser_drag_point',
        'browser_network_list',
        'browser_network_get',
        'browser_network_stop',
        'browser_set_checked_many',
      ]),
    );
    expect(available).toContain('browser_paste_image');
    expect(new Set(available).size).toBe(available.length);
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

  it('enables network readers only while capture is active', () => {
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
    expect(names(checkpoint([...started, ...stopped]))).not.toContain('browser_network_get');
  });

  it('enables image delivery from a durable task-owned attachment', () => {
    const completed: CompletedToolResult = {
      callId: 'capture',
      toolName: 'browser_capture_screenshot',
      argumentsJson: '{}',
      output: '{"ok":true}',
      resultRef: 'result_capture',
      attachmentIds: ['attachment_1'],
    };

    const definition = browserToolDefinitionsForCheckpoint(checkpoint([], [completed])).find(
      ({ name }) => name === 'browser_paste_image',
    );

    expect(definition).toBeDefined();
    expect(definition?.description).toContain('remain valid across context compaction');
    expect(definition?.parameters).toMatchObject({
      properties: {
        assetId: {
          enum: ['attachment_1'],
        },
      },
    });
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
      tabId: 0,
      target: 'ref_history',
      remainingDeltaX: 0,
      remainingDeltaY: -9_035,
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
      tabId: 0,
      target: 'ref_history',
      remainingDeltaX: 0,
      remainingDeltaY: 0,
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
