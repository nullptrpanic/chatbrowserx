import { describe, expect, it, vi } from 'vitest';
import { parseBrowserToolCall } from '../../src/agent/tools/browser-tool-schema';
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
    const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, sessions });

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

  it('pastes only a screenshot asset owned by the current WorkSession', async () => {
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
    const executor = new BrowserToolExecutor({ tabs: tabPort(), actions, sessions });
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
        arguments: expect.objectContaining({ tabId: 7, assetId: 'attachment_capture' }),
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
    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
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
    await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
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
    ['browser_scroll', { target: 'ref_action', deltaX: 0, deltaY: 600 }],
  ])(
    'leaves the current semantic snapshot available for an explicit inspection after %s',
    async (name, input) => {
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
                        e: { d: 1, r: 'button', n: 'Continue', ref: 'ref_action' },
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
      const executor = new BrowserToolExecutor({ tabs: tabPort(), observer, actions });
      const signal = new AbortController().signal;
      const context = { currentTabId: 7 };

      await executor.execute(call('browser_inspect', { mode: 'interactive' }), signal, context);
      const acted = await executor.execute(call(name, input), signal, context);
      const inspected = await executor.execute(
        call('browser_inspect', { mode: 'interactive', since: 'snapshot_before' }),
        signal,
        context,
      );

      expect(JSON.parse(acted.output)).toMatchObject({
        ok: true,
        data: { completed: true },
      });
      expect(JSON.parse(acted.output).data).not.toHaveProperty('verification');
      expect(JSON.parse(inspected.output)).toMatchObject({
        ok: true,
        data: {
          snapshot: 'snapshot_after',
          base: 'snapshot_before',
        },
      });
      expect(observer.inspect).toHaveBeenCalledTimes(2);
      expect(observer.inspect).toHaveBeenLastCalledWith(7, 'interactive', signal, {
        since: 'snapshot_before',
      });
    },
  );

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

  it('dispatches the four bounded network operations without implicitly reloading', async () => {
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
        message: 'Capture started. Earlier traffic is unavailable.',
      })),
      list: vi.fn(async () => [requestSummary]),
      get: vi.fn(async () => ({
        ...requestSummary,
        requestHeaders: {},
        responseHeaders: {},
        protocol: 'h2',
        statusText: 'OK',
        requestBodyIncluded: false as const,
        body: {
          included: true,
          available: true,
          encoding: 'utf8' as const,
          text: '{}',
          truncated: false,
        },
      })),
      stop: vi.fn(async () => undefined),
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
      }),
      signal,
    );
    const details = await executor.execute(
      call('browser_network_get', {
        tabId: 7,
        requestId: 'request_1',
        includeBody: true,
      }),
      signal,
    );
    const stopped = await executor.execute(call('browser_network_stop', { tabId: 7 }), signal);

    expect(network.start).toHaveBeenCalledWith(7, signal);
    expect(network.list).toHaveBeenCalledWith(7, '/api/', 25);
    expect(network.get).toHaveBeenCalledWith(7, 'request_1', true);
    expect(network.stop).toHaveBeenCalledWith(7);
    expect(tabs.reload).not.toHaveBeenCalled();
    expect(JSON.parse(started.output)).toMatchObject({
      ok: true,
      data: { generation: 2 },
    });
    expect(JSON.parse(listed.output)).toMatchObject({
      ok: true,
      data: { requests: [{ requestId: 'request_1' }] },
    });
    expect(JSON.parse(details.output)).toMatchObject({
      ok: true,
      data: { request: { requestId: 'request_1' } },
    });
    expect(JSON.parse(stopped.output)).toMatchObject({
      ok: true,
      data: { stopped: true },
    });
  });

  it('keeps the network debugger with the task after capture stops', async () => {
    const network = {
      start: vi.fn(async () => ({
        tabId: 7,
        generation: 2,
        alreadyActive: false,
        message: 'Capture started.',
      })),
      list: vi.fn(),
      get: vi.fn(),
      stop: vi.fn(async () => undefined),
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
      call('browser_network_list', { tabId: 7, urlPattern: '', limit: 25 }),
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
      });
    })();

    const output = await executor.execute(tool, new AbortController().signal);

    expect(JSON.parse(output.output)).toEqual({ ok: false, ...expected });
    expect(output.output).not.toContain('private page details');
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
