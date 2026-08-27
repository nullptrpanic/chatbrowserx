import type { TaskRepository } from '../persistence/task-repository';
import type { ConversationId, TaskId } from '../shared/ids';
import type { CompletedToolResult } from './checkpoint-types';
import type { TaskRun, TaskStatus } from './task-types';

export type HistoricalToolResultScope = 'previous_task' | 'current_conversation' | 'task_id';
export type HistoricalToolResultContentState = 'complete' | 'truncated' | 'metadata_only';

export interface HistoricalToolResultContext {
  readonly conversationId: ConversationId;
  readonly currentTaskId: TaskId;
}

export interface HistoricalToolResultSearchInput {
  readonly scope: HistoricalToolResultScope;
  readonly taskId: string | null;
  readonly query: string;
  readonly toolName: string | null;
  readonly limit: number;
}

export interface HistoricalToolResultReadInput {
  readonly evidenceId: string;
  readonly offset: number;
  readonly limit: number;
}

export interface HistoricalToolResultSearchItem {
  readonly evidenceId: string;
  readonly taskId: TaskId;
  readonly taskStatus: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>;
  readonly toolName: string;
  readonly summary: string;
  readonly summaryKind: 'derived';
  readonly outputLength: number;
  readonly contentState: HistoricalToolResultContentState;
  readonly recordedAt: number;
}

interface HistoricalToolResultError {
  readonly ok: false;
  readonly code: 'TASK_NOT_FOUND' | 'EVIDENCE_NOT_FOUND';
  readonly message: string;
  readonly retryable: false;
}

export type HistoricalToolResultSearchResponse =
  | {
      readonly ok: true;
      readonly results: readonly HistoricalToolResultSearchItem[];
    }
  | HistoricalToolResultError;

export type HistoricalToolResultReadResponse =
  | {
      readonly ok: true;
      readonly evidenceId: string;
      readonly taskId: TaskId;
      readonly taskStatus: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>;
      readonly toolName: string;
      readonly content: string;
      readonly offset: number;
      readonly returnedLength: number;
      readonly totalLength: number;
      readonly hasMore: boolean;
      readonly contentState: HistoricalToolResultContentState;
      readonly contentSource: 'stored_tool_output';
    }
  | HistoricalToolResultError;

export interface HistoricalToolResultPort {
  hasEvidence(context: HistoricalToolResultContext): Promise<boolean>;
  search(
    context: HistoricalToolResultContext,
    input: HistoricalToolResultSearchInput,
  ): Promise<HistoricalToolResultSearchResponse>;
  read(
    context: HistoricalToolResultContext,
    input: HistoricalToolResultReadInput,
  ): Promise<HistoricalToolResultReadResponse>;
}

interface TaskEvidence {
  readonly task: TaskRun & {
    readonly status: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>;
  };
  readonly results: readonly CompletedToolResult[];
}

interface IndexedEvidence {
  readonly evidenceId: string;
  readonly task: TaskEvidence['task'];
  readonly result: CompletedToolResult;
  readonly resultIndex: number;
  readonly contentState: HistoricalToolResultContentState;
}

interface CachedConversationEvidence {
  readonly signature: string;
  readonly tasks: readonly TaskEvidence[];
}

const terminalStatuses = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
const excludedToolNames = new Set(['commit_context', 'task_result_search', 'task_result_read']);
const MAX_CACHED_CONVERSATIONS = 8;
const SUMMARY_CHARACTERS = 240;

function isTerminalTask(task: TaskRun): task is TaskEvidence['task'] {
  return terminalStatuses.has(task.status);
}

function taskSignature(tasks: readonly TaskEvidence['task'][]): string {
  return tasks
    .map(
      (task) =>
        `${task.id}\u0000${task.status}\u0000${task.updatedAt}\u0000${task.checkpointId ?? ''}`,
    )
    .join('\u0001');
}

function contentState(result: CompletedToolResult): HistoricalToolResultContentState {
  if (result.toolName === 'browser_network_list') return 'metadata_only';
  try {
    const value: unknown = JSON.parse(result.output);
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'truncated' in value &&
      value.truncated === true
    ) {
      return 'truncated';
    }
  } catch {
    if (/\btruncated\b/i.test(result.output)) return 'truncated';
  }
  return 'complete';
}

function derivedSummary(output: string): string {
  const normalized = output.replace(/\s+/g, ' ').trim();
  return normalized.length <= SUMMARY_CHARACTERS
    ? normalized
    : `${normalized.slice(0, SUMMARY_CHARACTERS - 1)}…`;
}

function evidenceForTasks(tasks: readonly TaskEvidence[]): readonly IndexedEvidence[] {
  const firstOccurrence = new Map<string, IndexedEvidence>();
  const orderedTasks = [...tasks].sort(
    (left, right) =>
      left.task.updatedAt - right.task.updatedAt || left.task.id.localeCompare(right.task.id),
  );
  for (const task of orderedTasks) {
    task.results.forEach((result, resultIndex) => {
      if (excludedToolNames.has(result.toolName)) return;
      const key = `${task.task.workSessionId}\u0000${result.resultRef}`;
      if (firstOccurrence.has(key)) return;
      firstOccurrence.set(key, {
        evidenceId: result.resultRef,
        task: task.task,
        result,
        resultIndex,
        contentState: contentState(result),
      });
    });
  }
  return [...firstOccurrence.values()].sort(
    (left, right) =>
      right.task.updatedAt - left.task.updatedAt ||
      right.resultIndex - left.resultIndex ||
      left.evidenceId.localeCompare(right.evidenceId),
  );
}

function taskNotFound(): HistoricalToolResultError {
  return {
    ok: false,
    code: 'TASK_NOT_FOUND',
    message: 'The requested historical task is unavailable in this conversation.',
    retryable: false,
  };
}

function evidenceNotFound(): HistoricalToolResultError {
  return {
    ok: false,
    code: 'EVIDENCE_NOT_FOUND',
    message: 'The requested historical tool evidence is unavailable in this conversation.',
    retryable: false,
  };
}

/** Derives a bounded searchable view over the existing terminal checkpoints without copying output. */
export class HistoricalToolResultService implements HistoricalToolResultPort {
  readonly #repository: Pick<TaskRepository, 'listByConversation' | 'getCheckpoint'>;
  readonly #cache = new Map<ConversationId, CachedConversationEvidence>();

  constructor(repository: Pick<TaskRepository, 'listByConversation' | 'getCheckpoint'>) {
    this.#repository = repository;
  }

  async hasEvidence(context: HistoricalToolResultContext): Promise<boolean> {
    const tasks = await this.#load(context.conversationId);
    return evidenceForTasks(tasks).length > 0;
  }

  async search(
    context: HistoricalToolResultContext,
    input: HistoricalToolResultSearchInput,
  ): Promise<HistoricalToolResultSearchResponse> {
    const allTasks = await this.#load(context.conversationId);
    let selected: readonly TaskEvidence[];
    if (input.scope === 'task_id') {
      const exact = allTasks.find(({ task }) => task.id === input.taskId);
      if (exact === undefined) return taskNotFound();
      selected = [exact];
    } else if (input.scope === 'previous_task') {
      const latest = [...allTasks]
        .filter(({ task }) => task.id !== context.currentTaskId)
        .sort(
          (left, right) =>
            right.task.updatedAt - left.task.updatedAt || right.task.id.localeCompare(left.task.id),
        )[0];
      selected =
        latest === undefined
          ? []
          : allTasks.filter(({ task }) => task.workSessionId === latest.task.workSessionId);
    } else {
      selected = allTasks;
    }

    const terms = input.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const results = evidenceForTasks(selected)
      .filter(({ result }) => input.toolName === null || result.toolName === input.toolName)
      .filter(({ result }) => {
        if (terms.length === 0) return true;
        const searchable =
          `${result.toolName}\n${result.argumentsJson}\n${result.output}`.toLocaleLowerCase();
        return terms.every((term) => searchable.includes(term));
      })
      .slice(0, input.limit)
      .map(({ evidenceId, task, result, contentState: state }) => ({
        evidenceId,
        taskId: task.id,
        taskStatus: task.status,
        toolName: result.toolName,
        summary: derivedSummary(result.output),
        summaryKind: 'derived' as const,
        outputLength: result.output.length,
        contentState: state,
        recordedAt: task.updatedAt,
      }));
    return { ok: true, results };
  }

  async read(
    context: HistoricalToolResultContext,
    input: HistoricalToolResultReadInput,
  ): Promise<HistoricalToolResultReadResponse> {
    const tasks = await this.#load(context.conversationId);
    const evidence = evidenceForTasks(tasks).find(
      ({ evidenceId }) => evidenceId === input.evidenceId,
    );
    if (evidence === undefined) return evidenceNotFound();

    const content = evidence.result.output.slice(input.offset, input.offset + input.limit);
    return {
      ok: true,
      evidenceId: evidence.evidenceId,
      taskId: evidence.task.id,
      taskStatus: evidence.task.status,
      toolName: evidence.result.toolName,
      content,
      offset: input.offset,
      returnedLength: content.length,
      totalLength: evidence.result.output.length,
      hasMore: input.offset + content.length < evidence.result.output.length,
      contentState: evidence.contentState,
      contentSource: 'stored_tool_output',
    };
  }

  async #load(conversationId: ConversationId): Promise<readonly TaskEvidence[]> {
    const terminalTasks = (await this.#repository.listByConversation(conversationId)).filter(
      isTerminalTask,
    );
    const signature = taskSignature(terminalTasks);
    const cached = this.#cache.get(conversationId);
    if (cached?.signature === signature) return cached.tasks;

    const tasks = (
      await Promise.all(
        terminalTasks.map(async (task): Promise<TaskEvidence | null> => {
          if (task.checkpointId === null) return null;
          const checkpoint = await this.#repository.getCheckpoint(task.checkpointId);
          if (checkpoint === undefined || checkpoint.taskId !== task.id) return null;
          return { task, results: checkpoint.completedToolResults };
        }),
      )
    ).filter((value): value is TaskEvidence => value !== null);
    this.#cache.delete(conversationId);
    this.#cache.set(conversationId, { signature, tasks });
    while (this.#cache.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return tasks;
  }
}
