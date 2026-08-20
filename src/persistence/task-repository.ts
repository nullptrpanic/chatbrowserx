import type { IDBPDatabase } from 'idb';
import type { ConversationId, TaskId } from '../shared/ids';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type {
  ContinuationItem,
  ModelOutputContinuationItem,
  PendingToolCall,
} from '../tasks/continuation-types';
import type { TaskEvent, TaskLease, TaskRun, TaskStatus } from '../tasks/task-types';
import type { ChatBrowserDatabase } from './database-schema';

export interface SaveTransitionInput {
  readonly task: TaskRun;
  readonly event: TaskEvent;
  readonly checkpoint: Checkpoint;
}

export interface AcquireLeaseInput {
  readonly taskId: TaskId;
  readonly ownerId: string;
  readonly now: number;
  readonly durationMs: number;
}

export class TaskRepositoryConflictError extends Error {
  readonly code = 'UNAPPLIED_SUPPLEMENTS' as const;

  constructor() {
    super('Task completion requires every accepted WorkSession supplement to be applied.');
    this.name = 'TaskRepositoryConflictError';
  }
}

export interface TaskRepository {
  create(task: TaskRun): Promise<void>;
  createInitial(task: TaskRun, checkpoint: Checkpoint): Promise<void>;
  createContinuation(sourceTaskId: TaskId, task: TaskRun, checkpoint: Checkpoint): Promise<void>;
  get(taskId: TaskId): Promise<TaskRun | undefined>;
  listByConversation(conversationId: ConversationId): Promise<TaskRun[]>;
  listEvents(taskId: TaskId, afterSequence?: number): Promise<TaskEvent[]>;
  getCheckpoint(checkpointId: string): Promise<Checkpoint | undefined>;
  saveTransition(input: SaveTransitionInput): Promise<void>;
  listUnfinished(): Promise<TaskRun[]>;
  listRecoverable(now: number): Promise<TaskRun[]>;
  tryAcquireLease(input: AcquireLeaseInput): Promise<TaskLease | null>;
  releaseLease(taskId: TaskId, ownerId: string, generation: number): Promise<void>;
}

const terminalStatuses = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
const automaticallyRecoverableStatuses = new Set<TaskStatus>(['queued', 'planning']);
const currentStatuses = new Set<string>([
  'queued',
  'planning',
  'waiting_for_auth',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

/** Maps removed concrete-tool states to a safe user-resumable boundary. */
function normalizedStatus(value: string): TaskStatus {
  return currentStatuses.has(value) ? (value as TaskStatus) : 'paused';
}

/** Projects possibly legacy IndexedDB values onto the current tool-free task record. */
function normalizeTask(task: TaskRun): TaskRun {
  const status = normalizedStatus(task.status);
  return {
    id: task.id,
    workSessionId:
      typeof task.workSessionId === 'string' && task.workSessionId.trim().length > 0
        ? task.workSessionId
        : task.id,
    conversationId: task.conversationId,
    tabId: task.tabId,
    goal: task.goal,
    status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    checkpointId: task.checkpointId,
    lease: status === task.status ? task.lease : null,
    lastError: task.lastError,
  };
}

const validToolNamePattern = /^[a-zA-Z0-9_-]+$/;
const MAX_MODEL_OUTPUT_ITEMS_PER_CALL = 8;
const MAX_ENCRYPTED_REASONING_CHARACTERS = 8 * 1024 * 1024;
const MAX_REASONING_SUMMARIES_PER_ITEM = 8;
const MAX_REASONING_SUMMARY_CHARACTERS = 20_000;

function normalizeAttachmentIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return [];
  const ids = value.filter(
    (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256,
  );
  return ids.length === value.length ? [...new Set(ids)] : [];
}

/** Preserves only bounded opaque Provider output required for stateless continuation. */
function normalizeModelOutputItems(
  value: unknown,
): readonly ModelOutputContinuationItem[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MODEL_OUTPUT_ITEMS_PER_CALL) return null;
  const normalized: ModelOutputContinuationItem[] = [];
  const reasoningIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as Record<string, unknown>;
    if (item.type === 'reasoning') {
      if (
        typeof item.itemId !== 'string' ||
        item.itemId.length === 0 ||
        item.itemId.length > 256 ||
        reasoningIds.has(item.itemId) ||
        typeof item.encryptedContent !== 'string' ||
        item.encryptedContent.length === 0 ||
        item.encryptedContent.length > MAX_ENCRYPTED_REASONING_CHARACTERS ||
        !Array.isArray(item.summary) ||
        item.summary.length > MAX_REASONING_SUMMARIES_PER_ITEM
      ) {
        return null;
      }
      const summary: { readonly type: 'summary_text'; readonly text: string }[] = [];
      for (const rawSummary of item.summary) {
        if (typeof rawSummary !== 'object' || rawSummary === null) return null;
        const entry = rawSummary as Record<string, unknown>;
        if (
          entry.type !== 'summary_text' ||
          typeof entry.text !== 'string' ||
          entry.text.length > MAX_REASONING_SUMMARY_CHARACTERS
        ) {
          return null;
        }
        summary.push({ type: 'summary_text', text: entry.text });
      }
      reasoningIds.add(item.itemId);
      normalized.push({
        type: 'reasoning',
        itemId: item.itemId,
        encryptedContent: item.encryptedContent,
        summary,
      });
      continue;
    }
    if (
      item.type !== 'assistant_message_ref' ||
      typeof item.messageId !== 'string' ||
      item.messageId.length === 0 ||
      item.messageId.length > 256 ||
      messageIds.has(item.messageId)
    ) {
      return null;
    }
    messageIds.add(item.messageId);
    normalized.push({ type: 'assistant_message_ref', messageId: item.messageId });
  }
  return normalized;
}

/** Returns a safe completed result or null for malformed or removed legacy tool records. */
function normalizeCompletedToolResult(
  value: unknown,
): Checkpoint['completedToolResults'][number] | null {
  if (typeof value !== 'object' || value === null) return null;
  const result = value as Record<string, unknown>;
  if (
    typeof result.callId !== 'string' ||
    result.callId.length === 0 ||
    typeof result.toolName !== 'string' ||
    !validToolNamePattern.test(result.toolName) ||
    typeof result.argumentsJson !== 'string' ||
    typeof result.output !== 'string' ||
    typeof result.resultRef !== 'string' ||
    result.resultRef.length === 0
  ) {
    return null;
  }
  return {
    callId: result.callId,
    toolName: result.toolName,
    argumentsJson: result.argumentsJson,
    output: result.output,
    resultRef: result.resultRef,
    attachmentIds: normalizeAttachmentIds(result.attachmentIds),
  };
}

/** Rebuilds provider-neutral call/output pairs from legacy completed-tool checkpoints. */
function continuationFromCompletedResults(
  results: Checkpoint['completedToolResults'],
): ContinuationItem[] {
  return results.flatMap((result): ContinuationItem[] => [
    {
      type: 'function_call',
      callId: result.callId,
      name: result.toolName,
      argumentsJson: result.argumentsJson,
    },
    {
      type: 'function_call_output',
      callId: result.callId,
      output: result.output,
      resultRef: result.resultRef,
      attachmentIds: result.attachmentIds ?? [],
    },
  ]);
}

interface NormalizedContinuation {
  readonly items: readonly ContinuationItem[];
  readonly pendingToolCall: PendingToolCall | null;
}

/** Validates continuation state and repairs legacy messages written after an unresolved call. */
function normalizeStoredContinuation(
  rawItems: unknown,
  rawPendingToolCall: unknown,
): NormalizedContinuation | null {
  if (!Array.isArray(rawItems)) return null;

  const items: ContinuationItem[] = [];
  const usedCallIds = new Set<string>();
  let unresolvedCall: Extract<ContinuationItem, { type: 'function_call' }> | null = null;
  for (const value of rawItems) {
    if (typeof value !== 'object' || value === null) return null;
    const item = value as Record<string, unknown>;
    if (item.type === 'message_ref') {
      if (typeof item.messageId !== 'string' || item.messageId.length === 0) return null;
      const messageItem: ContinuationItem = {
        type: 'message_ref',
        messageId: item.messageId,
      };
      if (unresolvedCall === null) {
        items.push(messageItem);
      } else {
        items.splice(items.length - 1, 0, messageItem);
      }
      continue;
    }
    if (item.type === 'function_call') {
      const modelOutputItems = normalizeModelOutputItems(item.modelOutputItems);
      if (
        unresolvedCall !== null ||
        typeof item.callId !== 'string' ||
        item.callId.length === 0 ||
        usedCallIds.has(item.callId) ||
        typeof item.name !== 'string' ||
        !validToolNamePattern.test(item.name) ||
        typeof item.argumentsJson !== 'string' ||
        modelOutputItems === null
      ) {
        return null;
      }
      unresolvedCall = {
        type: 'function_call',
        callId: item.callId,
        name: item.name,
        argumentsJson: item.argumentsJson,
        ...(modelOutputItems.length === 0 ? {} : { modelOutputItems }),
      };
      usedCallIds.add(item.callId);
      items.push(unresolvedCall);
      continue;
    }
    if (item.type === 'function_call_output') {
      if (
        unresolvedCall === null ||
        typeof item.callId !== 'string' ||
        item.callId !== unresolvedCall.callId ||
        typeof item.output !== 'string' ||
        typeof item.resultRef !== 'string' ||
        item.resultRef.length === 0
      ) {
        return null;
      }
      items.push({
        type: 'function_call_output',
        callId: item.callId,
        output: item.output,
        resultRef: item.resultRef,
        attachmentIds: normalizeAttachmentIds(item.attachmentIds),
      });
      unresolvedCall = null;
      continue;
    }
    return null;
  }

  if (unresolvedCall === null) {
    return rawPendingToolCall === null || rawPendingToolCall === undefined
      ? { items, pendingToolCall: null }
      : null;
  }
  if (typeof rawPendingToolCall !== 'object' || rawPendingToolCall === null) return null;
  const pending = rawPendingToolCall as Record<string, unknown>;
  if (
    pending.callId !== unresolvedCall.callId ||
    pending.name !== unresolvedCall.name ||
    pending.argumentsJson !== unresolvedCall.argumentsJson
  ) {
    return null;
  }
  return {
    items,
    pendingToolCall: {
      callId: unresolvedCall.callId,
      name: unresolvedCall.name,
      argumentsJson: unresolvedCall.argumentsJson,
      executionState:
        pending.executionState === 'may_have_dispatched' ? 'may_have_dispatched' : 'recorded',
    },
  };
}

/** Drops removed page state and projects old checkpoints onto safe continuation boundaries. */
function normalizeCheckpoint(checkpoint: Checkpoint): Checkpoint {
  const raw = checkpoint as Checkpoint & {
    readonly continuationItems?: unknown;
    readonly pendingToolCall?: unknown;
    readonly browserToolCallsInAttempt?: unknown;
    readonly browserTargetTabId?: unknown;
  };
  const completedToolResults = Array.isArray(checkpoint.completedToolResults)
    ? checkpoint.completedToolResults
        .map(normalizeCompletedToolResult)
        .filter((result): result is NonNullable<typeof result> => result !== null)
    : [];
  const storedContinuation = normalizeStoredContinuation(
    raw.continuationItems,
    raw.pendingToolCall,
  );
  const browserTargetTabId =
    raw.browserTargetTabId === null ||
    (typeof raw.browserTargetTabId === 'number' &&
      Number.isSafeInteger(raw.browserTargetTabId) &&
      raw.browserTargetTabId >= 0 &&
      raw.browserTargetTabId <= 2_147_483_647)
      ? raw.browserTargetTabId
      : undefined;
  const browserToolCallsInAttempt =
    typeof raw.browserToolCallsInAttempt === 'number' &&
    Number.isSafeInteger(raw.browserToolCallsInAttempt) &&
    raw.browserToolCallsInAttempt >= 0
      ? raw.browserToolCallsInAttempt
      : 0;
  const continuationItems =
    storedContinuation?.items ?? continuationFromCompletedResults(completedToolResults);
  return {
    id: checkpoint.id,
    taskId: checkpoint.taskId,
    sequence: checkpoint.sequence,
    taskStatus: normalizedStatus(checkpoint.taskStatus),
    completedToolResults,
    continuationItems,
    pendingToolCall: storedContinuation?.pendingToolCall ?? null,
    browserToolCallsInAttempt,
    ...(browserTargetTabId === undefined ? {} : { browserTargetTabId }),
    createdAt: checkpoint.createdAt,
  };
}

/**
 * Builds the bounded compound-key range for all sequence values belonging to one task.
 */
function taskSequenceRange(taskId: TaskId, afterSequence = -1): IDBKeyRange {
  return IDBKeyRange.bound(
    [taskId, Math.max(0, afterSequence + 1)],
    [taskId, Number.MAX_SAFE_INTEGER],
  );
}

/** Builds the time-ordered message range for one conversation. */
function conversationTimeRange(conversationId: ConversationId): IDBKeyRange {
  return IDBKeyRange.bound([conversationId, 0], [conversationId, Number.MAX_SAFE_INTEGER]);
}

export class IndexedDbTaskRepository implements TaskRepository {
  readonly #database: IDBPDatabase<ChatBrowserDatabase>;

  /**
   * Creates a task repository over an already opened application database.
   */
  constructor(database: IDBPDatabase<ChatBrowserDatabase>) {
    this.#database = database;
  }

  /**
   * Inserts a new task and rejects identifier collisions instead of overwriting prior history.
   */
  async create(task: TaskRun): Promise<void> {
    await this.#database.add('tasks', task);
  }

  /**
   * Atomically inserts a queued task and its sequence-zero recovery checkpoint.
   */
  async createInitial(task: TaskRun, checkpoint: Checkpoint): Promise<void> {
    if (
      task.status !== 'queued' ||
      task.checkpointId !== checkpoint.id ||
      checkpoint.taskId !== task.id ||
      checkpoint.sequence !== 0 ||
      checkpoint.taskStatus !== 'queued' ||
      checkpoint.createdAt !== task.createdAt
    ) {
      throw new Error('Initial task records do not describe the same queued boundary.');
    }

    const transaction = this.#database.transaction(['tasks', 'checkpoints'], 'readwrite');
    await transaction.objectStore('tasks').add(task);
    await transaction.objectStore('checkpoints').add(checkpoint);
    await transaction.done;
  }

  /**
   * Atomically creates one queued continuation only from the latest cancelled run in a WorkSession.
   */
  async createContinuation(
    sourceTaskId: TaskId,
    task: TaskRun,
    checkpoint: Checkpoint,
  ): Promise<void> {
    if (
      task.status !== 'queued' ||
      task.checkpointId !== checkpoint.id ||
      checkpoint.taskId !== task.id ||
      checkpoint.sequence !== 0 ||
      checkpoint.taskStatus !== 'queued' ||
      checkpoint.createdAt !== task.createdAt
    ) {
      throw new Error('Continuation records do not describe the same queued boundary.');
    }

    const transaction = this.#database.transaction(['tasks', 'checkpoints'], 'readwrite');
    const sourceValue = await transaction.objectStore('tasks').get(sourceTaskId);
    if (sourceValue === undefined) {
      throw new Error('Continuation source task does not exist.');
    }
    const source = normalizeTask(sourceValue);
    const conversationTasks = await transaction
      .objectStore('tasks')
      .index('by-conversation')
      .getAll(source.conversationId);
    const workSessionTasks = conversationTasks
      .map(normalizeTask)
      .filter((candidate) => candidate.workSessionId === source.workSessionId)
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          left.updatedAt - right.updatedAt ||
          left.id.localeCompare(right.id),
      );
    const latest = workSessionTasks.at(-1);
    if (source.status !== 'cancelled' || latest?.id !== source.id) {
      throw new Error('Continuation source must be the latest cancelled WorkSession task.');
    }
    if (
      task.conversationId !== source.conversationId ||
      task.workSessionId !== source.workSessionId
    ) {
      throw new Error('Continuation task must remain in the source WorkSession.');
    }

    await transaction.objectStore('tasks').add(task);
    await transaction.objectStore('checkpoints').add(checkpoint);
    await transaction.done;
  }

  /**
   * Retrieves one durable task by its stable identifier.
   */
  async get(taskId: TaskId): Promise<TaskRun | undefined> {
    const task = await this.#database.get('tasks', taskId);
    return task === undefined ? undefined : normalizeTask(task);
  }

  /**
   * Lists all tasks in one conversation ordered from oldest to newest update time.
   */
  async listByConversation(conversationId: ConversationId): Promise<TaskRun[]> {
    const tasks = await this.#database.getAllFromIndex('tasks', 'by-conversation', conversationId);
    return tasks.map(normalizeTask).sort((left, right) => left.updatedAt - right.updatedAt);
  }

  /**
   * Lists append-only task events after an optional sequence boundary.
   */
  async listEvents(taskId: TaskId, afterSequence = -1): Promise<TaskEvent[]> {
    return this.#database.getAllFromIndex(
      'task-events',
      'by-task-sequence',
      taskSequenceRange(taskId, afterSequence),
    );
  }

  /**
   * Retrieves one durable checkpoint by its stable identifier.
   */
  async getCheckpoint(checkpointId: string): Promise<Checkpoint | undefined> {
    const checkpoint = await this.#database.get('checkpoints', checkpointId);
    return checkpoint === undefined ? undefined : normalizeCheckpoint(checkpoint);
  }

  /** Atomically saves a task transition, append-only event, and immutable checkpoint. */
  async saveTransition(input: SaveTransitionInput): Promise<void> {
    if (
      input.event.taskId !== input.task.id ||
      input.checkpoint.taskId !== input.task.id ||
      input.task.checkpointId !== input.checkpoint.id
    ) {
      throw new Error('Task transition records do not belong to the same task.');
    }
    if (
      input.event.at !== input.task.updatedAt ||
      input.checkpoint.taskStatus !== input.task.status ||
      input.checkpoint.sequence !== input.event.sequence
    ) {
      throw new Error('Task transition records do not describe the same durable boundary.');
    }
    const transaction = this.#database.transaction(
      ['tasks', 'task-events', 'checkpoints', 'messages'],
      'readwrite',
    );
    const existingTask = await transaction.objectStore('tasks').get(input.task.id);
    if (existingTask === undefined) {
      throw new Error('Task does not exist.');
    }

    const latestEvent = await transaction
      .objectStore('task-events')
      .index('by-task-sequence')
      .openCursor(taskSequenceRange(input.task.id), 'prev');
    const expectedSequence = (latestEvent?.value.sequence ?? 0) + 1;
    if (input.event.sequence !== expectedSequence) {
      throw new Error(`Task event sequence must be ${expectedSequence}.`);
    }

    if (input.event.type === 'task.completed') {
      if (input.checkpoint.pendingToolCall !== null) {
        throw new Error('A task with a pending tool call cannot complete.');
      }
      const existing = normalizeTask(existingTask);
      const conversationTasks = await transaction
        .objectStore('tasks')
        .index('by-conversation')
        .getAll(existing.conversationId);
      const workSessionTaskIds = new Set(
        conversationTasks
          .map(normalizeTask)
          .filter((task) => task.workSessionId === existing.workSessionId)
          .map((task) => task.id),
      );
      const referencedMessageIds = new Set(
        input.checkpoint.continuationItems.flatMap((item) =>
          item.type === 'message_ref' ? [item.messageId] : [],
        ),
      );
      const messages = await transaction
        .objectStore('messages')
        .index('by-conversation-created-at')
        .getAll(conversationTimeRange(existing.conversationId));
      if (
        messages.some(
          (message) =>
            message.kind === 'supplement' &&
            message.taskId !== null &&
            workSessionTaskIds.has(message.taskId) &&
            !referencedMessageIds.has(message.id),
        )
      ) {
        throw new TaskRepositoryConflictError();
      }
    }

    await transaction.objectStore('tasks').put(input.task);
    await transaction.objectStore('task-events').add(input.event);
    await transaction.objectStore('checkpoints').add(input.checkpoint);
    await transaction.done;
  }

  /**
   * Lists every non-terminal task for browser-startup recovery decisions.
   */
  async listUnfinished(): Promise<TaskRun[]> {
    const tasks = await this.#database.getAll('tasks');
    return tasks
      .map(normalizeTask)
      .filter((task) => !terminalStatuses.has(task.status))
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  /**
   * Lists automatic-recovery tasks only when their lease is absent or expired at the supplied time.
   */
  async listRecoverable(now: number): Promise<TaskRun[]> {
    const tasks = await this.#database.getAll('tasks');
    return tasks
      .map(normalizeTask)
      .filter(
        (task) =>
          automaticallyRecoverableStatuses.has(task.status) &&
          (task.lease === null || task.lease.expiresAt <= now),
      )
      .sort((left, right) => left.updatedAt - right.updatedAt);
  }

  /**
   * Acquires or takes over an expired task lease and returns its monotonically increasing generation.
   */
  async tryAcquireLease(input: AcquireLeaseInput): Promise<TaskLease | null> {
    if (
      input.ownerId.trim().length === 0 ||
      !Number.isFinite(input.now) ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs <= 0
    ) {
      throw new Error('Lease acquisition input is invalid.');
    }

    const transaction = this.#database.transaction('tasks', 'readwrite');
    const task = await transaction.store.get(input.taskId);
    if (task === undefined) {
      throw new Error('Task does not exist.');
    }
    if (task.lease !== null && task.lease.expiresAt > input.now) {
      if (task.lease.ownerId !== input.ownerId) {
        await transaction.done;
        return null;
      }

      const renewedLease: TaskLease = {
        ...task.lease,
        expiresAt: input.now + input.durationMs,
      };
      await transaction.store.put({ ...task, lease: renewedLease });
      await transaction.done;
      return renewedLease;
    }

    const lease: TaskLease = {
      ownerId: input.ownerId,
      acquiredAt: input.now,
      expiresAt: input.now + input.durationMs,
      generation: (task.lease?.generation ?? 0) + 1,
    };
    await transaction.store.put({ ...task, lease });
    await transaction.done;
    return lease;
  }

  /**
   * Releases a lease only when both owner and generation still match the durable task record.
   */
  async releaseLease(taskId: TaskId, ownerId: string, generation: number): Promise<void> {
    const transaction = this.#database.transaction('tasks', 'readwrite');
    const task = await transaction.store.get(taskId);
    if (
      task !== undefined &&
      task.lease?.ownerId === ownerId &&
      task.lease.generation === generation
    ) {
      await transaction.store.put({ ...task, lease: null });
    }
    await transaction.done;
  }
}
