import { z } from 'zod';
import { providerErrorFromCode } from '../provider-errors';
import type { DecodedSseEvent } from '../sse-decoder';
import type { ModelStreamEvent, ModelUsage } from '../stream-events';
import { fromCodexToolName } from './codex-tool-name';

const objectSchema = z.object({ type: z.string().optional() }).passthrough();
const responseSchema = z.object({ id: z.string().min(1) }).passthrough();
const createdSchema = objectSchema.extend({ response: responseSchema });
const textDeltaSchema = objectSchema.extend({
  item_id: z.string().min(1).optional(),
  output_index: z.number().int().nonnegative().optional(),
  content_index: z.number().int().nonnegative().optional(),
  delta: z.string(),
});
const textDoneSchema = objectSchema.extend({
  item_id: z.string().min(1),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  text: z.string(),
});
const refusalDeltaSchema = objectSchema.extend({
  item_id: z.string().min(1),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  delta: z.string(),
});
const refusalDoneSchema = objectSchema.extend({
  item_id: z.string().min(1),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  refusal: z.string(),
});
const contentPartDoneSchema = objectSchema.extend({
  item_id: z.string().min(1),
  output_index: z.number().int().nonnegative(),
  content_index: z.number().int().nonnegative(),
  part: z.object({ type: z.string() }).passthrough(),
});
const outputTextPartSchema = z
  .object({ type: z.literal('output_text'), text: z.string() })
  .passthrough();
const refusalPartSchema = z
  .object({ type: z.literal('refusal'), refusal: z.string() })
  .passthrough();
const reasoningSummaryDoneSchema = objectSchema.extend({
  item_id: z.string().min(1),
  summary_index: z.number().int().nonnegative(),
  text: z.string(),
});
const functionCallItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal('function_call'),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
  })
  .passthrough();
const reasoningItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal('reasoning'),
    encrypted_content: z.string().min(1),
    summary: z.array(
      z
        .object({
          type: z.literal('summary_text'),
          text: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const outputItemSchema = objectSchema.extend({
  item: z.object({ type: z.string() }).passthrough(),
});
const messageOutputDoneSchema = objectSchema.extend({
  output_index: z.number().int().nonnegative(),
  item: z
    .object({
      id: z.string().min(1),
      type: z.literal('message'),
      content: z.array(z.object({ type: z.string() }).passthrough()),
    })
    .passthrough(),
});
const argumentDeltaSchema = objectSchema.extend({
  item_id: z.string().min(1),
  delta: z.string(),
});
const argumentDoneSchema = objectSchema.extend({
  item_id: z.string().min(1),
  arguments: z.string(),
});
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  input_tokens_details: z
    .object({
      cached_tokens: z.number().int().nonnegative().optional(),
      cache_write_tokens: z.number().int().nonnegative().optional(),
    })
    .passthrough()
    .nullish(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.number().int().nonnegative().optional() })
    .passthrough()
    .nullish(),
});
const completedSchema = objectSchema.extend({
  response: responseSchema.extend({ usage: usageSchema.nullish() }),
});
const incompleteSchema = objectSchema.extend({ response: responseSchema });
const failedSchema = objectSchema.extend({
  response: responseSchema.extend({
    error: z.object({ code: z.string().nullish() }).passthrough().nullish(),
  }),
});
const errorSchema = objectSchema.extend({ code: z.string().nullish() });

const ACTIVE_RESPONSE_EVENT_TYPES = new Set([
  'response.output_text.delta',
  'response.output_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.content_part.done',
  'response.reasoning_summary_text.done',
  'response.output_item.added',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.output_item.done',
]);
const SUPPORTED_EVENT_TYPES = new Set([
  ...ACTIVE_RESPONSE_EVENT_TYPES,
  'response.created',
  'response.completed',
  'response.incomplete',
  'response.failed',
  'error',
]);

interface FunctionCallState {
  readonly callId: string;
  readonly name: string;
  completed: boolean;
  argumentsJson: string | null;
}

interface ContentTextState {
  readonly text: string;
  readonly completed: boolean;
}

type ContentPartKind = 'output_text' | 'refusal';

function contentPartKey(input: {
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
}): string {
  return `${input.item_id}:${String(input.output_index)}:${String(input.content_index)}`;
}

function optionalContentPartIdentity(input: {
  readonly item_id?: string | undefined;
  readonly output_index?: number | undefined;
  readonly content_index?: number | undefined;
}): {
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
} | null {
  if (
    input.item_id === undefined &&
    input.output_index === undefined &&
    input.content_index === undefined
  ) {
    return null;
  }
  if (
    input.item_id === undefined ||
    input.output_index === undefined ||
    input.content_index === undefined
  ) {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
  return {
    item_id: input.item_id,
    output_index: input.output_index,
    content_index: input.content_index,
  };
}

/** Converts an upstream error code to the stable public taxonomy. */
function throwUpstreamError(code: string | null | undefined): never {
  const normalized = code?.toLowerCase() ?? '';
  if (normalized.includes('rate_limit')) {
    throw providerErrorFromCode('RATE_LIMIT');
  }
  if (
    normalized.includes('server') ||
    normalized.includes('overloaded') ||
    normalized.includes('timeout') ||
    normalized.includes('model_error')
  ) {
    throw providerErrorFromCode('TRANSIENT');
  }
  throw providerErrorFromCode('INVALID_RESPONSE');
}

/** Parses an event payload while replacing validation details with a safe provider error. */
function parsePayload<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
  return parsed.data;
}

/** Normalizes optional Responses usage accounting. */
function normalizeUsage(usage: z.infer<typeof usageSchema> | null | undefined): ModelUsage | null {
  if (usage == null) {
    return null;
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens === undefined
      ? {}
      : { cachedInputTokens: usage.input_tokens_details.cached_tokens }),
    ...(usage.input_tokens_details?.cache_write_tokens === undefined
      ? {}
      : {
          cacheWriteInputTokens: usage.input_tokens_details.cache_write_tokens,
        }),
    ...(usage.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : {
          reasoningOutputTokens: usage.output_tokens_details.reasoning_tokens,
        }),
  };
}

/** Compares the bounded normalized usage fields used by duplicate terminal events. */
function sameUsage(left: ModelUsage | null, right: ModelUsage | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens
  );
}

export class CodexEventTranslator {
  readonly #calls = new Map<string, FunctionCallState>();
  readonly #encryptedReasoningItems = new Set<string>();
  readonly #reasoningSummaries = new Set<string>();
  readonly #outputTexts = new Map<string, ContentTextState>();
  readonly #refusals = new Map<string, ContentTextState>();
  readonly #itemIdsByOutputIndex = new Map<number, string>();
  readonly #outputIndexesByItemId = new Map<string, number>();
  readonly #contentPartKinds = new Map<string, ContentPartKind>();
  #responseId: string | null = null;
  #responseCompleted = false;
  #terminalKind: 'completed' | 'incomplete' | 'failed' | null = null;
  #completionUsage: ModelUsage | null = null;

  /** Translates one decoded SSE event into zero or more stable model events. */
  translate(event: DecodedSseEvent): readonly ModelStreamEvent[] {
    if (event.event !== 'message' && !SUPPORTED_EVENT_TYPES.has(event.event)) {
      return [];
    }
    const envelope = parsePayload(objectSchema, event.data);
    const eventType = event.event === 'message' ? envelope.type : event.event;
    if (!eventType) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    if (envelope.type !== undefined && envelope.type !== eventType) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    if (ACTIVE_RESPONSE_EVENT_TYPES.has(eventType)) {
      this.#assertResponseActive();
    }

    switch (eventType) {
      case 'response.created':
        return this.#created(event.data);
      case 'response.output_text.delta':
        return this.#textDelta(event.data);
      case 'response.output_text.done':
        return this.#textDone(event.data);
      case 'response.refusal.delta':
        return this.#refusalDelta(event.data);
      case 'response.refusal.done':
        return this.#refusalDone(event.data);
      case 'response.content_part.done':
        return this.#contentPartDone(event.data);
      case 'response.reasoning_summary_text.done':
        return this.#reasoningSummaryDone(event.data);
      case 'response.output_item.added':
        return this.#outputItemAdded(event.data);
      case 'response.function_call_arguments.delta':
        return this.#argumentsDelta(event.data);
      case 'response.function_call_arguments.done':
        return this.#argumentsDone(event.data);
      case 'response.output_item.done':
        return this.#outputItemDone(event.data);
      case 'response.completed':
        return this.#completed(event.data);
      case 'response.incomplete':
        return this.#incomplete(event.data);
      case 'response.failed':
        return this.#failed(event.data);
      case 'error':
        return this.#error(event.data);
      default:
        return [];
    }
  }

  /** Treats a clean transport EOF without a terminal response event as retryable interruption. */
  finish(): void {
    if (!this.#responseCompleted) {
      throw providerErrorFromCode('TRANSIENT');
    }
  }

  /** Records the unique response identifier. */
  #created(data: unknown): readonly ModelStreamEvent[] {
    const created = parsePayload(createdSchema, data);
    if (this.#responseId !== null) {
      if (!this.#responseCompleted && this.#responseId === created.response.id) return [];
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#responseId = created.response.id;
    return [{ type: 'response.started', responseId: created.response.id }];
  }

  /** Rejects recognized response content outside the one active response lifecycle. */
  #assertResponseActive(): void {
    if (this.#responseId === null || this.#responseCompleted) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
  }

  /** Verifies that a terminal event belongs to the active response. */
  #assertTerminalResponse(responseId: string): void {
    this.#assertResponseActive();
    if (responseId !== this.#responseId) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
  }

  /** Keeps output-index, item-id, content-index, and content-type identities consistent. */
  #registerContentPart(
    identity: {
      readonly item_id: string;
      readonly output_index: number;
      readonly content_index: number;
    },
    kind: ContentPartKind,
  ): string {
    const knownItemId = this.#itemIdsByOutputIndex.get(identity.output_index);
    const knownOutputIndex = this.#outputIndexesByItemId.get(identity.item_id);
    if (
      (knownItemId !== undefined && knownItemId !== identity.item_id) ||
      (knownOutputIndex !== undefined && knownOutputIndex !== identity.output_index)
    ) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#itemIdsByOutputIndex.set(identity.output_index, identity.item_id);
    this.#outputIndexesByItemId.set(identity.item_id, identity.output_index);

    const key = contentPartKey(identity);
    const knownKind = this.#contentPartKinds.get(key);
    if (knownKind !== undefined && knownKind !== kind) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#contentPartKinds.set(key, kind);
    return key;
  }

  /** Converts a text delta without buffering model content in the adapter. */
  #textDelta(data: unknown): readonly ModelStreamEvent[] {
    const delta = parsePayload(textDeltaSchema, data);
    const identity = optionalContentPartIdentity(delta);
    if (identity !== null) {
      const key = this.#registerContentPart(identity, 'output_text');
      const current = this.#outputTexts.get(key);
      if (current?.completed) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      this.#outputTexts.set(key, {
        text: `${current?.text ?? ''}${delta.delta}`,
        completed: false,
      });
    }
    return delta.delta.length === 0 ? [] : [{ type: 'text.delta', delta: delta.delta }];
  }

  /** Reconciles canonical finalized text without duplicating deltas already delivered. */
  #textDone(data: unknown): readonly ModelStreamEvent[] {
    const done = parsePayload(textDoneSchema, data);
    const key = this.#registerContentPart(done, 'output_text');
    return this.#completeTextPart(this.#outputTexts, key, done.text);
  }

  /** Exposes refusal text through the ordinary visible assistant text stream. */
  #refusalDelta(data: unknown): readonly ModelStreamEvent[] {
    const delta = parsePayload(refusalDeltaSchema, data);
    const key = this.#registerContentPart(delta, 'refusal');
    const current = this.#refusals.get(key);
    if (current?.completed) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#refusals.set(key, {
      text: `${current?.text ?? ''}${delta.delta}`,
      completed: false,
    });
    return delta.delta.length === 0 ? [] : [{ type: 'text.delta', delta: delta.delta }];
  }

  /** Completes refusal text without duplicating deltas already delivered by the stream. */
  #refusalDone(data: unknown): readonly ModelStreamEvent[] {
    const done = parsePayload(refusalDoneSchema, data);
    const key = this.#registerContentPart(done, 'refusal');
    return this.#completeTextPart(this.#refusals, key, done.refusal);
  }

  /** Uses a completed output-text content part when finer-grained events were unavailable. */
  #contentPartDone(data: unknown): readonly ModelStreamEvent[] {
    const done = parsePayload(contentPartDoneSchema, data);
    if (done.part.type === 'output_text') {
      const part = parsePayload(outputTextPartSchema, done.part);
      const key = this.#registerContentPart(done, 'output_text');
      return this.#completeTextPart(this.#outputTexts, key, part.text);
    }
    if (done.part.type === 'refusal') {
      const part = parsePayload(refusalPartSchema, done.part);
      const key = this.#registerContentPart(done, 'refusal');
      return this.#completeTextPart(this.#refusals, key, part.refusal);
    }
    return [];
  }

  /** Emits only text missing from a canonical completion and rejects conflicting final content. */
  #completeTextPart(
    states: Map<string, ContentTextState>,
    key: string,
    completedText: string,
  ): readonly ModelStreamEvent[] {
    const current = states.get(key);
    if (current?.completed) {
      if (current.text !== completedText) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      return [];
    }
    if (!completedText.startsWith(current?.text ?? '')) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    const delta = completedText.slice(current?.text.length ?? 0);
    states.set(key, { text: completedText, completed: true });
    return delta.length === 0 ? [] : [{ type: 'text.delta', delta }];
  }

  /** Records only the provider-authored summary, never raw chain-of-thought deltas. */
  #reasoningSummaryDone(data: unknown): readonly ModelStreamEvent[] {
    const summary = parsePayload(reasoningSummaryDoneSchema, data);
    const key = `${summary.item_id}:${String(summary.summary_index)}`;
    if (this.#reasoningSummaries.has(key)) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#reasoningSummaries.add(key);
    return summary.text.length === 0
      ? []
      : [
          {
            type: 'reasoning.summary',
            itemId: summary.item_id,
            summaryIndex: summary.summary_index,
            text: summary.text,
          },
        ];
  }

  /** Starts a supported function-call item and remembers its item-to-call mapping. */
  #outputItemAdded(data: unknown): readonly ModelStreamEvent[] {
    const output = parsePayload(outputItemSchema, data);
    if (output.item.type !== 'function_call') {
      return [];
    }
    const item = parsePayload(functionCallItemSchema, output.item);
    if (this.#calls.has(item.id)) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    const name = fromCodexToolName(item.name);
    this.#calls.set(item.id, {
      callId: item.call_id,
      name,
      completed: false,
      argumentsJson: null,
    });
    return [{ type: 'tool.started', callId: item.call_id, name }];
  }

  /** Resolves an argument delta through the previously announced output item. */
  #argumentsDelta(data: unknown): readonly ModelStreamEvent[] {
    const delta = parsePayload(argumentDeltaSchema, data);
    const call = this.#calls.get(delta.item_id);
    if (!call || call.completed) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    return delta.delta.length === 0
      ? []
      : [
          {
            type: 'tool.arguments.delta',
            callId: call.callId,
            delta: delta.delta,
          },
        ];
  }

  /** Completes a function call from its canonical arguments-done event. */
  #argumentsDone(data: unknown): readonly ModelStreamEvent[] {
    const done = parsePayload(argumentDoneSchema, data);
    const call = this.#calls.get(done.item_id);
    if (!call) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    if (call.completed) {
      if (call.argumentsJson === done.arguments) return [];
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    call.completed = true;
    call.argumentsJson = done.arguments;
    return [
      {
        type: 'tool.completed',
        callId: call.callId,
        name: call.name,
        argumentsJson: done.arguments,
      },
    ];
  }

  /** Uses output-item completion as a fallback without duplicating a done event. */
  #outputItemDone(data: unknown): readonly ModelStreamEvent[] {
    const output = parsePayload(outputItemSchema, data);
    if (output.item.type === 'message') {
      return this.#messageOutputDone(data);
    }
    if (output.item.type === 'reasoning') {
      const item = parsePayload(reasoningItemSchema, output.item);
      if (this.#encryptedReasoningItems.has(item.id)) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      this.#encryptedReasoningItems.add(item.id);
      return [
        {
          type: 'reasoning.encrypted',
          itemId: item.id,
          encryptedContent: item.encrypted_content,
          summary: item.summary,
        },
      ];
    }
    if (output.item.type !== 'function_call') {
      return [];
    }
    const item = parsePayload(functionCallItemSchema, output.item);
    const name = fromCodexToolName(item.name);
    const existing = this.#calls.get(item.id);
    if (existing) {
      if (existing.callId !== item.call_id || existing.name !== name) {
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      if (existing.completed) {
        if (existing.argumentsJson !== item.arguments) {
          throw providerErrorFromCode('INVALID_RESPONSE');
        }
        return [];
      }
      existing.completed = true;
      existing.argumentsJson = item.arguments;
      return [
        {
          type: 'tool.completed',
          callId: existing.callId,
          name: existing.name,
          argumentsJson: item.arguments,
        },
      ];
    }

    this.#calls.set(item.id, {
      callId: item.call_id,
      name,
      completed: true,
      argumentsJson: item.arguments,
    });
    return [
      { type: 'tool.started', callId: item.call_id, name },
      {
        type: 'tool.completed',
        callId: item.call_id,
        name,
        argumentsJson: item.arguments,
      },
    ];
  }

  /** Uses the completed message item as the last canonical text/refusal fallback. */
  #messageOutputDone(data: unknown): readonly ModelStreamEvent[] {
    const output = parsePayload(messageOutputDoneSchema, data);
    const events: ModelStreamEvent[] = [];
    output.item.content.forEach((content, contentIndex) => {
      const identity = {
        item_id: output.item.id,
        output_index: output.output_index,
        content_index: contentIndex,
      };
      if (content.type === 'output_text') {
        const part = parsePayload(outputTextPartSchema, content);
        const key = this.#registerContentPart(identity, 'output_text');
        events.push(...this.#completeTextPart(this.#outputTexts, key, part.text));
      } else if (content.type === 'refusal') {
        const part = parsePayload(refusalPartSchema, content);
        const key = this.#registerContentPart(identity, 'refusal');
        events.push(...this.#completeTextPart(this.#refusals, key, part.refusal));
      }
    });
    return events;
  }

  /** Completes the response only after every announced function call is complete. */
  #completed(data: unknown): readonly ModelStreamEvent[] {
    const completed = parsePayload(completedSchema, data);
    const usage = normalizeUsage(completed.response.usage);
    if (this.#responseCompleted) {
      if (
        this.#terminalKind === 'completed' &&
        completed.response.id === this.#responseId &&
        sameUsage(usage, this.#completionUsage)
      ) {
        return [];
      }
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#assertTerminalResponse(completed.response.id);
    if ([...this.#calls.values()].some((call) => !call.completed)) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#responseCompleted = true;
    this.#terminalKind = 'completed';
    this.#completionUsage = usage;
    return [
      {
        type: 'response.completed',
        responseId: completed.response.id,
        usage,
      },
    ];
  }

  /** Treats a valid incomplete terminal response as recoverable instead of malformed SSE. */
  #incomplete(data: unknown): never {
    const incomplete = parsePayload(incompleteSchema, data);
    this.#assertTerminalResponse(incomplete.response.id);
    this.#responseCompleted = true;
    this.#terminalKind = 'incomplete';
    throw providerErrorFromCode('TRANSIENT');
  }

  /** Validates the failed response envelope before mapping its safe upstream code. */
  #failed(data: unknown): never {
    const failed = parsePayload(failedSchema, data);
    this.#assertTerminalResponse(failed.response.id);
    this.#responseCompleted = true;
    this.#terminalKind = 'failed';
    throwUpstreamError(failed.response.error?.code);
  }

  /** Maps connection-level errors unless they contradict an already completed response. */
  #error(data: unknown): never {
    const error = parsePayload(errorSchema, data);
    if (this.#responseCompleted) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    throwUpstreamError(error.code);
  }
}
