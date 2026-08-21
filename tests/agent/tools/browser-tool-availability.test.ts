import { describe, expect, it } from 'vitest';

import { browserToolDefinitionsForCheckpoint } from '../../../src/agent/tools/browser-tool-availability';
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
        'browser_paste_image',
        'browser_set_checked_many',
      ]),
    );
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
      { ok: true, tabId: 7, data: { mode: 'interactive', snapshot: 's1', elements: [] } },
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

    expect(names(checkpoint([], [completed]))).toContain('browser_paste_image');
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

  it('fails closed when a prior capability output is malformed', () => {
    const malformed = pair(
      'inspect',
      'browser_inspect',
      { mode: 'screenshot', since: '' },
      'not-json',
    );

    expect(names(checkpoint(malformed))).not.toContain('browser_click_point');
  });
});
