import { describe, expect, it, vi } from 'vitest';
import type { BrowserActionRequest } from '../../src/browser/contracts/action';
import type { BrowserActionEvidence } from '../../src/browser/contracts/evidence';
import type { ObservedElement, PageObservation } from '../../src/browser/contracts/observation';
import { createElementTarget } from '../../src/browser/contracts/target';
import { BrowserExecutor } from '../../src/agent/browser-executor';
import type { AgentEvent, AgentPlanInput } from '../../src/agent/execution-types';
import type {
  AcquireLeaseInput,
  SaveTransitionInput,
  TaskRepository,
} from '../../src/persistence/task-repository';
import type { Checkpoint } from '../../src/tasks/checkpoint-types';
import { TaskCommandService } from '../../src/tasks/task-command-service';
import { createTask } from '../../src/tasks/task-factory';
import type { TaskEvent, TaskLease, TaskRun } from '../../src/tasks/task-types';
import type { TrackedTab } from '../../src/platform/chrome/tab-tracker';
import type { VerificationResult } from '../../src/browser/verify/verification-engine';
import { providerErrorFromCode } from '../../src/providers/provider-errors';
import { ToolCallError } from '../../src/agent/tools/tool-parser';

type SaveHook = (input: SaveTransitionInput) => void;

class InMemoryExecutionRepository implements TaskRepository {
  readonly tasks = new Map<string, TaskRun>();
  readonly checkpoints = new Map<string, Checkpoint>();
  readonly events = new Map<string, TaskEvent[]>();
  beforeSave: SaveHook | null = null;
  afterSave: SaveHook | null = null;

  /** Inserts a standalone task record for interface completeness. */
  async create(task: TaskRun): Promise<void> {
    this.tasks.set(task.id, task);
  }

  /** Inserts one queued task and its initial checkpoint. */
  async createInitial(task: TaskRun, checkpoint: Checkpoint): Promise<void> {
    this.tasks.set(task.id, task);
    this.checkpoints.set(checkpoint.id, checkpoint);
  }

  /** Returns one task snapshot from memory. */
  async get(taskId: string): Promise<TaskRun | undefined> {
    return this.tasks.get(taskId);
  }

  /** Lists tasks for one conversation in stable insertion order. */
  async listByConversation(conversationId: string): Promise<TaskRun[]> {
    return [...this.tasks.values()].filter((task) => task.conversationId === conversationId);
  }

  /** Lists the append-only events after an optional durable sequence. */
  async listEvents(taskId: string, afterSequence = -1): Promise<TaskEvent[]> {
    return (this.events.get(taskId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  /** Returns one immutable checkpoint by identifier. */
  async getCheckpoint(checkpointId: string): Promise<Checkpoint | undefined> {
    return this.checkpoints.get(checkpointId);
  }

  /** Persists a boundary atomically and exposes before/after hooks for termination injection. */
  async saveTransition(input: SaveTransitionInput): Promise<void> {
    this.beforeSave?.(input);
    const events = this.events.get(input.task.id) ?? [];
    const expected = (events.at(-1)?.sequence ?? 0) + 1;
    if (input.event.sequence !== expected) throw new Error('Unexpected event sequence.');
    this.tasks.set(input.task.id, input.task);
    this.checkpoints.set(input.checkpoint.id, input.checkpoint);
    this.events.set(input.task.id, [...events, input.event]);
    this.afterSave?.(input);
  }

  /** Lists all nonterminal records for the recovery port. */
  async listUnfinished(): Promise<TaskRun[]> {
    return [...this.tasks.values()].filter(
      (task) => !['completed', 'failed', 'cancelled'].includes(task.status),
    );
  }

  /** Lists runnable records whose lease is absent or expired. */
  async listRecoverable(now: number): Promise<TaskRun[]> {
    return (await this.listUnfinished()).filter(
      (task) => task.lease === null || task.lease.expiresAt <= now,
    );
  }

  /** Acquires or renews a deterministic in-memory fencing lease. */
  async tryAcquireLease(input: AcquireLeaseInput): Promise<TaskLease | null> {
    const task = this.tasks.get(input.taskId);
    if (task === undefined) throw new Error('Task does not exist.');
    if (
      task.lease !== null &&
      task.lease.expiresAt > input.now &&
      task.lease.ownerId !== input.ownerId
    ) {
      return null;
    }
    const lease: TaskLease = {
      ownerId: input.ownerId,
      acquiredAt: task.lease?.acquiredAt ?? input.now,
      expiresAt: input.now + input.durationMs,
      generation:
        task.lease?.ownerId === input.ownerId
          ? task.lease.generation
          : (task.lease?.generation ?? 0) + 1,
    };
    this.tasks.set(task.id, { ...task, lease });
    return lease;
  }

  /** Releases only the matching in-memory fencing lease. */
  async releaseLease(taskId: string, ownerId: string, generation: number): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task?.lease?.ownerId === ownerId && task.lease.generation === generation) {
      this.tasks.set(taskId, { ...task, lease: null });
    }
  }
}

const observedButton: ObservedElement = {
  observationRef: 'observation_1:element:0',
  framePath: [],
  shadowPath: [],
  role: 'button',
  name: 'Continue',
  label: null,
  text: 'Continue',
  value: null,
  stableAttributes: { 'data-testid': 'continue' },
  ancestorHint: 'Profile form',
  state: { disabled: false, checked: null, selected: null, expanded: null },
  rect: { x: 20, y: 20, width: 100, height: 32 },
  visible: true,
  obscured: false,
  backendNodeId: null,
  cdpSessionId: null,
};

const observation: PageObservation = {
  id: 'observation_1',
  capturedAt: 1_000,
  tabId: 7,
  url: 'https://example.test/form',
  title: 'Form',
  viewport: { width: 1_280, height: 720, scrollX: 0, scrollY: 0 },
  textRegions: [],
  elements: [observedButton],
  frames: [],
  truncated: false,
};

/** Builds the low-risk click used by effect-boundary recovery scenarios. */
function buildAction(name = 'Continue'): BrowserActionRequest {
  return {
    actionId: 'action_1',
    tabId: 7,
    type: 'click',
    target: { ...createElementTarget(observedButton), name, text: name },
    risk: 'low',
    expected: { type: 'text.contains', text: 'Saved' },
  };
}

/** Creates a durable task, fake planner, browser, and restartable executor factory. */
async function buildFixture(action: BrowserActionRequest = buildAction()) {
  let now = 1_000;
  let idSequence = 0;
  let effectApplied = false;
  const repository = new InMemoryExecutionRepository();
  const initial = createTask(
    { conversationId: 'conversation_1', tabId: 7, goal: 'Complete the form' },
    { clock: { now: () => now }, ids: { create: () => 'task_1' } },
  );
  const task: TaskRun = { ...initial, checkpointId: 'checkpoint_0' };
  const checkpoint: Checkpoint = {
    id: 'checkpoint_0',
    taskId: task.id,
    sequence: 0,
    taskStatus: 'queued',
    completedToolResults: [],
    observationRef: null,
    pendingAction: null,
    createdAt: now,
  };
  await repository.createInitial(task, checkpoint);

  const plan = vi.fn<(input: AgentPlanInput) => AsyncGenerator<AgentEvent>>((input) =>
    (async function* () {
      if (input.checkpoint.pendingAction?.outcome === 'verified') {
        yield { type: 'task.completed' as const, reason: 'Goal verified.' };
        return;
      }
      yield {
        type: 'browser.action' as const,
        action,
        callId: 'call_browser_1',
        argumentsJson: '{"action":{"type":"click"}}',
      };
    })(),
  );
  const execute = vi.fn(async (input: { readonly action: BrowserActionRequest }) => {
    effectApplied = true;
    const evidence: BrowserActionEvidence = {
      actionId: input.action.actionId,
      actionKind: input.action.type,
      driver: 'dom',
      status: 'executed',
      startedAt: now,
      finishedAt: now + 10,
      resolvedTarget: { role: 'button', name: 'Continue', frameDepth: 0, shadowDepth: 0 },
      beforeUrl: observation.url,
      afterUrl: observation.url,
      commandResult: {},
    };
    return evidence;
  });
  const verify = vi.fn(async (): Promise<VerificationResult> => ({
    satisfied: effectApplied,
    timedOut: !effectApplied,
    checkedAt: now,
    evidence: { kind: 'text.contains', details: { found: effectApplied } },
  }));
  const release = vi.fn(async () => undefined);
  const recordVerification = vi.fn(async () => undefined);
  const captureVisual = vi.fn(async () => 'data:image/png;base64,AQID');
  const observe = vi.fn(async () => observation);
  const hasTab = vi.fn(async (tabId: number) => tabId === 7);
  const findAdoptableTab = vi.fn(async (): Promise<TrackedTab | null> => null);
  const search = vi.fn(async () => ({
    results: [
      {
        title: 'Result',
        url: 'https://example.test/result',
        content: 'bounded result',
        score: 0.9,
        source: 'search' as const,
      },
    ],
    truncated: false,
  }));
  const extract = vi.fn(async () => ({ results: [], truncated: false }));
  const crawl = vi.fn(async () => ({ results: [], truncated: false }));
  const clock = { now: () => ++now };
  const ids = { create: (prefix: string) => `${prefix}_${String(++idSequence)}` };
  const dependencies = {
    repository,
    planner: { plan },
    browser: {
      observe,
      execute,
      verify,
      recordVerification,
      release,
    },
    tabs: {
      hasTab,
      findAdoptableTab,
    },
    tavily: { search, extract, crawl },
    visuals: { capture: captureVisual },
    clock,
    ids,
  };

  return {
    repository,
    plan,
    execute,
    verify,
    release,
    recordVerification,
    captureVisual,
    observe,
    hasTab,
    findAdoptableTab,
    search,
    extract,
    crawl,
    clock,
    ids,
    createExecutor: () => new BrowserExecutor(dependencies),
  };
}

/** Throws once at a selected durable event either before or after persistence. */
function terminateOnce(
  repository: InMemoryExecutionRepository,
  position: 'before' | 'after',
  eventType: TaskEvent['type'],
): void {
  const hook: SaveHook = (input) => {
    if (input.event.type !== eventType) return;
    if (position === 'before') repository.beforeSave = null;
    else repository.afterSave = null;
    throw new Error(`terminated ${position} ${eventType}`);
  };
  if (position === 'before') repository.beforeSave = hook;
  else repository.afterSave = hook;
}

describe('BrowserExecutor effect-boundary recovery', () => {
  it('adds one transient viewport image only when semantic observation has low signal', async () => {
    const fixture = await buildFixture();
    fixture.observe.mockResolvedValue({ ...observation, elements: [], textRegions: [] });

    await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(fixture.captureVisual).toHaveBeenCalledWith(7);
    expect(fixture.plan.mock.calls[0]?.[0]).toMatchObject({
      visualImageUrl: 'data:image/png;base64,AQID',
    });
  });
  it('replans safely when terminated before the action intent is durable', async () => {
    const fixture = await buildFixture();
    terminateOnce(fixture.repository, 'before', 'action.intent-recorded');

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).rejects.toThrow(/terminated/);
    expect(fixture.execute).not.toHaveBeenCalled();

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('verifies an unknown low-risk intent before deciding to execute it', async () => {
    const fixture = await buildFixture();
    terminateOnce(fixture.repository, 'after', 'action.intent-recorded');

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).rejects.toThrow(/terminated/);
    expect(fixture.execute).not.toHaveBeenCalled();

    await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(fixture.verify).toHaveBeenCalledBefore(fixture.execute);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('does not treat page stability alone as proof that an unknown effect occurred', async () => {
    const action: BrowserActionRequest = {
      ...buildAction(),
      expected: { type: 'page.stable', quietMs: 300 },
    };
    const fixture = await buildFixture(action);
    fixture.verify.mockResolvedValue({
      satisfied: true,
      timedOut: false,
      checkedAt: 1_100,
      evidence: { kind: 'page.stable', details: { quietMs: 300 } },
    });
    terminateOnce(fixture.repository, 'after', 'action.intent-recorded');

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).rejects.toThrow(/terminated/);
    await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('does not replay an effect when termination happens before evidence persistence', async () => {
    const fixture = await buildFixture();
    terminateOnce(fixture.repository, 'before', 'action.evidence-recorded');

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).rejects.toThrow(/terminated/);
    expect(fixture.execute).toHaveBeenCalledTimes(1);

    await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(fixture.verify).toHaveBeenCalled();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('does not replay an action after the verified checkpoint is durable', async () => {
    const fixture = await buildFixture();
    terminateOnce(fixture.repository, 'after', 'action.verified');

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).rejects.toThrow(/terminated/);
    expect(fixture.execute).toHaveBeenCalledTimes(1);

    await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(fixture.execute).toHaveBeenCalledTimes(1);
    const latestTask = await fixture.repository.get('task_1');
    const latestCheckpoint =
      latestTask?.checkpointId === null || latestTask?.checkpointId === undefined
        ? undefined
        : await fixture.repository.getCheckpoint(latestTask.checkpointId);
    expect(latestCheckpoint?.completedToolResults).toContainEqual(
      expect.objectContaining({
        callId: 'call_browser_1',
        toolName: 'browser.act',
        argumentsJson: '{"action":{"type":"click"}}',
      }),
    );
    await expect(fixture.repository.listEvents('task_1')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action.intent-recorded', actionId: 'action_1' }),
        expect.objectContaining({ type: 'action.verified', actionId: 'action_1' }),
      ]),
    );
  });

  it('requires confirmation before a policy-classified high-risk action', async () => {
    const fixture = await buildFixture(buildAction('Delete account'));

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).resolves.toMatchObject({
      task: { status: 'waiting_for_confirmation' },
      checkpoint: {
        pendingAction: { risk: 'high', attemptCount: 0, confirmation: null },
      },
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('consumes confirmation for one attempt and asks again when its result is unknown', async () => {
    const fixture = await buildFixture(buildAction('Delete account'));
    const waiting = await fixture.createExecutor().run('task_1', new AbortController().signal);
    const digest = waiting.checkpoint.pendingAction?.digest;
    expect(digest).toMatch(/^sha256:/);
    const commands = new TaskCommandService(fixture.repository, fixture.clock, fixture.ids);
    await commands.confirm('task_1', digest as string);
    terminateOnce(fixture.repository, 'after', 'action.intent-recorded');

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).rejects.toThrow(/terminated/);
    const recovered = await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(recovered).toMatchObject({
      task: { status: 'waiting_for_confirmation' },
      checkpoint: {
        pendingAction: { attemptCount: 1, confirmation: null, effectState: 'unknown' },
      },
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('does not reuse a confirmation after the user explicitly rebinds a missing tab', async () => {
    const fixture = await buildFixture(buildAction('Delete account'));
    const waiting = await fixture.createExecutor().run('task_1', new AbortController().signal);
    const originalDigest = waiting.checkpoint.pendingAction?.digest as string;
    const commands = new TaskCommandService(fixture.repository, fixture.clock, fixture.ids);
    await commands.confirm('task_1', originalDigest);
    fixture.hasTab.mockResolvedValue(false);
    await fixture.createExecutor().run('task_1', new AbortController().signal);
    fixture.hasTab.mockImplementation(async (tabId) => tabId === 9);
    await commands.resume('task_1', 9);

    const rebound = await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(rebound).toMatchObject({
      task: { status: 'waiting_for_confirmation', tabId: 9 },
      checkpoint: { pendingAction: { confirmation: null, attemptCount: 0 } },
    });
    expect(rebound.checkpoint.pendingAction?.digest).not.toBe(originalDigest);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('waits for explicit rebinding when the exact task tab is gone', async () => {
    const fixture = await buildFixture();
    fixture.hasTab.mockResolvedValue(false);

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).resolves.toMatchObject({ task: { status: 'waiting_for_tab', tabId: null } });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('adopts a matching new tab created after intent when that is the expected effect', async () => {
    const action: BrowserActionRequest = {
      ...buildAction('Open details'),
      expected: { type: 'tab.opened', openerTabId: 7 },
    };
    const fixture = await buildFixture(action);
    fixture.hasTab.mockImplementation(async (tabId) => tabId === 7 || tabId === 9);
    fixture.findAdoptableTab.mockResolvedValue({
      id: 9,
      openerTabId: 7,
      url: 'https://example.test/details',
      title: 'Details',
      createdAt: 1_100,
      updatedAt: 1_100,
    });

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).resolves.toMatchObject({ task: { status: 'completed', tabId: 9 } });
    expect(fixture.findAdoptableTab).toHaveBeenCalledWith({
      openerTabId: 7,
      createdAfter: expect.any(Number),
    });
  });

  it('uses the bounded waitFor timeout instead of the ordinary verification timeout', async () => {
    const action: BrowserActionRequest = {
      actionId: 'wait_1',
      tabId: 7,
      type: 'waitFor',
      timeoutMs: 12_000,
      risk: 'low',
      expected: { type: 'text.contains', text: 'Saved' },
    };
    const fixture = await buildFixture(action);

    await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(fixture.verify).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 12_000 }));
  });

  it('checkpoints Tavily output before asking the model for another turn', async () => {
    const fixture = await buildFixture();
    fixture.plan.mockImplementation((input: AgentPlanInput) =>
      (async function* () {
        if (
          input.checkpoint.completedToolResults.some((result) => result.callId === 'call_search')
        ) {
          yield { type: 'task.completed' as const, reason: 'Search result used.' };
          return;
        }
        yield {
          type: 'tavily.call' as const,
          callId: 'call_search',
          argumentsJson: '{"query":"reliability","maxResults":2}',
          operation: 'search' as const,
          arguments: { query: 'reliability', maxResults: 2 },
        };
      })(),
    );

    const result = await fixture.createExecutor().run('task_1', new AbortController().signal);

    expect(result.task.status).toBe('completed');
    expect(fixture.search).toHaveBeenCalledOnce();
    expect(result.checkpoint.completedToolResults).toContainEqual(
      expect.objectContaining({
        callId: 'call_search',
        toolName: 'tavily.search',
        argumentsJson: '{"query":"reliability","maxResults":2}',
        output: expect.stringContaining('bounded result'),
      }),
    );
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('restarts an interrupted model turn from the verified tool checkpoint without replay', async () => {
    const fixture = await buildFixture();
    let plannerTurns = 0;
    fixture.plan.mockImplementation((input: AgentPlanInput) =>
      (async function* () {
        plannerTurns += 1;
        if (input.checkpoint.completedToolResults.length === 0) {
          yield {
            type: 'browser.action' as const,
            action: buildAction(),
            callId: 'call_once',
            argumentsJson: '{"action":{"type":"click"}}',
          };
          return;
        }
        throw providerErrorFromCode('ABORTED');
      })(),
    );

    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(plannerTurns).toBe(2);

    fixture.plan.mockImplementation((input: AgentPlanInput) =>
      (async function* () {
        expect(input.checkpoint.completedToolResults).toContainEqual(
          expect.objectContaining({ callId: 'call_once', output: expect.stringContaining('true') }),
        );
        yield { type: 'task.completed' as const, reason: 'Recovered.' };
      })(),
    );
    await expect(
      fixture.createExecutor().run('task_1', new AbortController().signal),
    ).resolves.toMatchObject({ task: { status: 'completed' } });
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it('persists provider auth waits and consumes one replan for invalid model tools', async () => {
    const authFixture = await buildFixture();
    authFixture.plan.mockImplementation(() =>
      (async function* () {
        yield* [];
        throw providerErrorFromCode('AUTH', { status: 401 });
      })(),
    );
    await expect(
      authFixture.createExecutor().run('task_1', new AbortController().signal),
    ).resolves.toMatchObject({
      task: { status: 'waiting_for_auth', lastError: { code: 'AuthError' } },
    });

    const invalidFixture = await buildFixture();
    let calls = 0;
    invalidFixture.plan.mockImplementation(() =>
      (async function* () {
        calls += 1;
        if (calls === 1) throw new ToolCallError('INVALID_ARGUMENTS');
        yield { type: 'task.completed' as const, reason: 'Replanned.' };
      })(),
    );
    await expect(
      invalidFixture.createExecutor().run('task_1', new AbortController().signal),
    ).resolves.toMatchObject({
      task: { status: 'completed', budget: { replansUsed: 1 } },
    });
  });
});
