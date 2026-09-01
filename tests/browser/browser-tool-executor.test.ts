import { describe, expect, it, vi } from 'vitest';
import { parseBrowserToolCall } from '../../src/tools/browser/contract';
import { BrowserToolExecutor } from '../../src/browser/browser-tool-executor';
import { NetworkCaptureError } from '../../src/browser/network/network-capture-registry';
import type { BrowserTabPort } from '../../src/browser/tab-service';

function tabPort(overrides: Partial<BrowserTabPort> = {}): BrowserTabPort {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async (tabId) => ({
      tabId,
      url: 'https://example.com/current',
      title: 'Current page',
      active: true,
    })),
    open: vi.fn(async () => ({
      tabId: 9,
      url: 'about:blank',
      title: '',
      active: true,
    })),
    activate: vi.fn(async (tabId) => ({
      tabId,
      url: 'https://example.com',
      title: '',
      active: true,
    })),
    close: vi.fn(async () => undefined),
    navigate: vi.fn(async (tabId, url) => ({
      tabId,
      url,
      title: '',
      active: true,
    })),
    reload: vi.fn(async (tabId) => ({
      tabId,
      url: 'https://example.com',
      title: '',
      active: true,
    })),
    ...overrides,
  };
}

function call(name: string, arguments_: unknown) {
  return parseBrowserToolCall({
    callId: 'call_1',
    name,
    argumentsJson: JSON.stringify(arguments_),
  });
}

async function primeVisualFallback(
  executor: BrowserToolExecutor,
  signal: AbortSignal,
  context: { readonly currentTabId: number; readonly sessionOwnerId?: string },
): Promise<void> {
  await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
}

describe('BrowserToolExecutor', () => {
  it('resolves the task-bound current tab without querying active tabs', async () => {
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs });

    const result = await executor.execute(
      call('browser_get_current_tab', {}),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(tabs.get).toHaveBeenCalledWith(7);
    expect(tabs.list).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      tabId: 7,
      url: 'https://example.com/current',
      data: { title: 'Current page', active: true, taskBound: true },
      observation: null,
    });
    expect(result.modelOutput).toBeUndefined();
  });

  it('inspects an explicitly selected background tab without activating it', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 8,
        url: 'https://example.com/background',
        data: { mode: 'content', text: 'Background page' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'none' as const,
      })),
    };
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs, observer });

    const result = await executor.execute(
      call('browser_inspect', { tabId: 8, mode: 'content' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(observer.inspect).toHaveBeenCalledWith(8, 'content', expect.any(AbortSignal));
    expect(tabs.activate).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, tabId: 8 });
  });

  it('forwards the requested interactive base snapshot to the observer', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/current',
        data: {
          mode: 'interactive',
          snapshot: 'snapshot_next',
          unchanged: true,
        },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    await executor.execute(
      call('browser_inspect', {
        tabId: 7,
        mode: 'interactive',
        since: 'snapshot_previous',
      }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(observer.inspect).toHaveBeenCalledWith(7, 'interactive', expect.any(AbortSignal), {
      since: 'snapshot_previous',
    });
  });

  it('maps tabId zero to the durable task target', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/current',
        data: { mode: 'content', text: 'Current page' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'none' as const,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const result = await executor.execute(
      call('browser_inspect', { tabId: 0, mode: 'content' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(observer.inspect).toHaveBeenCalledWith(7, 'content', expect.any(AbortSignal));
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, tabId: 7 });
  });

  it('binds a task-scoped call without tabId to the durable current tab', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'content', text: 'Current page' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'none' as const,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const result = await executor.execute(
      call('browser_inspect', { mode: 'content' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(observer.inspect).toHaveBeenCalledWith(7, 'content', expect.any(AbortSignal));
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, tabId: 7 });
  });

  it('does not execute an unbound task-scoped call without a durable current tab', async () => {
    const observer = { inspect: vi.fn() };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const result = await executor.execute(
      call('browser_inspect', { mode: 'content' }),
      new AbortController().signal,
    );

    expect(observer.inspect).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      code: 'CURRENT_TAB_UNAVAILABLE',
    });
  });

  it('passes the trusted bound tab to the action runtime', async () => {
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click', dispatched: true },
        observation: { targetPresent: true },
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), actions });

    await executor.execute(
      call('browser_click', { ref: 'ref_1', button: 'left', count: 1 }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({ tabId: 7, ref: 'ref_1' }),
      }),
      expect.any(AbortSignal),
    );
  });

  it('dispatches a tab operation and returns one bounded JSON envelope', async () => {
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs });

    const result = await executor.execute(
      call('browser_open_tab', { url: 'about:blank', activate: true }),
      new AbortController().signal,
    );

    expect(tabs.open).toHaveBeenCalledWith('about:blank', true);
    expect(result.attachmentIds).toEqual([]);
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      tabId: 9,
      url: 'about:blank',
      data: { title: '', active: true },
      observation: null,
    });
    expect(result.output.length).toBeLessThanOrEqual(64 * 1_024);
  });

  it('switches only the task target without activating the browser tab', async () => {
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs });

    const result = await executor.execute(
      call('browser_switch_tab', { tabId: 8 }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(tabs.get).toHaveBeenCalledWith(8);
    expect(tabs.activate).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, tabId: 8 });
  });

  it('returns a stable failure result without exposing tab errors', async () => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort({
        reload: vi.fn(async () => {
          throw Object.assign(new Error('Raw Chrome target details'), {
            code: 'LOAD_TIMEOUT',
          });
        }),
      }),
    });

    const result = await executor.execute(
      call('browser_reload', { tabId: 7 }),
      new AbortController().signal,
    );

    expect(JSON.parse(result.output)).toEqual({
      ok: false,
      code: 'LOAD_TIMEOUT',
      message: 'The page did not become ready in time.',
      retryable: true,
      needsInspect: true,
    });
    expect(result.output).not.toContain('Raw Chrome target details');
  });

  it('reports page operations as unavailable until their runtime is connected', async () => {
    const executor = new BrowserToolExecutor({ tabs: tabPort() });

    const result = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'content' }),
      new AbortController().signal,
    );

    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      code: 'OPERATION_UNAVAILABLE',
      retryable: false,
    });
  });

  it('dispatches inspect through the semantic observer and preserves its envelope', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'interactive', elements: [], truncated: false },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'none' as const,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const output = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
    );

    expect(observer.inspect).toHaveBeenCalledWith(7, 'interactive', expect.any(AbortSignal));
    expect(JSON.parse(output.output)).toEqual({
      ok: true,
      tabId: 7,
      url: 'https://example.com',
      data: { mode: 'interactive', elements: [], truncated: false },
      observation: null,
    });
  });

  it('retains native interactive inspection until the task runner releases it', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'interactive' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      sessions,
    });

    await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
      { currentTabId: 7, sessionOwnerId: 'runner_1' },
    );

    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1');
    expect(sessions.releaseOwner).not.toHaveBeenCalled();
    await executor.release('runner_1');
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1');
  });

  it('reuses the retained inspection attachment for the stable-ref action', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'interactive' },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click', dispatched: true },
        observation: { targetPresent: true },
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
      sessions,
    });
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
      context,
    );
    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1');
    expect(sessions.releaseOwner).not.toHaveBeenCalled();

    await executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
      context,
    );

    expect(sessions.retain).toHaveBeenCalledTimes(1);
    expect(sessions.releaseOwner).not.toHaveBeenCalled();
    await executor.release('runner_1');
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1');
  });

  it('keeps one runner attachment across inspect and action until the task releases it', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'interactive', elements: [] },
        observation: null,
        attachmentIds: [],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click', dispatched: true },
        observation: { targetPresent: true },
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
      sessions,
    });
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
      context,
    );
    await executor.execute(
      call('browser_click', {
        tabId: 7,
        ref: 'ref_1',
        button: 'left',
        count: 1,
      }),
      new AbortController().signal,
      context,
    );

    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1');
    expect(sessions.releaseOwner).not.toHaveBeenCalled();
    await executor.release('runner_1');
    expect(sessions.releaseOwner).toHaveBeenCalledTimes(1);
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1');
  });

  it('keeps a screenshot session attached until the task runner releases it', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'screenshot' },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: true,
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      sessions,
    });

    const signal = new AbortController().signal;
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };
    await primeVisualFallback(executor, signal, context);
    await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'screenshot' }),
      signal,
      context,
    );

    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1');
    expect(sessions.releaseOwner).not.toHaveBeenCalled();
    await executor.release('runner_1');
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1');
  });

  it('captures a delivery asset without requiring or changing model screenshot fallback state', async () => {
    const observer = {
      inspect: vi.fn(),
      capture: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/current',
        data: {
          mode: 'screenshot',
          mimeType: 'image/png',
          width: 800,
          height: 600,
          attachmentId: 'attachment_capture',
        },
        observation: null,
        attachmentIds: ['attachment_capture'],
        debuggerSession: 'ephemeral' as const,
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      sessions,
    });

    const result = await executor.execute(
      call('browser_capture_screenshot', { tabId: 0 }),
      new AbortController().signal,
      { currentTabId: 7, sessionOwnerId: 'runner_1' },
    );

    expect(observer.capture).toHaveBeenCalledWith(7, expect.any(AbortSignal));
    expect(observer.inspect).not.toHaveBeenCalled();
    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1');
    expect(JSON.parse(result.output)).toEqual({
      ok: true,
      tabId: 7,
      url: 'https://example.com/current',
      data: {
        mimeType: 'image/png',
        width: 800,
        height: 600,
        assetId: 'attachment_capture',
      },
      observation: null,
    });
    expect(result.attachmentIds).toEqual(['attachment_capture']);
    expect(result.modelAttachmentIds).toEqual([]);
  });

  it('pastes only a screenshot asset owned by the current task', async () => {
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/messages',
        data: { action: 'paste_image', dispatched: true, fileCount: 1 },
        observation: { targetPresent: true },
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      actions,
      sessions,
    });
    const signal = new AbortController().signal;
    const toolCall = call('browser_paste_image', {
      tabId: 0,
      ref: 'ref_editor',
      assetId: 'attachment_capture',
    });

    const denied = await executor.execute(toolCall, signal, {
      currentTabId: 7,
      sessionOwnerId: 'runner_1',
      availableAssetIds: [],
    });
    expect(JSON.parse(denied.output)).toMatchObject({
      ok: false,
      code: 'ASSET_NOT_AVAILABLE',
    });
    expect(actions.execute).not.toHaveBeenCalled();

    const allowed = await executor.execute(toolCall, signal, {
      currentTabId: 7,
      sessionOwnerId: 'runner_1',
      availableAssetIds: ['attachment_capture'],
    });
    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'paste_image',
        arguments: expect.objectContaining({
          tabId: 7,
          assetId: 'attachment_capture',
        }),
      }),
      signal,
    );
    expect(JSON.parse(allowed.output)).toMatchObject({
      ok: true,
      data: { action: 'paste_image', dispatched: true, fileCount: 1 },
    });
  });

  it('requires native interactive inspection before a model screenshot', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { mode: 'screenshot' },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: true,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const output = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'screenshot' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'INTERACTIVE_INSPECTION_REQUIRED',
      message: 'Inspect the page with mode interactive before requesting a screenshot.',
      retryable: true,
      needsInspect: true,
    });
    expect(observer.inspect).not.toHaveBeenCalled();
  });

  it('keeps semantic form workflows on AX refs instead of falling back to screenshots', async () => {
    const observer = {
      inspect: vi.fn(async (_tabId: number, mode: string) =>
        mode === 'interactive'
          ? {
              tabId: 7,
              url: 'https://example.com/exam',
              data: {
                mode: 'interactive',
                snapshot: 'snapshot_1',
                elements: [
                  {
                    d: 1,
                    r: 'option',
                    n: 'A. Answer',
                    s: ['selected=false'],
                    ref: 'ref_1',
                  },
                ],
              },
              observation: null,
              attachmentIds: [],
              debuggerSession: 'ephemeral' as const,
              visualFallbackAllowed: false,
            }
          : {
              tabId: 7,
              url: 'https://example.com/exam',
              data: { mode: 'screenshot' },
              observation: null,
              attachmentIds: ['attachment_1'],
              debuggerSession: 'ephemeral' as const,
            },
      ),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      signal,
      context,
    );
    const output = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'screenshot' }),
      signal,
      context,
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'SEMANTIC_INSPECTION_AVAILABLE',
      message:
        'The current accessibility tree already contains sufficient semantic targets. Continue with refs and verify state with mode interactive.',
      retryable: false,
      needsInspect: false,
    });
    expect(observer.inspect).toHaveBeenCalledOnce();
  });

  it('clears a selection mismatch fallback after fresh selectable refs are inspected', async () => {
    const observer = {
      inspect: vi.fn(async (_tabId: number, mode: string) => ({
        tabId: 7,
        url: 'https://example.com/exam',
        data:
          mode === 'screenshot'
            ? { mode: 'screenshot', width: 800, height: 600 }
            : {
                mode: 'interactive',
                snapshot: 'snapshot_1',
                elements: [
                  {
                    d: 1,
                    r: 'option',
                    n: 'A',
                    s: ['selected=false'],
                    a: ['set_checked'],
                    ref: 'ref_1',
                  },
                ],
              },
        observation: null,
        attachmentIds: mode === 'screenshot' ? ['attachment_1'] : [],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: false,
      })),
    };
    const actions = {
      execute: vi.fn(async () => {
        throw Object.assign(new Error('private state mismatch'), {
          code: 'ACTION_STATE_MISMATCH',
        });
      }),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    await executor.execute(
      call('browser_set_checked', { ref: 'ref_1', checked: true }),
      signal,
      context,
    );
    const screenshot = await executor.execute(
      call('browser_inspect', { mode: 'screenshot' }),
      signal,
      context,
    );

    expect(JSON.parse(screenshot.output)).toMatchObject({
      ok: false,
      code: 'SEMANTIC_INSPECTION_AVAILABLE',
    });
    expect(observer.inspect).toHaveBeenCalledTimes(2);
  });

  it('blocks the same failed semantic selection after a fresh ref is issued', async () => {
    let inspection = 0;
    const observer = {
      inspect: vi.fn(async () => {
        inspection += 1;
        return {
          tabId: 7,
          url: 'https://example.com/exam',
          data: {
            mode: 'interactive',
            snapshot: `snapshot_${String(inspection)}`,
            elements: [
              {
                d: 2,
                r: 'option',
                n: 'A. TCE service upgrade',
                s: ['selected=false'],
                a: ['set_checked'],
                ref: `ref_${String(inspection)}`,
              },
            ],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        };
      }),
    };
    const actions = {
      execute: vi.fn(async () => {
        throw Object.assign(new Error('selection did not settle'), {
          code: 'ACTION_STATE_MISMATCH',
        });
      }),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const first = await executor.execute(
      call('browser_set_checked', { ref: 'ref_1', checked: true }),
      signal,
      context,
    );
    const repeated = await executor.execute(
      call('browser_set_checked', { ref: 'ref_2', checked: true }),
      signal,
      context,
    );

    expect(JSON.parse(first.output)).toMatchObject({
      ok: false,
      code: 'ACTION_STATE_MISMATCH',
    });
    expect(JSON.parse(repeated.output)).toMatchObject({
      ok: false,
      code: 'DUPLICATE_FAILED_ACTION',
      needsInspect: true,
    });
    expect(actions.execute).toHaveBeenCalledOnce();
  });

  it('allows the same selection label after the semantic page content changes', async () => {
    let inspection = 0;
    const observer = {
      inspect: vi.fn(async () => {
        inspection += 1;
        return {
          tabId: 7,
          url: 'https://example.com/exam',
          data: {
            mode: 'interactive',
            snapshot: `snapshot_${String(inspection)}`,
            elements: [
              {
                d: 1,
                r: 'heading',
                n: inspection === 1 ? 'Question one' : 'Question two',
              },
              {
                d: 2,
                r: 'option',
                n: 'Yes',
                s: ['selected=false'],
                a: ['set_checked'],
                ref: `ref_${String(inspection)}`,
              },
            ],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        };
      }),
    };
    const actions = {
      execute: vi.fn(async () => {
        throw Object.assign(new Error('selection did not settle'), {
          code: 'ACTION_STATE_MISMATCH',
        });
      }),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    await executor.execute(
      call('browser_set_checked', { ref: 'ref_1', checked: true }),
      signal,
      context,
    );
    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const secondPage = await executor.execute(
      call('browser_set_checked', { ref: 'ref_2', checked: true }),
      signal,
      context,
    );

    expect(JSON.parse(secondPage.output)).toMatchObject({
      ok: false,
      code: 'ACTION_STATE_MISMATCH',
    });
    expect(actions.execute).toHaveBeenCalledTimes(2);
  });

  it('maps coordinates from a downscaled screenshot back to the CSS viewport', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 1000,
          height: 500,
          viewportWidth: 2000,
          viewportHeight: 1000,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: true,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await primeVisualFallback(executor, signal, context);
    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(
      call('browser_click_point', { x: 250, y: 100, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({ tabId: 7, x: 500, y: 200 }),
      }),
      signal,
    );
  });

  it.each([
    ['browser_click', { ref: 'ref_action', button: 'left', count: 1 }],
    [
      'browser_scroll',
      { target: 'ref_action', deltaX: 0, deltaY: 600, maxSegments: 1, stopText: '' },
    ],
  ])('returns a fresh semantic observation in the same result after %s', async (name, input) => {
    const observer = {
      inspect: vi.fn(
        async (
          _tabId: number,
          _mode: string,
          _signal: AbortSignal,
          options?: { readonly since?: string },
        ) => ({
          tabId: 7,
          url: 'https://example.com/form',
          data:
            options?.since === 'snapshot_before'
              ? {
                  mode: 'interactive',
                  snapshot: 'snapshot_after',
                  base: 'snapshot_before',
                  upsert: [
                    {
                      k: 'ref:ref_action',
                      e: {
                        d: 1,
                        r: 'button',
                        n: 'Continue',
                        ref: 'ref_action',
                      },
                    },
                  ],
                }
              : {
                  mode: 'interactive',
                  snapshot: 'snapshot_before',
                  elements: [{ d: 1, r: 'button', n: 'Continue', ref: 'ref_action' }],
                },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        }),
      ),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/form',
        data: { action: name.replace('browser_', ''), completed: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const acted = await executor.execute(call(name, input), signal, context);

    expect(JSON.parse(acted.output)).toMatchObject({
      ok: true,
      data: {
        completed: true,
        verification: {
          snapshot: 'snapshot_after',
          base: 'snapshot_before',
        },
      },
    });
    expect(observer.inspect).toHaveBeenCalledTimes(2);
    expect(observer.inspect).toHaveBeenLastCalledWith(7, 'interactive', signal, {
      since: 'snapshot_before',
    });
  });

  it('consumes virtualized scroll remainder in ordered observed segments within one tool call', async () => {
    const order: string[] = [];
    const observer = {
      inspect: vi.fn(
        async (
          _tabId: number,
          _mode: string,
          _signal: AbortSignal,
          options?: { readonly since?: string },
        ) => {
          order.push(`inspect:${options?.since ?? 'initial'}`);
          const sequence = observer.inspect.mock.calls.length;
          return {
            tabId: 7,
            url: 'https://example.com/history',
            data:
              sequence === 1
                ? {
                    mode: 'interactive',
                    snapshot: 'snapshot_0',
                    elements: [{ d: 1, r: 'region', n: 'History', ref: 'ref_history' }],
                  }
                : {
                    mode: 'interactive',
                    snapshot: `snapshot_${sequence - 1}`,
                    base: options?.since,
                    upsert: [
                      {
                        k: `node:message_${sequence - 1}`,
                        e: {
                          d: 2,
                          r: 'statictext',
                          n: `Batch ${sequence - 1}`,
                        },
                      },
                    ],
                  },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
            visualFallbackAllowed: false,
          };
        },
      ),
    };
    const segmentResults = [
      {
        actualDeltaY: -1_000,
        remainingDeltaY: -2_000,
        requestedDeltaApplied: false,
      },
      {
        actualDeltaY: -1_000,
        remainingDeltaY: -1_000,
        requestedDeltaApplied: false,
      },
      { actualDeltaY: -1_000, remainingDeltaY: 0, requestedDeltaApplied: true },
    ];
    const actions = {
      execute: vi.fn(async (actionCall: ReturnType<typeof call>) => {
        const index = actions.execute.mock.calls.length - 1;
        order.push(`scroll:${String((actionCall.arguments as { deltaY: number }).deltaY)}`);
        const segment = segmentResults[index] ?? segmentResults.at(-1);
        if (!segment) throw new Error('Missing scroll segment fixture.');
        return {
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            action: 'scroll',
            dispatched: true,
            deltaX: 0,
            deltaY: (actionCall.arguments as { deltaY: number }).deltaY,
            actualDeltaX: 0,
            remainingDeltaX: 0,
            moved: true,
            contentChanged: true,
            extentChanged: true,
            loadedMore: true,
            boundaryVerified: false,
            needsBoundaryProbe: false,
            segments: 1,
            ...segment,
          },
          observation: { targetPresent: true },
        };
      }),
      settle: vi.fn(async () => {
        order.push('settle');
      }),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -3_000,
        maxSegments: 1,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(order).toEqual([
      'inspect:initial',
      'scroll:-3000',
      'settle',
      'inspect:snapshot_0',
      'scroll:-2000',
      'settle',
      'inspect:snapshot_1',
      'scroll:-1000',
      'settle',
      'inspect:snapshot_2',
    ]);
    expect(actions.execute).toHaveBeenCalledTimes(3);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        action: 'scroll',
        deltaX: 0,
        deltaY: -3_000,
        actualDeltaX: 0,
        actualDeltaY: -3_000,
        remainingDeltaX: 0,
        remainingDeltaY: 0,
        requestedDeltaApplied: true,
        segments: 3,
        observations: [
          { snapshot: 'snapshot_1', base: 'snapshot_0' },
          { snapshot: 'snapshot_2', base: 'snapshot_1' },
          { snapshot: 'snapshot_3', base: 'snapshot_2' },
        ],
      },
    });
  });

  it('reobserves an ordinary scroll when its first settled snapshot has no new content', async () => {
    const order: string[] = [];
    const observer = {
      inspect: vi
        .fn()
        .mockImplementationOnce(async () => {
          order.push('inspect:initial');
          return {
            tabId: 7,
            url: 'https://example.com/history',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_0',
              coverage: { contentKey: 'recent' },
              elements: [{ d: 1, r: 'region', n: 'History', ref: 'ref_history' }],
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
            visualFallbackAllowed: false,
          };
        })
        .mockImplementationOnce(async () => {
          order.push('inspect:first');
          return {
            tabId: 7,
            url: 'https://example.com/history',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_1',
              base: 'snapshot_0',
              unchanged: true,
              coverage: { contentKey: 'recent' },
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
            visualFallbackAllowed: false,
          };
        })
        .mockImplementationOnce(async () => {
          order.push('inspect:delayed');
          return {
            tabId: 7,
            url: 'https://example.com/history',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_2',
              base: 'snapshot_1',
              upsert: [{ k: 'node:older', e: { d: 2, r: 'statictext', n: 'Older message' } }],
              coverage: { contentKey: 'older' },
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
            visualFallbackAllowed: false,
          };
        }),
    };
    const actions = {
      execute: vi.fn(async () => {
        order.push('scroll');
        return {
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            action: 'scroll',
            actualDeltaX: 0,
            actualDeltaY: -3_000,
            remainingDeltaX: 0,
            remainingDeltaY: 0,
            requestedDeltaApplied: true,
            moved: true,
            contentChanged: false,
            extentChanged: false,
            loadedMore: false,
            boundaryVerified: false,
            needsBoundaryProbe: false,
            segments: 1,
          },
          observation: { targetPresent: true },
        };
      }),
      settle: vi.fn(async () => {
        order.push('settle');
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -3_000,
        maxSegments: 1,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(order).toEqual([
      'inspect:initial',
      'scroll',
      'settle',
      'inspect:first',
      'settle',
      'inspect:delayed',
    ]);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        contentChanged: true,
        loadedMore: true,
        observations: [
          { snapshot: 'snapshot_1', coverage: { contentKey: 'recent' } },
          { snapshot: 'snapshot_2', coverage: { contentKey: 'older' } },
        ],
      },
    });
  });

  it('stops segmented scrolling before the next action when retained page evidence reaches its budget', async () => {
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_0',
            elements: [{ d: 1, r: 'region', n: 'History', ref: 'ref_history' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        })
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_1',
            base: 'snapshot_0',
            upsert: [{ k: 'node:large_batch', e: { d: 2, n: 'x'.repeat(35_000) } }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        }),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/history',
        data: {
          action: 'scroll',
          dispatched: true,
          deltaX: 0,
          deltaY: -3_000,
          actualDeltaX: 0,
          actualDeltaY: -1_000,
          remainingDeltaX: 0,
          remainingDeltaY: -2_000,
          requestedDeltaApplied: false,
          moved: true,
          contentChanged: true,
          extentChanged: true,
          loadedMore: true,
          boundaryVerified: false,
          needsBoundaryProbe: false,
          segments: 1,
        },
        observation: { targetPresent: true },
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -3_000,
        maxSegments: 1,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledOnce();
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        remainingDeltaY: -2_000,
        requestedDeltaApplied: false,
        continuationLimited: 'evidence_budget',
        verification: { snapshot: 'snapshot_1', base: 'snapshot_0' },
      },
    });
  });

  it('scrolls and observes in order until normalized marker text is visible', async () => {
    const order: string[] = [];
    const observer = {
      inspect: vi.fn(
        async (
          _tabId: number,
          _mode: string,
          _signal: AbortSignal,
          options?: { readonly since?: string },
        ) => {
          order.push(`inspect:${options?.since ?? 'initial'}`);
          const sequence = observer.inspect.mock.calls.length;
          return {
            tabId: 7,
            url: 'https://example.com/history',
            data:
              sequence === 1
                ? {
                    mode: 'interactive',
                    snapshot: 'snapshot_0',
                    elements: [
                      {
                        d: 1,
                        r: 'list',
                        n: 'Message history',
                        a: ['scroll'],
                        ref: 'ref_history',
                      },
                    ],
                  }
                : {
                    mode: 'interactive',
                    snapshot: `snapshot_${sequence - 1}`,
                    base: options?.since,
                    upsert: [
                      {
                        k: `node:batch_${sequence - 1}`,
                        e: {
                          d: 2,
                          r: 'statictext',
                          n: sequence === 3 ? '进入 7\n月 的消息' : '8月的更早消息',
                        },
                      },
                    ],
                  },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
            visualFallbackAllowed: false,
          };
        },
      ),
    };
    const actions = {
      execute: vi.fn(async (actionCall: ReturnType<typeof call>) => {
        order.push(`scroll:${String((actionCall.arguments as { deltaY: number }).deltaY)}`);
        return {
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            action: 'scroll',
            dispatched: true,
            actualDeltaX: 0,
            actualDeltaY: -1_200,
            remainingDeltaX: 0,
            remainingDeltaY: 0,
            requestedDeltaApplied: true,
            moved: true,
            contentChanged: true,
            extentChanged: false,
            loadedMore: true,
            boundaryVerified: false,
            needsBoundaryProbe: false,
            position: { x: 0, y: 2_400, maxX: 0, maxY: 8_000 },
          },
          observation: { targetPresent: true },
        };
      }),
      settle: vi.fn(async () => {
        order.push('settle');
      }),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -1_200,
        maxSegments: 8,
        stopText: '7 月',
      }),
      signal,
      context,
    );

    expect(order).toEqual([
      'inspect:initial',
      'scroll:-1200',
      'settle',
      'inspect:snapshot_0',
      'scroll:-1200',
      'settle',
      'inspect:snapshot_1',
    ]);
    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'browser_scroll',
        operation: 'scroll',
        arguments: {
          tabId: 7,
          target: 'ref_history',
          deltaX: 0,
          deltaY: -1_200,
          maxSegments: 1,
          stopText: '',
        },
      }),
      signal,
    );
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      tabId: 7,
      data: {
        action: 'scroll',
        mode: 'traverse',
        target: 'ref_history',
        deltaX: 0,
        deltaY: -1_200,
        segments: 2,
        actualDeltaX: 0,
        actualDeltaY: -2_400,
        stopReason: 'text_seen',
        matched: true,
        boundaryVerified: false,
        latestSnapshot: 'snapshot_2',
        continuationRequired: false,
        observations: [
          { snapshot: 'snapshot_1', base: 'snapshot_0' },
          { snapshot: 'snapshot_2', base: 'snapshot_1' },
        ],
      },
    });
  });

  it.each([
    [
      'a compact viewport',
      { width: 800, height: 600 },
      { deltaX: 0, deltaY: 1_200 },
      { deltaX: 0, deltaY: 480 },
    ],
    [
      'a compact nested container on both axes',
      { width: 320, height: 400 },
      { deltaX: 1_200, deltaY: -1_200 },
      { deltaX: 256, deltaY: -320 },
    ],
    [
      'a large viewport without exceeding the safety ceiling',
      { width: 1_800, height: 1_600 },
      { deltaX: 0, deltaY: 1_200 },
      { deltaX: 0, deltaY: 1_200 },
    ],
  ])(
    'adapts the traversal stride to 80%% of %s',
    async (_label, scrollTargetSize, requested, expected) => {
      const observer = {
        inspect: vi
          .fn()
          .mockResolvedValueOnce({
            tabId: 7,
            url: 'https://example.com/history',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_before',
              elements: [{ r: 'list', n: 'History', a: ['scroll'], ref: 'ref_history' }],
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
          })
          .mockResolvedValueOnce({
            tabId: 7,
            url: 'https://example.com/history',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_after',
              base: 'snapshot_before',
              unchanged: true,
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
          }),
      };
      const actions = {
        measureScrollTarget: vi.fn(async () => scrollTargetSize),
        execute: vi.fn(async (actionCall: ReturnType<typeof call>) => {
          const delta = actionCall.arguments as {
            readonly deltaX: number;
            readonly deltaY: number;
          };
          return {
            tabId: 7,
            url: 'https://example.com/history',
            data: {
              action: 'scroll',
              actualDeltaX: delta.deltaX,
              actualDeltaY: delta.deltaY,
              remainingDeltaX: 0,
              remainingDeltaY: 0,
              requestedDeltaApplied: true,
              moved: true,
              contentChanged: false,
              extentChanged: false,
              loadedMore: false,
              boundaryVerified: true,
              position: { x: 0, y: 480, maxX: 0, maxY: 480 },
            },
            observation: null,
          };
        }),
      };
      const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
      const signal = new AbortController().signal;
      const context = { currentTabId: 7 };

      await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
      const result = await executor.execute(
        call('browser_scroll', {
          target: 'ref_history',
          ...requested,
          maxSegments: 4,
          stopText: '',
        }),
        signal,
        context,
      );

      expect(actions.measureScrollTarget).toHaveBeenCalledWith(7, 'ref_history', signal);
      expect(actions.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          arguments: {
            tabId: 7,
            target: 'ref_history',
            deltaX: expected.deltaX,
            deltaY: expected.deltaY,
            maxSegments: 1,
            stopText: '',
          },
        }),
        signal,
      );
      expect(JSON.parse(result.output)).toMatchObject({
        ok: true,
        data: {
          deltaX: requested.deltaX,
          deltaY: requested.deltaY,
          effectiveDeltaX: expected.deltaX,
          effectiveDeltaY: expected.deltaY,
          scrollTargetSize,
          stopReason: 'boundary_verified',
        },
      });
    },
  );

  it.each([
    [
      'verified boundary',
      {
        moved: false,
        contentChanged: false,
        extentChanged: false,
        loadedMore: false,
        boundaryVerified: true,
      },
      'boundary_verified',
      false,
    ],
    [
      'no progress',
      {
        moved: false,
        contentChanged: false,
        extentChanged: false,
        loadedMore: false,
        boundaryVerified: false,
      },
      'no_progress',
      true,
    ],
  ])(
    'returns a bounded %s traversal receipt after observing the dispatched segment',
    async (_label, measured, stopReason, continuationRequired) => {
      const observer = {
        inspect: vi
          .fn()
          .mockResolvedValueOnce({
            tabId: 7,
            url: 'https://example.com/history',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_before',
              elements: [{ r: 'list', n: 'History', a: ['scroll'], ref: 'ref_history' }],
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
          })
          .mockResolvedValueOnce({
            tabId: 7,
            url: 'https://example.com/history',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_after',
              base: 'snapshot_before',
              unchanged: true,
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
          }),
      };
      const actions = {
        execute: vi.fn(async () => ({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            action: 'scroll',
            actualDeltaX: 0,
            actualDeltaY: 0,
            requestedDeltaApplied: false,
            remainingDeltaX: 0,
            remainingDeltaY: -600,
            ...measured,
          },
          observation: null,
        })),
      };
      const executor = new BrowserToolExecutor({
        tabs: tabPort(),
        observer,
        actions,
      });
      const signal = new AbortController().signal;
      const context = { currentTabId: 7 };

      await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
      const result = await executor.execute(
        call('browser_scroll', {
          target: 'ref_history',
          deltaX: 0,
          deltaY: -600,
          maxSegments: 4,
          stopText: '',
        }),
        signal,
        context,
      );

      expect(actions.execute).toHaveBeenCalledOnce();
      expect(observer.inspect).toHaveBeenCalledTimes(2);
      expect(JSON.parse(result.output)).toMatchObject({
        ok: true,
        data: {
          segments: 1,
          stopReason,
          continuationRequired,
          observations: [{ snapshot: 'snapshot_after', base: 'snapshot_before' }],
        },
      });
    },
  );

  it('does not certify a traversal boundary when the page fails to settle', async () => {
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_before',
            elements: [{ r: 'list', n: 'History', a: ['scroll'], ref: 'ref_history' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        })
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_after',
            base: 'snapshot_before',
            unchanged: true,
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        }),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/history',
        data: {
          action: 'scroll',
          actualDeltaX: 0,
          actualDeltaY: 0,
          requestedDeltaApplied: false,
          remainingDeltaX: 0,
          remainingDeltaY: 600,
          moved: false,
          contentChanged: false,
          extentChanged: false,
          loadedMore: false,
          boundaryVerified: true,
        },
        observation: null,
      })),
      settle: vi.fn(async () => {
        throw new Error('page remained dynamic');
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: 600,
        maxSegments: 4,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(actions.settle).toHaveBeenCalledOnce();
    expect(observer.inspect).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        segments: 1,
        stopReason: 'page_unsettled',
        continuationRequired: true,
        boundaryVerified: false,
        coverage: { directionComplete: false },
        observations: [{ snapshot: 'snapshot_after', base: 'snapshot_before' }],
      },
    });
  });

  it('retains three bounded traversal batches before stopping at a verified boundary', async () => {
    const observer = {
      inspect: vi.fn(async () => {
        const sequence = observer.inspect.mock.calls.length - 1;
        return {
          tabId: 7,
          url: 'https://example.com/history',
          data:
            sequence === 0
              ? {
                  mode: 'interactive',
                  snapshot: 'snapshot_0',
                  elements: [{ r: 'list', n: 'History', a: ['scroll'], ref: 'ref_history' }],
                }
              : {
                  mode: 'interactive',
                  snapshot: `snapshot_${String(sequence)}`,
                  base: `snapshot_${String(sequence - 1)}`,
                  upsert: [
                    {
                      k: 'node:repeated_status',
                      e: { r: 'statictext', n: `Status ${'x'.repeat(20_000)}` },
                    },
                  ],
                },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        };
      }),
    };
    const actions = {
      execute: vi.fn(async () => {
        const segment = actions.execute.mock.calls.length;
        return {
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            action: 'scroll',
            actualDeltaX: 0,
            actualDeltaY: -600,
            remainingDeltaX: 0,
            remainingDeltaY: 0,
            requestedDeltaApplied: true,
            moved: true,
            contentChanged: true,
            extentChanged: false,
            loadedMore: true,
            boundaryVerified: segment === 3,
          },
          observation: null,
        };
      }),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -600,
        maxSegments: 8,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledTimes(3);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        stopReason: 'boundary_verified',
        segments: 3,
        continuationRequired: false,
        observations: [
          { snapshot: 'snapshot_1', base: 'snapshot_0' },
          { snapshot: 'snapshot_2', base: 'snapshot_1' },
          { snapshot: 'snapshot_3', base: 'snapshot_2' },
        ],
      },
    });
    expect(result.output.length).toBeLessThanOrEqual(100 * 1_024);
    expect(result.modelOutput).toBeDefined();
    expect(result.modelOutput?.length).toBeLessThan(result.output.length);
  });

  it('retains an oversized exact scroll audit when its compact model output fits', async () => {
    const passiveTombstones = Array.from(
      { length: 5_000 },
      (_, index) => `node:offscreen-paragraph-${index.toString().padStart(4, '0')}`,
    );
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/document',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_before',
            elements: [{ r: 'region', n: 'Document', a: ['scroll'], ref: 'ref_document' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        })
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/document',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_after',
            base: 'snapshot_before',
            remove: passiveTombstones,
            upsert: [{ k: 'node:new', e: { d: 4, r: 'statictext', n: 'New text' } }],
            coverage: { targets: ['ref_document'], primaryTarget: 'ref_document' },
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        }),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/document',
        data: {
          action: 'scroll',
          actualDeltaX: 0,
          actualDeltaY: 600,
          remainingDeltaX: 0,
          remainingDeltaY: 0,
          requestedDeltaApplied: true,
          moved: true,
          contentChanged: true,
          extentChanged: false,
          loadedMore: false,
          boundaryVerified: false,
        },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_document',
        deltaX: 0,
        deltaY: 600,
        maxSegments: 1,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(result.output.length).toBeGreaterThan(100 * 1_024);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, data: { action: 'scroll' } });
    expect(result.modelOutput?.length).toBeLessThanOrEqual(100 * 1_024);
    expect(JSON.parse(result.modelOutput ?? '{}')).toMatchObject({
      ok: true,
      data: { verification: { snapshot: 'snapshot_after' } },
    });
  });

  it('preserves partial traversal evidence when a later action fails', async () => {
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_before',
            elements: [{ r: 'list', n: 'History', a: ['scroll'], ref: 'ref_history' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        })
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_after',
            base: 'snapshot_before',
            unchanged: true,
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        }),
    };
    const actions = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            action: 'scroll',
            actualDeltaX: 0,
            actualDeltaY: -600,
            remainingDeltaX: 0,
            remainingDeltaY: 0,
            requestedDeltaApplied: true,
            moved: true,
            contentChanged: true,
            extentChanged: false,
            loadedMore: true,
            boundaryVerified: false,
          },
          observation: null,
        })
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: { action: 'scroll' },
          observation: null,
          failure: { code: 'STALE_REF' },
        }),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -600,
        maxSegments: 4,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        stopReason: 'action_failure',
        segments: 1,
        continuationRequired: true,
        continuationFailure: { code: 'STALE_REF', needsInspect: true },
        observations: [{ snapshot: 'snapshot_after', base: 'snapshot_before' }],
      },
    });
  });

  it('stops traversal at its hard segment limit without dropping an observation', async () => {
    const observer = {
      inspect: vi.fn(
        async (
          _tabId: number,
          _mode: string,
          _signal: AbortSignal,
          options?: { readonly since?: string },
        ) => {
          const sequence = observer.inspect.mock.calls.length - 1;
          return {
            tabId: 7,
            url: 'https://example.com/history',
            data:
              sequence === 0
                ? {
                    mode: 'interactive',
                    snapshot: 'snapshot_0',
                    elements: [
                      {
                        r: 'list',
                        n: 'History',
                        a: ['scroll'],
                        ref: 'ref_history',
                      },
                    ],
                  }
                : {
                    mode: 'interactive',
                    snapshot: `snapshot_${String(sequence)}`,
                    base: options?.since,
                    upsert: [
                      {
                        k: `node:${String(sequence)}`,
                        e: { r: 'statictext', n: 'More' },
                      },
                    ],
                  },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
          };
        },
      ),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/history',
        data: {
          action: 'scroll',
          actualDeltaX: 0,
          actualDeltaY: -600,
          requestedDeltaApplied: true,
          moved: true,
          contentChanged: true,
          boundaryVerified: false,
        },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -600,
        maxSegments: 2,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        stopReason: 'segment_limit',
        segments: 2,
        continuationRequired: false,
        continuationAvailable: true,
        observations: [
          { snapshot: 'snapshot_1', base: 'snapshot_0' },
          { snapshot: 'snapshot_2', base: 'snapshot_1' },
        ],
      },
    });
  });

  it('stops a cyclic traversal when a prior semantic viewport repeats', async () => {
    const keys = ['initial', 'batch-a', 'batch-b', 'batch-a'];
    const observer = {
      inspect: vi.fn(async () => {
        const sequence = observer.inspect.mock.calls.length - 1;
        return {
          tabId: 7,
          url: 'https://example.com/carousel',
          data: {
            mode: 'interactive',
            snapshot: `snapshot_${String(sequence)}`,
            coverage: {
              complete: false,
              targets: ['ref_carousel'],
              contentKey: keys[sequence],
            },
            elements: [
              { r: 'list', n: `Card ${String(sequence)}`, a: ['scroll'], ref: 'ref_carousel' },
            ],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        };
      }),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/carousel',
        data: {
          action: 'scroll',
          actualDeltaX: 0,
          actualDeltaY: 600,
          requestedDeltaApplied: true,
          moved: true,
          contentChanged: true,
          extentChanged: false,
          loadedMore: false,
          boundaryVerified: false,
        },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_carousel',
        deltaX: 0,
        deltaY: 600,
        maxSegments: 8,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        stopReason: 'cycle_detected',
        continuationRequired: false,
        segments: 3,
        coverage: {
          mode: 'cyclic',
          directionComplete: false,
          sampleComplete: true,
          uniqueBatches: 2,
        },
      },
    });
  });

  it('finishes a bounded sample when an empty-marker feed keeps extending', async () => {
    const observer = {
      inspect: vi.fn(async () => {
        const sequence = observer.inspect.mock.calls.length - 1;
        return {
          tabId: 7,
          url: 'https://example.com/feed',
          data: {
            mode: 'interactive',
            snapshot: `snapshot_${String(sequence)}`,
            coverage: {
              complete: false,
              targets: ['viewport'],
              contentKey: `batch-${String(sequence)}`,
            },
            elements: [{ r: 'article', n: `Post ${String(sequence)}` }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        };
      }),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/feed',
        data: {
          action: 'scroll',
          actualDeltaX: 0,
          actualDeltaY: 600,
          requestedDeltaApplied: true,
          moved: true,
          contentChanged: true,
          extentChanged: true,
          loadedMore: true,
          boundaryVerified: false,
        },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
        maxSegments: 4,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        stopReason: 'sample_limit',
        continuationRequired: false,
        segments: 4,
        coverage: {
          mode: 'open_ended',
          directionComplete: false,
          sampleComplete: true,
          growthSegments: 4,
          uniqueBatches: 4,
        },
      },
    });

    const requiredRange = await executor.execute(
      call('browser_scroll', {
        target: 'viewport',
        deltaX: 0,
        deltaY: 600,
        maxSegments: 4,
        stopText: 'required finite boundary',
      }),
      signal,
      context,
    );
    expect(JSON.parse(requiredRange.output)).toMatchObject({
      ok: true,
      data: {
        stopReason: 'segment_limit',
        continuationRequired: false,
        continuationAvailable: true,
        coverage: {
          mode: 'unknown',
          sampleComplete: false,
          growthSegments: 4,
        },
      },
    });
  });

  it('preserves the dispatched segment when traversal observation becomes unavailable', async () => {
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/history',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_before',
            elements: [{ r: 'list', n: 'History', a: ['scroll'], ref: 'ref_history' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
        })
        .mockRejectedValueOnce(new Error('observation unavailable')),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/history',
        data: {
          action: 'scroll',
          actualDeltaX: 0,
          actualDeltaY: -600,
          requestedDeltaApplied: true,
          moved: true,
          contentChanged: true,
          boundaryVerified: false,
        },
        observation: { targetPresent: true },
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -600,
        maxSegments: 4,
        stopText: '',
      }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledOnce();
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        stopReason: 'observation_unavailable',
        segments: 1,
        actualDeltaY: -600,
        continuationRequired: true,
        verificationUnavailable: true,
        observations: [],
      },
    });
  });

  it('does not dispatch traversal without a current interactive baseline', async () => {
    const actions = { execute: vi.fn() };
    const observer = { inspect: vi.fn() };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });

    const result = await executor.execute(
      call('browser_scroll', {
        target: 'ref_history',
        deltaX: 0,
        deltaY: -600,
        maxSegments: 4,
        stopText: '',
      }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(actions.execute).not.toHaveBeenCalled();
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      code: 'INTERACTIVE_INSPECTION_REQUIRED',
      needsInspect: true,
    });
  });

  it('preserves a dispatched semantic action when its embedded observation is unavailable', async () => {
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/form',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_before',
            elements: [{ d: 1, r: 'button', n: 'Continue', ref: 'ref_action' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        })
        .mockRejectedValueOnce(new Error('observation unavailable')),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/form',
        data: { action: 'click', dispatched: true },
        observation: { targetPresent: true },
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const acted = await executor.execute(
      call('browser_click', { ref: 'ref_action', button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(JSON.parse(acted.output)).toMatchObject({
      ok: true,
      data: {
        action: 'click',
        dispatched: true,
        verificationUnavailable: true,
      },
    });
    expect(actions.execute).toHaveBeenCalledOnce();
  });

  it('waits for dynamic results to settle before observing a completed type action', async () => {
    let settled = false;
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/search',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_before',
            elements: [{ r: 'searchbox', n: 'Search', a: ['type'], ref: 'ref_search' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        })
        .mockImplementationOnce(async () => ({
          tabId: 7,
          url: 'https://example.com/search',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_after',
            base: 'snapshot_before',
            stable: settled,
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/search',
        data: { action: 'type', applied: true, verified: true },
        observation: { targetPresent: true },
      })),
      settle: vi.fn(async () => {
        settled = true;
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_type', {
        ref: 'ref_search',
        text: 'dynamic query',
        replace: true,
        submit: false,
      }),
      signal,
      context,
    );

    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        verification: {
          snapshot: 'snapshot_after',
          base: 'snapshot_before',
          stable: true,
        },
      },
    });
  });

  it('captures delayed non-submit type results without a separate wait tool call', async () => {
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/search',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_before',
            elements: [{ r: 'searchbox', n: 'Search', a: ['type'], ref: 'ref_search' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        })
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/search',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_typed',
            base: 'snapshot_before',
            upsert: [{ k: 'ref:ref_search', e: { r: 'searchbox', n: 'query', ref: 'ref_search' } }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        })
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/search',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_results',
            base: 'snapshot_typed',
            upsert: [
              {
                k: 'ref:ref_result',
                e: { r: 'option', n: 'Matching result', ref: 'ref_result' },
              },
            ],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        }),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/search',
        data: { action: 'type', applied: true, verified: true },
        observation: { targetPresent: true },
      })),
      settle: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const result = await executor.execute(
      call('browser_type', {
        ref: 'ref_search',
        text: 'query',
        replace: true,
        submit: false,
      }),
      signal,
      context,
    );

    expect(actions.settle).toHaveBeenCalledTimes(2);
    expect(observer.inspect).toHaveBeenCalledTimes(3);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      data: {
        observations: [
          { snapshot: 'snapshot_typed', base: 'snapshot_before' },
          {
            snapshot: 'snapshot_results',
            base: 'snapshot_typed',
            upsert: [{ e: { n: 'Matching result', ref: 'ref_result' } }],
          },
        ],
      },
    });
  });

  it('returns a failed batch receipt without losing its verified selection prefix', async () => {
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/form',
        data: {
          action: 'set_checked_many',
          complete: false,
          completedItems: [
            {
              ref: 'ref_1',
              requested: true,
              actual: true,
              dispatched: false,
              strategy: 'already_set',
            },
          ],
          failedIndex: 1,
          failure: { code: 'UNSUPPORTED_ACTION' },
        },
        observation: { targetPresent: true },
        failure: { code: 'UNSUPPORTED_ACTION' },
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), actions });

    const result = await executor.execute(
      call('browser_set_checked_many', {
        items: [
          { ref: 'ref_1', checked: true },
          { ref: 'ref_2', checked: false },
        ],
      }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_ACTION',
      data: {
        complete: false,
        failedIndex: 1,
        completedItems: [{ ref: 'ref_1', actual: true }],
      },
    });
    expect(actions.execute).toHaveBeenCalledOnce();
  });

  it('returns an interactive state delta after a screenshot coordinate click', async () => {
    const observer = {
      inspect: vi.fn(
        async (
          _tabId: number,
          mode: string,
          _signal: AbortSignal,
          options?: { readonly since?: string },
        ) => {
          if (mode === 'screenshot') {
            return {
              tabId: 7,
              url: 'https://example.com/exam',
              data: {
                mode: 'screenshot',
                width: 800,
                height: 600,
                viewportWidth: 800,
                viewportHeight: 600,
              },
              observation: null,
              attachmentIds: ['attachment_1'],
              debuggerSession: 'ephemeral' as const,
            };
          }
          if (options?.since === 'snapshot_before') {
            return {
              tabId: 7,
              url: 'https://example.com/exam',
              data: {
                mode: 'interactive',
                snapshot: 'snapshot_after',
                base: 'snapshot_before',
                changes: [{ i: 4, s: ['selected'] }],
              },
              observation: null,
              attachmentIds: [],
              debuggerSession: 'ephemeral' as const,
              visualFallbackAllowed: false,
            };
          }
          return {
            tabId: 7,
            url: 'https://example.com/exam',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_before',
              elements: [
                {
                  d: 2,
                  r: 'option',
                  n: 'A. Answer',
                  s: ['selected=false'],
                  a: ['set_checked'],
                  ref: 'ref_a',
                },
              ],
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
            visualFallbackAllowed: true,
          };
        },
      ),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com/exam',
        data: { action: 'click_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    const clicked = await executor.execute(
      call('browser_click_point', { x: 200, y: 160, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(JSON.parse(clicked.output)).toMatchObject({
      ok: true,
      data: {
        action: 'click_point',
        dispatched: true,
        verification: {
          mode: 'interactive',
          snapshot: 'snapshot_after',
          base: 'snapshot_before',
          changes: [{ i: 4, s: ['selected'] }],
        },
      },
    });
    expect(observer.inspect).toHaveBeenLastCalledWith(7, 'interactive', signal, {
      since: 'snapshot_before',
    });
  });

  it('maps both drag endpoints from screenshot pixels to the CSS viewport', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 720,
          height: 360,
          viewportWidth: 1440,
          viewportHeight: 720,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: true,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'drag_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await primeVisualFallback(executor, signal, context);
    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(
      call('browser_drag_point', { fromX: 10, fromY: 20, toX: 100, toY: 120 }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: expect.objectContaining({
          tabId: 7,
          fromX: 20,
          fromY: 40,
          toX: 200,
          toY: 240,
        }),
      }),
      signal,
    );
  });

  it('rejects screenshot coordinates after an intervening page inspection', async () => {
    const observer = {
      inspect: vi.fn(async (_tabId: number, mode: string) => ({
        tabId: 7,
        url: 'https://example.com',
        data:
          mode === 'screenshot'
            ? {
                mode,
                width: 500,
                height: 250,
                viewportWidth: 1000,
                viewportHeight: 500,
              }
            : { mode: 'interactive', snapshot: 'snapshot_2', elements: [] },
        observation: null,
        attachmentIds: mode === 'screenshot' ? ['attachment_1'] : [],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: true,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await primeVisualFallback(executor, signal, context);
    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const clicked = await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(JSON.parse(clicked.output)).toMatchObject({
      ok: false,
      code: 'STALE_SCREENSHOT',
      needsInspect: true,
    });
    expect(actions.execute).not.toHaveBeenCalled();
  });

  it('requires a fresh screenshot for every coordinate action', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 500,
          height: 250,
          viewportWidth: 1000,
          viewportHeight: 500,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: true,
      })),
    };
    const receivedArguments: ReturnType<typeof call>['arguments'][] = [];
    const actions = {
      execute: vi.fn(async (received: ReturnType<typeof call>) => {
        receivedArguments.push(received.arguments);
        return {
          tabId: 7,
          url: 'https://example.com',
          data: { action: 'click_point', dispatched: true },
          observation: null,
        };
      }),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await primeVisualFallback(executor, signal, context);
    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );
    const stale = await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(receivedArguments[0]).toMatchObject({ x: 20, y: 40 });
    expect(receivedArguments).toHaveLength(1);
    expect(JSON.parse(stale.output)).toMatchObject({
      ok: false,
      code: 'STALE_SCREENSHOT',
    });
  });

  it('drops screenshot coordinate state when the task runner is released', async () => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 500,
          height: 250,
          viewportWidth: 1000,
          viewportHeight: 500,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: true,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'click_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await primeVisualFallback(executor, signal, context);
    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.release('runner_1');
    const stale = await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(actions.execute).not.toHaveBeenCalled();
    expect(JSON.parse(stale.output)).toMatchObject({
      ok: false,
      code: 'STALE_SCREENSHOT',
    });
  });

  it.each([
    ['navigation', 'browser_navigate', { url: 'https://other.test' }],
    ['reload', 'browser_reload', {}],
  ])('drops screenshot coordinate state when %s replaces the page', async (_label, name, input) => {
    const observer = {
      inspect: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: {
          mode: 'screenshot',
          width: 500,
          height: 250,
          viewportWidth: 1000,
          viewportHeight: 500,
        },
        observation: null,
        attachmentIds: ['attachment_1'],
        debuggerSession: 'ephemeral' as const,
        visualFallbackAllowed: true,
      })),
    };
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://other.test',
        data: { action: 'click_point', dispatched: true },
        observation: null,
      })),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      observer,
      actions,
    });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7 };

    await primeVisualFallback(executor, signal, context);
    await executor.execute(call('browser_inspect', { mode: 'screenshot' }), signal, context);
    await executor.execute(call(name, input), signal, context);
    const stale = await executor.execute(
      call('browser_click_point', { x: 10, y: 20, button: 'left', count: 1 }),
      signal,
      context,
    );

    expect(actions.execute).not.toHaveBeenCalled();
    expect(JSON.parse(stale.output)).toMatchObject({
      ok: false,
      code: 'STALE_SCREENSHOT',
    });
  });

  it('returns an actionable failure when the page observation bridge is unavailable', async () => {
    const observer = {
      inspect: vi.fn(async () => {
        throw Object.assign(new Error('private page bridge details'), {
          code: 'PAGE_UNAVAILABLE',
        });
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const output = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'interactive' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'PAGE_UNAVAILABLE',
      message:
        'The page content bridge is unavailable. Continue with mode interactive; do not reload solely for this error.',
      retryable: false,
      needsInspect: true,
    });
    expect(output.output).not.toContain('private page bridge details');
  });

  it('asks for a fresh inspection when the page returns an invalid observation', async () => {
    const observer = {
      inspect: vi.fn(async () => {
        throw Object.assign(new Error('private invalid response details'), {
          code: 'INVALID_PAGE_RESPONSE',
        });
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer });

    const output = await executor.execute(
      call('browser_inspect', { tabId: 7, mode: 'content' }),
      new AbortController().signal,
      { currentTabId: 7 },
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'INVALID_PAGE_RESPONSE',
      message:
        'The page content bridge returned an invalid response. Continue with mode interactive; do not reload solely for this error.',
      retryable: false,
      needsInspect: true,
    });
    expect(output.output).not.toContain('private invalid response details');
  });

  it('blocks a second reload recovery for the same unchanged browser failure', async () => {
    const tabs = tabPort();
    const observer = {
      inspect: vi.fn(async () => {
        throw Object.assign(new Error('private page bridge details'), {
          code: 'PAGE_UNAVAILABLE',
        });
      }),
    };
    const executor = new BrowserToolExecutor({ tabs, observer });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await executor.execute(call('browser_inspect', { mode: 'content' }), signal, context);
    await executor.execute(call('browser_reload', {}), signal, context);
    await executor.execute(call('browser_inspect', { mode: 'content' }), signal, context);
    const repeated = await executor.execute(call('browser_reload', {}), signal, context);

    expect(JSON.parse(repeated.output)).toEqual({
      ok: false,
      code: 'REPEATED_RECOVERY_BLOCKED',
      message:
        'Reload already failed to recover this browser error. Continue with another inspection or action strategy.',
      retryable: false,
      needsInspect: true,
    });
    expect(tabs.reload).toHaveBeenCalledOnce();
  });

  it('dispatches interaction calls through the action runtime', async () => {
    const actions = {
      execute: vi.fn(async () => ({
        tabId: 7,
        url: 'https://example.com',
        data: { action: 'hover', dispatched: true },
        observation: { targetPresent: true },
      })),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), actions });
    const browserCall = call('browser_hover', { tabId: 7, ref: 'ref_1' });

    const output = await executor.execute(browserCall, new AbortController().signal);

    expect(actions.execute).toHaveBeenCalledWith(browserCall, expect.any(AbortSignal));
    expect(JSON.parse(output.output)).toMatchObject({
      ok: true,
      data: { action: 'hover', dispatched: true },
    });
  });

  it('dispatches the four bounded network operations and rejects an incomplete get batch', async () => {
    const requestSummary = {
      requestId: 'request_1',
      url: 'https://api.test/',
      method: 'GET',
      resourceType: 'Fetch',
      status: 200,
      mimeType: 'application/json',
      startedAt: 1_000,
      durationMs: 20,
      encodedDataLength: 100,
      completed: true,
      failed: false,
      redirected: false,
      fromCache: false,
    };
    const network = {
      start: vi.fn(async () => ({
        tabId: 7,
        generation: 2,
        alreadyActive: false,
        startedAt: 900,
        capacity: 500,
        message: 'Capture started. Earlier traffic is unavailable.',
      })),
      list: vi.fn(async () => ({
        requests: [requestSummary],
        mode: 'endpoint_sample' as const,
        matchedRequestCount: 1,
        resultCount: 1,
        hasMore: false,
        nextCursor: null,
        coverage: {
          startedAt: 900,
          snapshotAt: 1_100,
          lastActivityAt: 1_020,
          totalCaptured: 1,
          retainedCount: 1,
          droppedCount: 0,
          inFlightCount: 0,
          bufferLossless: true,
        },
      })),
      get: vi.fn(async () => [
        {
          ok: true as const,
          requestId: 'request_1',
          request: {
            ...requestSummary,
            requestHeaders: {},
            responseHeaders: {},
            protocol: 'h2',
            statusText: 'OK',
            requestBody: {
              included: true,
              available: true,
              encoding: 'utf8' as const,
              text: '{}',
              truncated: false,
            },
            responseBody: {
              included: false,
              available: true,
              encoding: null,
              truncated: false,
            },
          },
        },
        {
          ok: false as const,
          requestId: 'missing_request',
          code: 'NETWORK_REQUEST_NOT_FOUND' as const,
          message: 'The captured network request is no longer available.',
        },
      ]),
      stop: vi.fn(async () => ({
        stopped: true as const,
        alreadyStopped: false,
        startedAt: 900,
        stoppedAt: 1_200,
        lastActivityAt: 1_020,
        totalCaptured: 1,
        retainedCount: 1,
        droppedCount: 0,
        inFlightCount: 0,
        bufferLossless: true,
      })),
    };
    const tabs = tabPort();
    const executor = new BrowserToolExecutor({ tabs, network });
    const signal = new AbortController().signal;

    const started = await executor.execute(call('browser_network_start', { tabId: 7 }), signal);
    const listed = await executor.execute(
      call('browser_network_list', {
        tabId: 7,
        urlPattern: '/api/',
        limit: 25,
        mode: 'endpoint_sample',
        cursor: '',
      }),
      signal,
    );
    const getRequests = [
      {
        requestId: 'request_1',
        includeRequestBody: true,
        includeResponseBody: false,
      },
      {
        requestId: 'missing_request',
        includeRequestBody: false,
        includeResponseBody: true,
      },
    ];
    const details = await executor.execute(
      call('browser_network_get', {
        tabId: 7,
        requests: getRequests,
      }),
      signal,
    );
    const stopped = await executor.execute(call('browser_network_stop', { tabId: 7 }), signal);

    expect(network.start).toHaveBeenCalledWith(7, signal);
    expect(network.list).toHaveBeenCalledWith(7, '/api/', 25, 'endpoint_sample', '');
    expect(network.get).toHaveBeenCalledWith(7, getRequests);
    expect(network.stop).toHaveBeenCalledWith(7);
    expect(tabs.reload).not.toHaveBeenCalled();
    expect(JSON.parse(started.output)).toMatchObject({
      ok: true,
      data: { generation: 2 },
    });
    expect(JSON.parse(listed.output)).toMatchObject({
      ok: true,
      data: {
        requests: [{ requestId: 'request_1' }],
        hasMore: false,
        nextCursor: null,
        coverage: { bufferLossless: true, inFlightCount: 0 },
      },
    });
    expect(JSON.parse(details.output)).toEqual({
      ok: false,
      code: 'NETWORK_REQUEST_NOT_FOUND',
      message:
        'One or more request IDs are not in the current capture snapshot. Call browser_network_list again with cursor="" and copy requestId values exactly before retrying browser_network_get.',
      retryable: true,
      needsInspect: false,
    });
    expect(JSON.parse(stopped.output)).toMatchObject({
      ok: true,
      data: {
        stopped: true,
        alreadyStopped: false,
        totalCaptured: 1,
        bufferLossless: true,
      },
    });
  });

  it('keeps the network debugger with the task after capture stops', async () => {
    const network = {
      start: vi.fn(async () => ({
        tabId: 7,
        generation: 2,
        alreadyActive: false,
        startedAt: 900,
        capacity: 500,
        message: 'Capture started.',
      })),
      list: vi.fn(),
      get: vi.fn(),
      stop: vi.fn(async () => ({
        stopped: true as const,
        alreadyStopped: false,
        startedAt: 900,
        stoppedAt: 1_200,
        lastActivityAt: null,
        totalCaptured: 0,
        retainedCount: 0,
        droppedCount: 0,
        inFlightCount: 0,
        bufferLossless: true,
      })),
    };
    const sessions = {
      retain: vi.fn(async () => undefined),
      releaseOwner: vi.fn(async () => undefined),
    };
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      network,
      sessions,
    });
    const context = { currentTabId: 7, sessionOwnerId: 'runner_1' };

    await executor.execute(
      call('browser_network_start', { tabId: 7 }),
      new AbortController().signal,
      context,
    );
    expect(sessions.retain).toHaveBeenCalledWith(7, 'runner_1');
    expect(sessions.releaseOwner).not.toHaveBeenCalled();

    await executor.execute(
      call('browser_network_stop', { tabId: 7 }),
      new AbortController().signal,
      context,
    );
    expect(sessions.releaseOwner).not.toHaveBeenCalled();
    await executor.release('runner_1');
    expect(sessions.releaseOwner).toHaveBeenCalledWith('runner_1');
  });

  it('preserves retryable network-capture loss so the model can start capture again', async () => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      network: {
        start: vi.fn(),
        list: vi.fn(async () => {
          throw new NetworkCaptureError('NETWORK_CAPTURE_LOST', 'private capture state', true);
        }),
        get: vi.fn(),
        stop: vi.fn(),
      },
    });

    const output = await executor.execute(
      call('browser_network_list', {
        tabId: 7,
        urlPattern: '',
        limit: 25,
        mode: 'recent',
        cursor: '',
      }),
      new AbortController().signal,
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'NETWORK_CAPTURE_LOST',
      message: 'Network capture was lost. Start capture again.',
      retryable: true,
      needsInspect: false,
    });
    expect(output.output).not.toContain('private capture state');
  });

  it('normalizes an invalid network-list cursor without restarting capture', async () => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      network: {
        start: vi.fn(),
        list: vi.fn(async () => {
          throw new NetworkCaptureError(
            'NETWORK_LIST_CURSOR_INVALID',
            'private cursor state',
            true,
          );
        }),
        get: vi.fn(),
        stop: vi.fn(),
      },
    });

    const output = await executor.execute(
      call('browser_network_list', {
        tabId: 7,
        urlPattern: '',
        limit: 25,
        mode: 'recent',
        cursor: 'networkCursor_1',
      }),
      new AbortController().signal,
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'NETWORK_LIST_CURSOR_INVALID',
      message:
        'The network list cursor expired or does not match this query. List again with cursor="".',
      retryable: true,
      needsInspect: false,
    });
    expect(output.output).not.toContain('private cursor state');
  });

  it.each([
    [
      'STALE_REF',
      {
        code: 'STALE_REF',
        message: 'The element reference is stale. Inspect interactive elements again.',
        retryable: true,
        needsInspect: true,
      },
    ],
    [
      'POINT_OUT_OF_VIEWPORT',
      {
        code: 'POINT_OUT_OF_VIEWPORT',
        message: 'The point is outside the current viewport. Take a new screenshot.',
        retryable: true,
        needsInspect: true,
      },
    ],
    [
      'TYPE_VERIFICATION_FAILED',
      {
        code: 'TYPE_VERIFICATION_FAILED',
        message: 'The page did not retain the requested text. Inspect the editor and try again.',
        retryable: true,
        needsInspect: true,
      },
    ],
    [
      'ACTION_STATE_MISMATCH',
      {
        code: 'ACTION_STATE_MISMATCH',
        message:
          'The page did not retain the requested selection. Inspect fresh refs before another action.',
        retryable: false,
        needsInspect: true,
      },
    ],
    [
      'ACTION_TARGET_OBSCURED',
      {
        code: 'ACTION_TARGET_OBSCURED',
        message: 'The target is covered by another element. Inspect the page before retrying.',
        retryable: true,
        needsInspect: true,
      },
    ],
  ])('preserves actionable %s recovery guidance', async (code, expected) => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      actions: {
        execute: vi.fn(async () => {
          throw Object.assign(new Error('private page details'), { code });
        }),
      },
    });
    const tool = (() => {
      if (code === 'STALE_REF') {
        return call('browser_click', {
          tabId: 7,
          ref: 'ref_1',
          button: 'left',
          count: 1,
        });
      }
      if (code === 'TYPE_VERIFICATION_FAILED') {
        return call('browser_type', {
          tabId: 7,
          ref: 'ref_1',
          text: 'hello',
          replace: true,
          submit: false,
        });
      }
      if (code === 'ACTION_STATE_MISMATCH') {
        return call('browser_set_checked', {
          tabId: 7,
          ref: 'ref_1',
          checked: true,
        });
      }
      if (code === 'ACTION_TARGET_OBSCURED') {
        return call('browser_click', {
          tabId: 7,
          ref: 'ref_1',
          button: 'left',
          count: 1,
        });
      }
      return call('browser_scroll', {
        tabId: 7,
        target: 'viewport',
        deltaX: 0,
        deltaY: 20,
        maxSegments: 1,
        stopText: '',
      });
    })();

    const output = await executor.execute(tool, new AbortController().signal);

    expect(JSON.parse(output.output)).toEqual({ ok: false, ...expected });
    expect(output.output).not.toContain('private page details');
  });

  it.each(['STALE_REF', 'ACTION_TARGET_OBSCURED'] as const)(
    'attaches a fresh interactive delta to %s without replaying the action',
    async (code) => {
      const observer = {
        inspect: vi
          .fn()
          .mockResolvedValueOnce({
            tabId: 7,
            url: 'https://example.com/form',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_before',
              elements: [{ r: 'button', n: 'Continue', ref: 'ref_old' }],
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
            visualFallbackAllowed: false,
          })
          .mockResolvedValueOnce({
            tabId: 7,
            url: 'https://example.com/form',
            data: {
              mode: 'interactive',
              snapshot: 'snapshot_fresh',
              base: 'snapshot_before',
              remove: ['ref:ref_old'],
              upsert: [
                {
                  k: 'ref:ref_fresh',
                  e: { r: 'button', n: 'Continue', ref: 'ref_fresh' },
                },
              ],
            },
            observation: null,
            attachmentIds: [],
            debuggerSession: 'ephemeral' as const,
            visualFallbackAllowed: false,
          }),
      };
      const failedAction = {
        tabId: 7,
        url: 'https://example.com/form',
        data: { action: 'click', dispatched: false },
        observation: { targetPresent: false },
        failure: { code },
      };
      const actions = {
        execute:
          code === 'STALE_REF'
            ? vi.fn(async () => {
                throw Object.assign(new Error('private stale node'), { code });
              })
            : vi.fn(async () => failedAction),
      };
      const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
      const signal = new AbortController().signal;
      const context = { currentTabId: 7 };

      await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
      const output = await executor.execute(
        call('browser_click', { ref: 'ref_old', button: 'left', count: 1 }),
        signal,
        context,
      );

      expect(actions.execute).toHaveBeenCalledOnce();
      expect(observer.inspect).toHaveBeenCalledTimes(2);
      expect(observer.inspect).toHaveBeenLastCalledWith(7, 'interactive', signal, {
        since: 'snapshot_before',
      });
      expect(JSON.parse(output.output)).toMatchObject({
        ok: false,
        code,
        needsInspect: false,
        data: {
          verification: {
            snapshot: 'snapshot_fresh',
            base: 'snapshot_before',
            remove: ['ref:ref_old'],
            upsert: [{ e: { n: 'Continue', ref: 'ref_fresh' } }],
          },
        },
      });
      expect(output.output).not.toContain('private stale node');
    },
  );

  it('attaches fresh interactive state after an unverified image paste without replaying it', async () => {
    const observer = {
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/compose',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_before',
            elements: [{ r: 'textbox', n: 'Message', ref: 'ref_editor' }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        })
        .mockResolvedValueOnce({
          tabId: 7,
          url: 'https://example.com/compose',
          data: {
            mode: 'interactive',
            snapshot: 'snapshot_after',
            base: 'snapshot_before',
            upsert: [{ k: 'node:image', e: { r: 'image', n: 'capture.png' } }],
          },
          observation: null,
          attachmentIds: [],
          debuggerSession: 'ephemeral' as const,
          visualFallbackAllowed: false,
        }),
    };
    const actions = {
      execute: vi.fn(async () => {
        throw Object.assign(new Error('private preview state'), {
          code: 'ATTACHMENT_VERIFICATION_FAILED',
        });
      }),
    };
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
    const signal = new AbortController().signal;
    const context = { currentTabId: 7, availableAssetIds: ['attachment_capture'] };

    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
    const output = await executor.execute(
      call('browser_paste_image', {
        ref: 'ref_editor',
        assetId: 'attachment_capture',
      }),
      signal,
      context,
    );

    expect(actions.execute).toHaveBeenCalledOnce();
    expect(observer.inspect).toHaveBeenCalledTimes(2);
    expect(JSON.parse(output.output)).toMatchObject({
      ok: false,
      code: 'ATTACHMENT_VERIFICATION_FAILED',
      needsInspect: false,
      data: {
        verification: {
          snapshot: 'snapshot_after',
          base: 'snapshot_before',
          upsert: [{ e: { r: 'image', n: 'capture.png' } }],
        },
      },
    });
    expect(output.output).not.toContain('private preview state');
  });

  it('preserves only a safe browser action failure stage for diagnosis', async () => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      actions: {
        execute: vi.fn(async () => {
          throw Object.assign(new Error('private editor state'), {
            code: 'TYPE_VERIFICATION_FAILED',
            stage: 'insert',
            value: 'secret typed content',
          });
        }),
      },
    });

    const output = await executor.execute(
      call('browser_type', {
        tabId: 7,
        ref: 'ref_1',
        text: 'hello',
        replace: true,
        submit: false,
      }),
      new AbortController().signal,
    );

    expect(JSON.parse(output.output)).toEqual({
      ok: false,
      code: 'TYPE_VERIFICATION_FAILED',
      message: 'The page did not retain the requested text. Inspect the editor and try again.',
      retryable: true,
      needsInspect: true,
      stage: 'insert',
    });
    expect(output.output).not.toContain('private editor state');
    expect(output.output).not.toContain('secret typed content');
  });

  it('recovers a missing stage only from a known internal type-verification message', async () => {
    const executor = new BrowserToolExecutor({
      tabs: tabPort(),
      actions: {
        execute: vi.fn(async () => {
          throw Object.assign(
            new Error('The focused editable value did not contain the requested input.'),
            { code: 'TYPE_VERIFICATION_FAILED' },
          );
        }),
      },
    });

    const output = await executor.execute(
      call('browser_type', {
        tabId: 7,
        ref: 'ref_1',
        text: 'hello',
        replace: true,
        submit: false,
      }),
      new AbortController().signal,
    );

    expect(JSON.parse(output.output)).toMatchObject({
      code: 'TYPE_VERIFICATION_FAILED',
      stage: 'readback',
    });
    expect(output.output).not.toContain('focused editable value');
  });
});
