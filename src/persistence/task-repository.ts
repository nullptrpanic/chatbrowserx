import type { IDBPDatabase, IDBPTransaction } from 'idb';
import type { ConversationId, TaskId, TaskRunId, ToolCallKey } from '../shared/ids';
import { compactionItemSchema } from '../shared/protocol/compaction-item';
import { orderedTaskEvents } from '../tasks/task-history-order';
import {
  createInitialSubmission,
  taskGoal,
  type TaskFactoryDependencies,
} from '../tasks/task-factory';
import { pendingTaskSupplementIds } from '../tasks/task-supplements';
import type { Checkpoint } from '../tasks/checkpoint-types';
import type { Conversation } from '../tasks/conversation-types';
import type { MessageRecord } from '../tasks/message-types';
import type { Task, TaskEvent, TaskLease, TaskRun, TaskStatus } from '../tasks/task-types';
import type { MaterializedToolResult, ToolResult } from '../tasks/tool-result-types';
import type { AgentSessionBackup, ChatBrowserDatabase } from './database-schema';
import type { AgentSession } from '../tasks/agent-session-types';

export interface SaveTransitionInput {
  readonly session?: AgentSession;
  readonly task: Task;
  readonly run: TaskRun;
  readonly events: readonly TaskEvent[];
  readonly checkpoint: Checkpoint | null;
  readonly deleteCheckpoint?: boolean;
  readonly toolResults?: readonly ToolResult[];
  readonly followUpFactory?: TaskFactoryDependencies;
}

export interface QueuedTask {
  readonly taskId: TaskId;
  readonly runId: TaskRunId;
}

interface SavedFollowUp {
  readonly nextTask: QueuedTask;
  readonly sourceEvents: readonly TaskEvent[];
}

export interface CreateSubmissionInput {
  readonly conversation: Conversation;
  readonly createConversation: boolean;
  readonly message: MessageRecord;
  readonly task: Task;
  readonly run: TaskRun;
  readonly events: readonly TaskEvent[];
  readonly checkpoint: Checkpoint;
  /** Present only when this message starts another run of an existing recoverable task. */
  readonly continuationSourceTaskId?: TaskId;
}

export interface AppendTaskMessageInput {
  readonly message: MessageRecord;
  readonly eventId: string;
  readonly at: number;
}

interface AppendSupplementInput extends AppendTaskMessageInput {
  readonly followUpFactory: TaskFactoryDependencies;
}

export interface AcquireLeaseInput {
  readonly taskId: TaskId;
  readonly ownerId: string;
  readonly now: number;
  readonly durationMs: number;
}

/** One transactionally consistent view of the logical task and its latest attempt. */
export interface ActiveTaskRuntimeSnapshot {
  readonly task: Task;
  readonly run: TaskRun;
  readonly checkpoint: Checkpoint | undefined;
  readonly events: readonly TaskEvent[];
  readonly toolResults: readonly MaterializedToolResult[];
}

/** Current attempt metadata plus only the events appended after an executor snapshot. */
export interface ActiveTaskRuntimeDelta {
  readonly task: Task;
  readonly run: TaskRun;
  readonly checkpoint: Checkpoint | undefined;
  readonly events: readonly TaskEvent[];
}

/** Permanent task ordering facts without any potentially large tool-result payloads. */
export interface PersistedTaskTimeline {
  readonly task: Task;
  readonly runs: readonly TaskRun[];
  readonly events: readonly TaskEvent[];
}

/** A full timeline plus only the tool-result payloads needed by one bounded detail window. */
export interface PersistedTaskDetailWindow extends PersistedTaskTimeline {
  readonly toolResults: readonly MaterializedToolResult[];
}

export class TaskRepositoryConflictError extends Error {
  readonly code: 'STALE_BOUNDARY' | 'UNAPPLIED_SUPPLEMENTS';

  constructor(code: 'STALE_BOUNDARY' | 'UNAPPLIED_SUPPLEMENTS' = 'UNAPPLIED_SUPPLEMENTS') {
    super(
      code === 'STALE_BOUNDARY'
        ? 'Task state changed before the durable boundary was committed.'
        : 'Task completion requires every accepted supplement to be applied.',
    );
    this.name = 'TaskRepositoryConflictError';
    this.code = code;
  }
}

export class TaskRepositoryBusyError extends Error {
  constructor() {
    super('Another task is already running.');
    this.name = 'TaskRepositoryBusyError';
  }
}

export interface TaskRepository {
  getAgentSession(conversationId: ConversationId): Promise<AgentSession | undefined>;
  createSubmission(input: CreateSubmissionInput): Promise<Task>;
  appendTaskMessage(input: AppendSupplementInput): Promise<TaskEvent | QueuedTask>;
  appendTaskMessage(input: AppendTaskMessageInput): Promise<TaskEvent>;
  startRun(task: Task, run: TaskRun, event: TaskEvent, checkpoint: Checkpoint): Promise<void>;
  get(taskId: TaskId): Promise<Task | undefined>;
  getRun(runId: TaskRunId): Promise<TaskRun | undefined>;
  readActiveRuntimeSnapshot(taskId: TaskId): Promise<ActiveTaskRuntimeSnapshot | undefined>;
  readActiveRuntimeDelta(
    taskId: TaskId,
    afterSequence: number,
  ): Promise<ActiveTaskRuntimeDelta | undefined>;
  readTaskTimelines(taskIds: readonly TaskId[]): Promise<PersistedTaskTimeline[]>;
  readTaskDetailWindow(
    taskId: TaskId,
    maxDetailEvents: number,
  ): Promise<PersistedTaskDetailWindow | undefined>;
  listByConversation(conversationId: ConversationId): Promise<Task[]>;
  listAll(): Promise<Task[]>;
  listRuns(taskId: TaskId): Promise<TaskRun[]>;
  listEvents(taskId: TaskId, afterSequence?: number): Promise<TaskEvent[]>;
  readTaskMessageEvents(taskIds: readonly TaskId[]): Promise<TaskEvent[]>;
  listToolResults(taskId: TaskId): Promise<ToolResult[]>;
  getToolResult(taskId: TaskId, callId: string): Promise<ToolResult | undefined>;
  getCheckpoint(checkpointId: string): Promise<Checkpoint | undefined>;
  saveTransition(input: SaveTransitionInput): Promise<SavedFollowUp | undefined>;
  listRecoverable(now: number): Promise<Task[]>;
  tryAcquireLease(input: AcquireLeaseInput): Promise<TaskLease | null>;
  releaseLease(taskId: TaskId, ownerId: string, generation: number): Promise<void>;
}

const terminalStatuses = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
const automaticallyRecoverableStatuses = new Set<TaskStatus>(['queued', 'planning']);
const submissionStores = [
  'conversations',
  'messages',
  'tasks',
  'task-runs',
  'task-events',
  'checkpoints',
  'attachments',
  'attachment-references',
  'agent-sessions',
] as const;
const transitionStores = [...submissionStores, 'tool-results'] as const;
type SubmissionTransaction = IDBPTransaction<
  ChatBrowserDatabase,
  typeof submissionStores | typeof transitionStores,
  'readwrite'
>;

async function writeTaskMessage(
  transaction: SubmissionTransaction,
  conversation: Conversation,
  message: MessageRecord,
): Promise<void> {
  for (const attachmentId of message.attachmentIds) {
    if (!(await transaction.objectStore('attachments').get(attachmentId))) {
      throw new Error('Attachment does not exist.');
    }
    await transaction.objectStore('attachment-references').put({
      attachmentId,
      referenceId: `message:${message.id}`,
    });
  }
  await transaction.objectStore('messages').add(message);
  await transaction.objectStore('conversations').put({
    ...conversation,
    updatedAt: Math.max(conversation.updatedAt, message.updatedAt),
  });
}

async function saveSessionBackup(
  transaction: SubmissionTransaction,
  conversationId: ConversationId,
  taskId: TaskId,
): Promise<void> {
  const sessions = transaction.objectStore('agent-sessions');
  const previous = replayableSession(await sessions.get(conversationId));
  if (previous) await sessions.put({ conversationId: [conversationId], taskId, session: previous });
  else await sessions.delete([conversationId]);
}

/** Creates a queued successor inside the transaction that owns the available task slot. */
async function queueFollowUp(
  transaction: SubmissionTransaction,
  conversation: Conversation,
  sourceTask: Task,
  supplements: readonly MessageRecord[],
  factory: TaskFactoryDependencies,
  forward: boolean,
  browserTabId?: number | null,
): Promise<QueuedTask> {
  const first = supplements[0];
  const tabId = browserTabId ?? sourceTask.tabId ?? conversation.tabId;
  if (!first || tabId === null) throw new Error('Follow-up conversation is unavailable.');
  const messages = supplements.map((original): MessageRecord => ({
    ...original,
    id: forward ? factory.ids.create('message') : original.id,
    kind: 'conversation',
    ...(forward ? { forwardedFromSupplementId: original.id } : {}),
  }));
  const initial = createInitialSubmission(
    {
      conversationId: conversation.id,
      tabId,
      goal: taskGoal(first.text),
      ordinal: sourceTask.ordinal + 1,
    },
    messages.map(({ id }) => id),
    factory,
  );
  for (const message of messages) {
    await writeTaskMessage(transaction, conversation, {
      ...message,
      taskId: initial.task.id,
      createdAt: initial.task.createdAt,
      updatedAt: initial.task.createdAt,
    });
  }
  await transaction.objectStore('tasks').add(initial.task);
  await transaction.objectStore('task-runs').add(initial.run);
  await transaction.objectStore('checkpoints').add(initial.checkpoint);
  for (const event of initial.events) await transaction.objectStore('task-events').add(event);
  return { taskId: initial.task.id, runId: initial.run.id };
}

function taskSequenceRange(taskId: TaskId, afterSequence = -1): IDBKeyRange {
  return IDBKeyRange.bound(
    [taskId, Math.max(0, afterSequence + 1)],
    [taskId, Number.MAX_SAFE_INTEGER],
  );
}

function taskRunRange(taskId: TaskId): IDBKeyRange {
  return IDBKeyRange.bound([taskId, 0], [taskId, Number.MAX_SAFE_INTEGER]);
}

function taskEventTypeRange(taskId: TaskId, type: TaskEvent['type']): IDBKeyRange {
  return IDBKeyRange.bound([taskId, type, 0], [taskId, type, Number.MAX_SAFE_INTEGER]);
}

function hasUnfinishedTask(tasks: readonly Task[]): boolean {
  return tasks.some((task) => !terminalStatuses.has(task.status));
}

function replayableSession(
  record: AgentSession | AgentSessionBackup | undefined,
): AgentSession | undefined {
  // A damaged compressed prefix cannot be dropped independently of the model window that uses it.
  // Returning no window lets the runtime reconstruct it from permanent messages and receipts.
  if (
    record &&
    'items' in record &&
    record.items.every(
      (item) => item.type !== 'compaction' || compactionItemSchema.safeParse(item).success,
    )
  )
    return record;
  return undefined;
}

function assertCheckpoint(task: Task, run: TaskRun, checkpoint: Checkpoint): void {
  if (
    task.latestRunId !== run.id ||
    run.taskId !== task.id ||
    run.checkpointId !== checkpoint.id ||
    checkpoint.taskId !== task.id ||
    checkpoint.runId !== run.id ||
    checkpoint.createdAt !== run.startedAt
  ) {
    throw new Error('Task, run, and checkpoint do not describe the same attempt.');
  }
}

function sameTaskIdentity(left: Task, right: Task): boolean {
  return (
    left.id === right.id &&
    left.conversationId === right.conversationId &&
    left.ordinal === right.ordinal &&
    left.goal === right.goal &&
    left.createdAt === right.createdAt
  );
}

function sameRunIdentity(left: TaskRun, right: TaskRun): boolean {
  return (
    left.id === right.id &&
    left.taskId === right.taskId &&
    left.attempt === right.attempt &&
    left.startedAt === right.startedAt
  );
}

function orderedTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(
    (left, right) =>
      left.ordinal - right.ordinal ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id),
  );
}

function orderedRuns(runs: readonly TaskRun[]): TaskRun[] {
  return [...runs].sort(
    (left, right) => left.attempt - right.attempt || left.id.localeCompare(right.id),
  );
}

function orderedTaskEventDelta(
  task: Task,
  afterSequence: number,
  events: readonly TaskEvent[],
): TaskEvent[] {
  if (
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    afterSequence > task.lastEventSequence
  ) {
    throw new Error('Task event delta boundary is invalid.');
  }
  const ordered = [...events].sort(
    (left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  if (
    ordered.length !== task.lastEventSequence - afterSequence ||
    ordered.some(
      (event, index) => event.taskId !== task.id || event.sequence !== afterSequence + index + 1,
    )
  ) {
    throw new Error('Task event delta records are inconsistent.');
  }
  return ordered;
}

function validatedRuns(task: Task, runs: readonly TaskRun[]): TaskRun[] {
  const ordered = orderedRuns(runs);
  const latest = ordered.at(-1);
  if (
    latest === undefined ||
    task.latestRunId !== latest.id ||
    task.status !== latest.status ||
    ordered.some((run, index) => run.taskId !== task.id || run.attempt !== index + 1)
  ) {
    throw new Error('Task run records are inconsistent.');
  }
  return ordered;
}

function validateEventRuns(events: readonly TaskEvent[], runs: readonly TaskRun[]): void {
  const runIds = new Set(runs.map(({ id }) => id));
  if (events.some((event) => !runIds.has(event.runId))) {
    throw new Error('Task event run association is inconsistent.');
  }
}

function materializedResults(
  events: readonly TaskEvent[],
  storedResults: readonly ToolResult[],
  selectedCallIds?: ReadonlySet<string>,
): MaterializedToolResult[] {
  const calls = new Map<string, Extract<TaskEvent, { readonly type: 'tool.call' }>>();
  const resultEvents = new Map<string, Extract<TaskEvent, { readonly type: 'tool.result' }>>();
  for (const event of events) {
    if (event.type === 'tool.call') {
      if (calls.has(event.callId)) {
        throw new Error('Task tool-result records are inconsistent.');
      }
      calls.set(event.callId, event);
    }
    if (event.type === 'tool.result') {
      if (resultEvents.has(event.callId)) {
        throw new Error('Task tool-result records are inconsistent.');
      }
      resultEvents.set(event.callId, event);
    }
  }
  const selectedEvents =
    selectedCallIds === undefined
      ? [...resultEvents.values()]
      : [...resultEvents.values()].filter(({ callId }) => selectedCallIds.has(callId));
  const storedByCall = new Map(storedResults.map((result) => [result.callId, result]));
  if (
    storedByCall.size !== storedResults.length ||
    selectedEvents.length !== storedResults.length ||
    (selectedCallIds !== undefined && selectedCallIds.size !== selectedEvents.length)
  ) {
    throw new Error('Task tool-result records are inconsistent.');
  }
  return selectedEvents.map((resultEvent): MaterializedToolResult => {
    const result = storedByCall.get(resultEvent.callId);
    const call = calls.get(resultEvent.callId);
    if (
      result === undefined ||
      call === undefined ||
      result.taskId !== resultEvent.taskId ||
      result.runId !== resultEvent.runId ||
      call.taskId !== resultEvent.taskId ||
      call.name !== result.toolName ||
      call.sequence >= resultEvent.sequence
    ) {
      throw new Error('Task tool-result records are inconsistent.');
    }
    return { ...result, argumentsJson: call.argumentsJson };
  });
}

export class IndexedDbTaskRepository implements TaskRepository {
  readonly #database: IDBPDatabase<ChatBrowserDatabase>;
  readonly #onMutation: () => void;

  constructor(database: IDBPDatabase<ChatBrowserDatabase>, onMutation: () => void = () => {}) {
    this.#database = database;
    this.#onMutation = onMutation;
  }

  async getAgentSession(conversationId: ConversationId): Promise<AgentSession | undefined> {
    return replayableSession(await this.#database.get('agent-sessions', conversationId));
  }

  /** Atomically stores a user message and starts either a new task or another run. */
  async createSubmission(input: CreateSubmissionInput): Promise<Task> {
    assertCheckpoint(input.task, input.run, input.checkpoint);
    const messageEvent = input.events.at(-2);
    const statusEvent = input.events.at(-1);
    const appliedSupplementEvents = input.events.slice(0, -2);
    if (
      input.message.kind !== 'conversation' ||
      input.message.role !== 'user' ||
      input.message.status !== 'complete' ||
      input.message.taskId !== input.task.id ||
      input.message.conversationId !== input.conversation.id ||
      input.task.conversationId !== input.conversation.id ||
      input.task.status !== input.run.status ||
      input.events.length < 2 ||
      messageEvent?.type !== 'message.recorded' ||
      messageEvent.messageId !== input.message.id ||
      statusEvent?.type !== 'status.changed' ||
      statusEvent.taskStatus !== 'queued' ||
      statusEvent.runStatus !== 'queued' ||
      input.events.some(
        (event) => event.taskId !== input.task.id || event.runId !== input.run.id,
      ) ||
      input.events.some(
        (event, index) => event.sequence !== (input.events[0]?.sequence ?? 0) + index,
      ) ||
      appliedSupplementEvents.some((event) => event.type !== 'supplement.applied') ||
      statusEvent.sequence !== input.task.lastEventSequence ||
      !input.checkpoint.continuationItems.some(
        (item) => item.type === 'message_ref' && item.messageId === input.message.id,
      ) ||
      appliedSupplementEvents.some(
        (event) =>
          event.type === 'supplement.applied' &&
          !input.checkpoint.continuationItems.some(
            (item) => item.type === 'message_ref' && item.messageId === event.messageId,
          ),
      )
    ) {
      throw new Error('Submission records do not describe the same user task boundary.');
    }

    const transaction = this.#database.transaction(submissionStores, 'readwrite');
    try {
      const storedTasks = await transaction.objectStore('tasks').getAll();
      if (hasUnfinishedTask(storedTasks)) throw new TaskRepositoryBusyError();

      let conversation = await transaction.objectStore('conversations').get(input.conversation.id);
      if (input.createConversation) {
        if (conversation !== undefined) throw new Error('Conversation already exists.');
        await transaction.objectStore('conversations').add(input.conversation);
        conversation = input.conversation;
      } else if (conversation === undefined) {
        throw new Error('Conversation does not exist.');
      }

      const existingTask = await transaction.objectStore('tasks').get(input.task.id);
      let storedTask = input.task;
      if (input.continuationSourceTaskId === undefined) {
        if (
          existingTask !== undefined ||
          input.run.attempt !== 1 ||
          appliedSupplementEvents.length !== 0 ||
          messageEvent.sequence !== 1 ||
          statusEvent.sequence !== 2
        ) {
          throw new Error('A new submission must create the first run of a new task.');
        }
        const conversationTasks = storedTasks.filter(
          (task) => task.conversationId === input.conversation.id,
        );
        storedTask = {
          ...input.task,
          ordinal: Math.max(0, ...conversationTasks.map(({ ordinal }) => ordinal)) + 1,
        };
        await saveSessionBackup(transaction, conversation.id, storedTask.id);
      } else {
        if (
          input.continuationSourceTaskId !== input.task.id ||
          existingTask === undefined ||
          !sameTaskIdentity(existingTask, input.task) ||
          (existingTask.status !== 'cancelled' && existingTask.status !== 'failed') ||
          existingTask.latestRunId === null ||
          input.run.attempt < 2
        ) {
          throw new Error('Continuation must start another run of a failed or cancelled task.');
        }
        const previousRun = await transaction
          .objectStore('task-runs')
          .get(existingTask.latestRunId);
        if (
          previousRun === undefined ||
          previousRun.status !== existingTask.status ||
          input.run.attempt !== previousRun.attempt + 1 ||
          input.events[0]?.sequence !== existingTask.lastEventSequence + 1
        ) {
          throw new Error('Continuation run does not follow the latest recoverable attempt.');
        }
        for (const event of appliedSupplementEvents) {
          if (event.type !== 'supplement.applied') continue;
          const supplement = await transaction.objectStore('messages').get(event.messageId);
          if (
            supplement === undefined ||
            supplement.kind !== 'supplement' ||
            supplement.taskId !== existingTask.id
          ) {
            throw new Error('Applied supplement does not belong to the continued task.');
          }
        }
        if (previousRun.checkpointId !== null) {
          await transaction.objectStore('checkpoints').delete(previousRun.checkpointId);
          await transaction.objectStore('task-runs').put({
            ...previousRun,
            checkpointId: null,
          });
        }
      }

      await writeTaskMessage(transaction, conversation, input.message);
      if (existingTask === undefined) await transaction.objectStore('tasks').add(storedTask);
      else await transaction.objectStore('tasks').put(storedTask);
      await transaction.objectStore('task-runs').add(input.run);
      for (const event of input.events) {
        await transaction.objectStore('task-events').add(event);
      }
      await transaction.objectStore('checkpoints').add(input.checkpoint);
      await transaction.done;
      this.#onMutation();
      return storedTask;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The underlying request may already have aborted the transaction.
      }
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  /** Atomically records one Task-owned message at its exact permanent sequence. */
  async appendTaskMessage(input: AppendSupplementInput): Promise<TaskEvent | QueuedTask>;
  async appendTaskMessage(input: AppendTaskMessageInput): Promise<TaskEvent>;
  async appendTaskMessage(
    input: AppendTaskMessageInput | AppendSupplementInput,
  ): Promise<TaskEvent | QueuedTask> {
    if (
      (input.message.kind === 'supplement'
        ? input.message.role !== 'user' || input.message.status !== 'complete'
        : input.message.role !== 'assistant' ||
          !['streaming', 'complete', 'interrupted', 'error'].includes(input.message.status)) ||
      input.eventId.trim().length === 0 ||
      !Number.isFinite(input.at)
    ) {
      throw new Error('Task message is invalid.');
    }
    const transaction = this.#database.transaction(submissionStores, 'readwrite');
    try {
      const { message } = input;
      const followUpFactory = 'followUpFactory' in input ? input.followUpFactory : undefined;
      const [storedTask, conversation] = await Promise.all([
        transaction.objectStore('tasks').get(message.taskId),
        transaction.objectStore('conversations').get(message.conversationId),
      ]);
      if (
        storedTask === undefined ||
        conversation === undefined ||
        storedTask.latestRunId === null ||
        storedTask.conversationId !== message.conversationId
      ) {
        throw new Error('Task message requires its current durable task.');
      }
      // A UI that still shows the running task may send just after its completion commit.
      if (message.kind === 'supplement' && storedTask.status === 'completed' && followUpFactory) {
        const all = await transaction.objectStore('tasks').getAll();
        const latest = orderedTasks(
          all.filter((task) => task.conversationId === message.conversationId),
        ).at(-1);
        if (!latest || hasUnfinishedTask(all)) throw new TaskRepositoryBusyError();
        const next = await queueFollowUp(
          transaction,
          conversation,
          latest,
          [message],
          followUpFactory,
          false,
          storedTask.tabId,
        );
        await saveSessionBackup(transaction, conversation.id, next.taskId);
        await transaction.done;
        this.#onMutation();
        return next;
      }
      const run = await transaction.objectStore('task-runs').get(storedTask.latestRunId);
      if (
        run === undefined ||
        (input.message.kind === 'supplement' && !['queued', 'planning'].includes(run.status))
      ) {
        throw new Error('Task message requires its current task attempt.');
      }
      await writeTaskMessage(transaction, conversation, message);
      const event: TaskEvent =
        input.message.kind === 'supplement'
          ? {
              id: input.eventId,
              taskId: storedTask.id,
              runId: run.id,
              sequence: storedTask.lastEventSequence + 1,
              at: input.at,
              type: 'supplement.queued',
              messageId: input.message.id,
            }
          : {
              id: input.eventId,
              taskId: storedTask.id,
              runId: run.id,
              sequence: storedTask.lastEventSequence + 1,
              at: input.at,
              type: 'message.recorded',
              messageId: input.message.id,
            };
      await transaction.objectStore('task-events').add(event);
      await transaction.objectStore('tasks').put({
        ...storedTask,
        lastEventSequence: event.sequence,
        updatedAt: Math.max(storedTask.updatedAt, input.message.updatedAt, input.at),
      });
      await transaction.done;
      this.#onMutation();
      return event;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The underlying request may already have aborted the transaction.
      }
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  /** Starts another attempt without creating a new conversation message. */
  async startRun(
    task: Task,
    run: TaskRun,
    event: TaskEvent,
    checkpoint: Checkpoint,
  ): Promise<void> {
    assertCheckpoint(task, run, checkpoint);
    if (
      event.type !== 'status.changed' ||
      event.taskId !== task.id ||
      event.runId !== run.id ||
      event.sequence !== task.lastEventSequence ||
      event.taskStatus !== 'queued' ||
      event.runStatus !== 'queued'
    ) {
      throw new Error('Run start records do not describe the same queued boundary.');
    }
    const transaction = this.#database.transaction(
      ['tasks', 'task-runs', 'task-events', 'checkpoints'],
      'readwrite',
    );
    const taskStore = transaction.objectStore('tasks');
    const [existingTask, storedTasks] = await Promise.all([
      taskStore.get(task.id),
      taskStore.getAll(),
    ]);
    if (
      storedTasks.some(
        (storedTask) => storedTask.id !== task.id && !terminalStatuses.has(storedTask.status),
      )
    ) {
      transaction.abort();
      await transaction.done.catch(() => undefined);
      throw new TaskRepositoryBusyError();
    }
    if (
      existingTask === undefined ||
      existingTask.latestRunId === null ||
      !sameTaskIdentity(existingTask, task) ||
      task.status !== run.status ||
      !['paused', 'waiting_for_auth', 'failed', 'cancelled'].includes(existingTask.status) ||
      task.lastEventSequence !== existingTask.lastEventSequence + 1
    ) {
      transaction.abort();
      await transaction.done.catch(() => undefined);
      throw new Error('Only a resumable terminal attempt can start another run.');
    }
    const previousRun = await transaction.objectStore('task-runs').get(existingTask.latestRunId);
    if (previousRun === undefined || run.attempt !== previousRun.attempt + 1) {
      transaction.abort();
      await transaction.done.catch(() => undefined);
      throw new Error('New run attempt does not follow the current run.');
    }
    if (previousRun.checkpointId !== null) {
      await transaction.objectStore('checkpoints').delete(previousRun.checkpointId);
      await transaction.objectStore('task-runs').put({ ...previousRun, checkpointId: null });
    }
    await transaction.objectStore('tasks').put(task);
    await transaction.objectStore('task-runs').add(run);
    await transaction.objectStore('task-events').add(event);
    await transaction.objectStore('checkpoints').add(checkpoint);
    await transaction.done;
    this.#onMutation();
  }

  async get(taskId: TaskId): Promise<Task | undefined> {
    return this.#database.get('tasks', taskId);
  }

  async getRun(runId: TaskRunId): Promise<TaskRun | undefined> {
    return this.#database.get('task-runs', runId);
  }

  /** Batch-loads the latest run, its recovery state, events, and immutable results. */
  async readActiveRuntimeSnapshot(taskId: TaskId): Promise<ActiveTaskRuntimeSnapshot | undefined> {
    const transaction = this.#database.transaction(
      ['tasks', 'task-runs', 'task-events', 'tool-results', 'checkpoints'],
      'readonly',
    );
    const task = await transaction.objectStore('tasks').get(taskId);
    if (task === undefined || task.latestRunId === null) {
      await transaction.done;
      return undefined;
    }
    const [run, storedEvents, results] = await Promise.all([
      transaction.objectStore('task-runs').get(task.latestRunId),
      transaction
        .objectStore('task-events')
        .index('by-task-sequence')
        .getAll(taskSequenceRange(taskId)),
      transaction.objectStore('tool-results').index('by-task').getAll(taskId),
    ]);
    if (run === undefined) {
      await transaction.done;
      throw new Error('Task latest run is missing.');
    }
    if (run.taskId !== task.id || run.id !== task.latestRunId || run.status !== task.status) {
      await transaction.done;
      throw new Error('Task latest run is inconsistent.');
    }
    const events = orderedTaskEvents(task, storedEvents);
    const checkpoint =
      run.checkpointId === null
        ? undefined
        : await transaction.objectStore('checkpoints').get(run.checkpointId);
    await transaction.done;
    return {
      task,
      run,
      checkpoint,
      events,
      toolResults: materializedResults(events, results),
    };
  }

  /** Loads current attempt metadata and only events newer than the caller's snapshot. */
  async readActiveRuntimeDelta(
    taskId: TaskId,
    afterSequence: number,
  ): Promise<ActiveTaskRuntimeDelta | undefined> {
    const transaction = this.#database.transaction(
      ['tasks', 'task-runs', 'task-events', 'checkpoints'],
      'readonly',
    );
    const task = await transaction.objectStore('tasks').get(taskId);
    if (task === undefined || task.latestRunId === null) {
      await transaction.done;
      return undefined;
    }
    const [run, storedEvents] = await Promise.all([
      transaction.objectStore('task-runs').get(task.latestRunId),
      transaction
        .objectStore('task-events')
        .index('by-task-sequence')
        .getAll(taskSequenceRange(taskId, afterSequence)),
    ]);
    if (
      run === undefined ||
      run.taskId !== task.id ||
      run.id !== task.latestRunId ||
      run.status !== task.status
    ) {
      await transaction.done;
      throw new Error('Task latest run is inconsistent.');
    }
    const checkpoint =
      run.checkpointId === null
        ? undefined
        : await transaction.objectStore('checkpoints').get(run.checkpointId);
    const events = orderedTaskEventDelta(task, afterSequence, storedEvents);
    await transaction.done;
    return { task, run, checkpoint, events };
  }

  /** Batch-loads task timelines without reading any tool-result output bodies. */
  async readTaskTimelines(taskIds: readonly TaskId[]): Promise<PersistedTaskTimeline[]> {
    const uniqueTaskIds = [...new Set(taskIds)];
    if (uniqueTaskIds.length === 0) return [];
    const transaction = this.#database.transaction(
      ['tasks', 'task-runs', 'task-events'],
      'readonly',
    );
    const timelines = await Promise.all(
      uniqueTaskIds.map(async (taskId): Promise<PersistedTaskTimeline | undefined> => {
        const task = await transaction.objectStore('tasks').get(taskId);
        if (task === undefined) return undefined;
        const [storedRuns, storedEvents] = await Promise.all([
          transaction
            .objectStore('task-runs')
            .index('by-task-attempt')
            .getAll(taskRunRange(taskId)),
          transaction
            .objectStore('task-events')
            .index('by-task-sequence')
            .getAll(taskSequenceRange(taskId)),
        ]);
        const runs = validatedRuns(task, storedRuns);
        const events = orderedTaskEvents(task, storedEvents);
        validateEventRuns(events, runs);
        return { task, runs, events };
      }),
    );
    await transaction.done;
    return timelines.flatMap((timeline) => (timeline === undefined ? [] : [timeline]));
  }

  /** Loads only result bodies referenced by the newest visible task-detail events. */
  async readTaskDetailWindow(
    taskId: TaskId,
    maxDetailEvents: number,
  ): Promise<PersistedTaskDetailWindow | undefined> {
    if (!Number.isSafeInteger(maxDetailEvents) || maxDetailEvents < 1) {
      throw new Error('Task detail window limit is invalid.');
    }
    const transaction = this.#database.transaction(
      ['tasks', 'task-runs', 'task-events', 'tool-results'],
      'readonly',
    );
    const task = await transaction.objectStore('tasks').get(taskId);
    if (task === undefined) {
      await transaction.done;
      return undefined;
    }
    const [storedRuns, storedEvents] = await Promise.all([
      transaction.objectStore('task-runs').index('by-task-attempt').getAll(taskRunRange(taskId)),
      transaction
        .objectStore('task-events')
        .index('by-task-sequence')
        .getAll(taskSequenceRange(taskId)),
    ]);
    const runs = validatedRuns(task, storedRuns);
    const events = orderedTaskEvents(task, storedEvents);
    validateEventRuns(events, runs);
    const selectedCallIds = new Set(
      events
        .filter((event) => event.type === 'tool.result' || event.type === 'supplement.queued')
        .slice(-maxDetailEvents)
        .flatMap((event) => (event.type === 'tool.result' ? [event.callId] : [])),
    );
    const results = await Promise.all(
      [...selectedCallIds].map((callId) =>
        transaction.objectStore('tool-results').get([taskId, callId]),
      ),
    );
    if (results.some((result) => result === undefined)) {
      await transaction.done;
      throw new Error('Task tool-result records are inconsistent.');
    }
    await transaction.done;
    return {
      task,
      runs,
      events,
      toolResults: materializedResults(
        events,
        results.flatMap((result) => (result === undefined ? [] : [result])),
        selectedCallIds,
      ),
    };
  }

  async listByConversation(conversationId: ConversationId): Promise<Task[]> {
    return orderedTasks(
      await this.#database.getAllFromIndex('tasks', 'by-conversation', conversationId),
    );
  }

  async listAll(): Promise<Task[]> {
    return [...(await this.#database.getAll('tasks'))].sort(
      (left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id),
    );
  }

  async listRuns(taskId: TaskId): Promise<TaskRun[]> {
    return orderedRuns(
      await this.#database.getAllFromIndex('task-runs', 'by-task-attempt', taskRunRange(taskId)),
    );
  }

  async listEvents(taskId: TaskId, afterSequence = -1): Promise<TaskEvent[]> {
    return this.#database.getAllFromIndex(
      'task-events',
      'by-task-sequence',
      taskSequenceRange(taskId, afterSequence),
    );
  }

  /** Batch-loads only message-order events needed by bounded conversation history. */
  async readTaskMessageEvents(taskIds: readonly TaskId[]): Promise<TaskEvent[]> {
    const uniqueTaskIds = [...new Set(taskIds)];
    if (uniqueTaskIds.length === 0) return [];
    const transaction = this.#database.transaction('task-events', 'readonly');
    const eventGroups = await Promise.all(
      uniqueTaskIds.map((taskId) =>
        transaction
          .objectStore('task-events')
          .index('by-task-type-sequence')
          .getAll(taskEventTypeRange(taskId, 'message.recorded')),
      ),
    );
    await transaction.done;
    return eventGroups.flat();
  }

  async listToolResults(taskId: TaskId): Promise<ToolResult[]> {
    return (await this.#database.getAllFromIndex('tool-results', 'by-task', taskId)).sort(
      (left, right) => left.createdAt - right.createdAt || left.callId.localeCompare(right.callId),
    );
  }

  async getToolResult(taskId: TaskId, callId: string): Promise<ToolResult | undefined> {
    return this.#database.get('tool-results', [taskId, callId]);
  }

  async getCheckpoint(checkpointId: string): Promise<Checkpoint | undefined> {
    return this.#database.get('checkpoints', checkpointId);
  }

  /** Commits the task boundary and any follow-up together. */
  async saveTransition(input: SaveTransitionInput): Promise<SavedFollowUp | undefined> {
    if (
      input.session &&
      (input.session.conversationId !== input.task.conversationId ||
        input.session.taskId !== input.task.id)
    ) {
      throw new Error('Model session does not belong to the task boundary.');
    }
    const firstEvent = input.events[0];
    const lastEvent = input.events.at(-1);
    if (
      firstEvent === undefined ||
      lastEvent === undefined ||
      input.task.latestRunId !== input.run.id ||
      input.run.taskId !== input.task.id ||
      input.task.status !== input.run.status ||
      input.events.some(
        (event) => event.taskId !== input.task.id || event.runId !== input.run.id,
      ) ||
      lastEvent.sequence !== input.task.lastEventSequence ||
      (input.checkpoint !== null &&
        (input.checkpoint.taskId !== input.task.id || input.checkpoint.runId !== input.run.id)) ||
      (input.deleteCheckpoint === true
        ? input.run.checkpointId !== null
        : input.checkpoint === null
          ? input.run.checkpointId !== null
          : input.run.checkpointId !== input.checkpoint.id)
    ) {
      throw new Error('Task transition records do not describe the same durable boundary.');
    }

    const transaction = this.#database.transaction(transitionStores, 'readwrite');
    try {
      const [existingTask, existingRun] = await Promise.all([
        transaction.objectStore('tasks').get(input.task.id),
        transaction.objectStore('task-runs').get(input.run.id),
      ]);
      if (existingTask === undefined || existingRun === undefined) {
        throw new Error('Task transition target does not exist.');
      }
      if (
        existingTask.latestRunId !== existingRun.id ||
        !sameTaskIdentity(existingTask, input.task) ||
        !sameRunIdentity(existingRun, input.run)
      ) {
        throw new Error(`Task event sequence must be ${existingTask.lastEventSequence + 1}.`);
      }
      if (
        firstEvent.sequence !== existingTask.lastEventSequence + 1 ||
        input.events.some((event, index) => event.sequence !== firstEvent.sequence + index)
      ) {
        throw new TaskRepositoryConflictError('STALE_BOUNDARY');
      }
      if (input.checkpoint !== null && existingRun.checkpointId !== input.checkpoint.id) {
        throw new Error('A run cannot replace its durable checkpoint identity.');
      }

      const completionEvent = input.events.find(
        (event): event is Extract<TaskEvent, { readonly type: 'status.changed' }> =>
          event.type === 'status.changed' && event.taskStatus === 'completed',
      );
      if (completionEvent !== undefined && input.checkpoint?.pendingToolCall !== null) {
        throw new Error('A completed task must have a resolved final continuation.');
      }

      const newResultEvents = input.events.filter(
        (event): event is Extract<TaskEvent, { readonly type: 'tool.result' }> =>
          event.type === 'tool.result',
      );
      const newResults = input.toolResults ?? [];
      const existingEvents =
        completionEvent === undefined
          ? []
          : await transaction
              .objectStore('task-events')
              .index('by-task-sequence')
              .getAll(taskSequenceRange(input.task.id));
      const pendingIds = completionEvent
        ? [...pendingTaskSupplementIds([...existingEvents, ...input.events], input.task.id)]
        : [];
      if (pendingIds.length && !input.followUpFactory) throw new TaskRepositoryConflictError();

      let followUp: QueuedTask | undefined;
      const forwardedEvents: TaskEvent[] = [];
      if (pendingIds.length && input.followUpFactory) {
        const factory = input.followUpFactory;
        const conversation = await transaction
          .objectStore('conversations')
          .get(input.task.conversationId);
        const messages = transaction.objectStore('messages');
        const originals = await Promise.all(pendingIds.map((messageId) => messages.get(messageId)));
        if (!conversation) throw new Error('Follow-up conversation is unavailable.');
        const supplements = originals.map((original) => {
          if (!original || original.kind !== 'supplement' || original.taskId !== input.task.id) {
            throw new Error('Forwarded supplement does not belong to the completed task.');
          }
          return original;
        });
        followUp = await queueFollowUp(
          transaction,
          conversation,
          input.task,
          supplements,
          factory,
          true,
          input.checkpoint?.browserTargetTabId,
        );
        for (const [index, original] of supplements.entries()) {
          forwardedEvents.push({
            id: factory.ids.create('event'),
            type: 'supplement.forwarded',
            messageId: original.id,
            nextTaskId: followUp.taskId,
            taskId: input.task.id,
            runId: input.run.id,
            sequence: input.task.lastEventSequence + index + 1,
            at: input.task.updatedAt,
          });
        }
      }

      if (
        newResultEvents.length !== newResults.length ||
        newResultEvents.some(
          (event) => !newResults.some((result) => result.callId === event.callId),
        )
      ) {
        throw new Error('Tool result events and canonical results must be committed together.');
      }
      const transitionCalls = new Map(
        input.events.flatMap((event) =>
          event.type === 'tool.call' ? [[event.callId, event] as const] : [],
        ),
      );
      const existingCheckpoint =
        newResults.length === 0 || existingRun.checkpointId === null
          ? undefined
          : await transaction.objectStore('checkpoints').get(existingRun.checkpointId);
      for (const result of newResults) {
        if (result.taskId !== input.task.id || result.runId !== input.run.id) {
          throw new Error('Tool result does not belong to the transition run.');
        }
        const transitionCall = transitionCalls.get(result.callId);
        const pendingCall = existingCheckpoint?.pendingToolCall;
        const resultEvent = newResultEvents.find((event) => event.callId === result.callId);
        if (
          resultEvent === undefined ||
          (transitionCall === undefined &&
            (pendingCall === null ||
              pendingCall === undefined ||
              pendingCall.callId !== result.callId ||
              pendingCall.name !== result.toolName)) ||
          (transitionCall !== undefined &&
            (transitionCall.taskId !== result.taskId ||
              transitionCall.name !== result.toolName ||
              transitionCall.sequence >= resultEvent.sequence))
        ) {
          throw new Error('Tool result does not reference its recorded tool call.');
        }
        const toolCallKey: ToolCallKey = [result.taskId, result.callId];
        for (const attachmentId of result.attachmentIds) {
          if ((await transaction.objectStore('attachments').get(attachmentId)) === undefined) {
            throw new Error('Tool result attachment does not exist.');
          }
          await transaction.objectStore('attachment-references').put({
            attachmentId,
            referenceId: toolCallKey,
          });
        }
        await transaction.objectStore('tool-results').add(result);
      }
      await transaction.objectStore('tasks').put({
        ...input.task,
        lastEventSequence: input.task.lastEventSequence + forwardedEvents.length,
      });
      await transaction.objectStore('task-runs').put(input.run);
      const sessions = transaction.objectStore('agent-sessions');
      const conversationId = input.task.conversationId;
      if (input.events.some((event) => event.type === 'context.cleared')) {
        const [current, backup] = await Promise.all([
          sessions.get(conversationId),
          sessions.get([conversationId]),
        ]);
        const ownBackup = backup?.taskId === input.task.id && 'session' in backup ? backup : null;
        if (current?.taskId === input.task.id) {
          const previous = ownBackup?.session;
          const previousWasCleared =
            previous !== undefined &&
            (await transaction
              .objectStore('task-events')
              .index('by-task-type-sequence')
              .getKey(taskEventTypeRange(previous.taskId, 'context.cleared'))) !== undefined;
          if (previous && !previousWasCleared) await sessions.put(previous);
          else await sessions.delete(conversationId);
        }
        if (ownBackup) await sessions.delete([conversationId]);
      } else if (input.session) {
        await sessions.put(input.session);
      }
      if (followUp) {
        await saveSessionBackup(transaction, conversationId, followUp.taskId);
      } else if (completionEvent) {
        await sessions.delete([conversationId]);
      }
      for (const event of [...input.events, ...forwardedEvents]) {
        await transaction.objectStore('task-events').add(event);
      }
      if (input.checkpoint === null || input.deleteCheckpoint === true) {
        if (existingRun.checkpointId !== null) {
          await transaction.objectStore('checkpoints').delete(existingRun.checkpointId);
        }
      } else {
        await transaction.objectStore('checkpoints').put(input.checkpoint);
      }
      await transaction.done;
      this.#onMutation();
      return followUp ? { nextTask: followUp, sourceEvents: forwardedEvents } : undefined;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The underlying request may already have aborted the transaction.
      }
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  /** Lists recoverable logical tasks whose latest run has no live lease. */
  async listRecoverable(now: number): Promise<Task[]> {
    const transaction = this.#database.transaction(['tasks', 'task-runs'], 'readonly');
    const tasks = await transaction.objectStore('tasks').getAll();
    const candidates: Task[] = [];
    for (const task of tasks) {
      if (!automaticallyRecoverableStatuses.has(task.status) || task.latestRunId === null) continue;
      const run = await transaction.objectStore('task-runs').get(task.latestRunId);
      if (run !== undefined && (run.lease === null || run.lease.expiresAt <= now)) {
        candidates.push(task);
      }
    }
    await transaction.done;
    return candidates.sort(
      (left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id),
    );
  }

  /** Acquires the lease on the latest run, using its generation as a fencing token. */
  async tryAcquireLease(input: AcquireLeaseInput): Promise<TaskLease | null> {
    if (
      input.ownerId.trim().length === 0 ||
      !Number.isFinite(input.now) ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs <= 0
    ) {
      throw new Error('Lease acquisition input is invalid.');
    }
    const transaction = this.#database.transaction(['tasks', 'task-runs'], 'readwrite');
    const task = await transaction.objectStore('tasks').get(input.taskId);
    if (task?.latestRunId === null || task === undefined) {
      throw new Error('Task or latest run does not exist.');
    }
    const run = await transaction.objectStore('task-runs').get(task.latestRunId);
    if (run === undefined) throw new Error('Task latest run does not exist.');
    if (run.lease !== null && run.lease.expiresAt > input.now) {
      if (run.lease.ownerId !== input.ownerId) {
        await transaction.done;
        return null;
      }
      const renewed: TaskLease = {
        ...run.lease,
        expiresAt: input.now + input.durationMs,
      };
      await transaction.objectStore('task-runs').put({ ...run, lease: renewed });
      await transaction.done;
      return renewed;
    }
    const lease: TaskLease = {
      ownerId: input.ownerId,
      acquiredAt: input.now,
      expiresAt: input.now + input.durationMs,
      generation: (run.lease?.generation ?? 0) + 1,
    };
    await transaction.objectStore('task-runs').put({ ...run, lease });
    await transaction.done;
    return lease;
  }

  async releaseLease(taskId: TaskId, ownerId: string, generation: number): Promise<void> {
    const transaction = this.#database.transaction(['tasks', 'task-runs'], 'readwrite');
    const task = await transaction.objectStore('tasks').get(taskId);
    if (task?.latestRunId !== null && task !== undefined) {
      const run = await transaction.objectStore('task-runs').get(task.latestRunId);
      if (
        run !== undefined &&
        run.lease?.ownerId === ownerId &&
        run.lease.generation === generation
      ) {
        await transaction.objectStore('task-runs').put({ ...run, lease: null });
      }
    }
    await transaction.done;
  }
}
