import { z } from 'zod';
import { providerErrorFromCode } from '../provider-errors';
import type { DecodedSseEvent } from '../sse-decoder';
import type { ModelStreamEvent, ModelUsage } from '../stream-events';
import { fromCodexToolName } from './codex-tool-name';

const objectSchema = z.object({ type: z.string().optional() }).passthrough();
const responseSchema = z.object({ id: z.string().min(1) }).passthrough();
const createdSchema = objectSchema.extend({ response: responseSchema });
const textDeltaSchema = objectSchema.extend({ delta: z.string() });
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
const outputItemSchema = objectSchema.extend({
  item: z.object({ type: z.string() }).passthrough(),
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
});
const completedSchema = objectSchema.extend({
  response: responseSchema.extend({ usage: usageSchema.nullish() }),
});
const failedSchema = objectSchema.extend({
  response: responseSchema.extend({
    error: z.object({ code: z.string().nullish() }).passthrough().nullish(),
  }),
});
const errorSchema = objectSchema.extend({ code: z.string().nullish() });

interface FunctionCallState {
  readonly callId: string;
  readonly name: string;
  completed: boolean;
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
  };
}

export class CodexEventTranslator {
  readonly #calls = new Map<string, FunctionCallState>();
  readonly #reasoningSummaries = new Set<string>();
  #responseId: string | null = null;
  #responseCompleted = false;

  /** Translates one decoded SSE event into zero or more stable model events. */
  translate(event: DecodedSseEvent): readonly ModelStreamEvent[] {
    const envelope = parsePayload(objectSchema, event.data);
    const eventType = event.event === 'message' ? envelope.type : event.event;
    if (!eventType) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    if (envelope.type !== undefined && envelope.type !== eventType) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }

    switch (eventType) {
      case 'response.created':
        return this.#created(event.data);
      case 'response.output_text.delta':
        return this.#textDelta(event.data);
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
      case 'response.failed': {
        const failed = parsePayload(failedSchema, event.data);
        return throwUpstreamError(failed.response.error?.code);
      }
      case 'error': {
        const error = parsePayload(errorSchema, event.data);
        return throwUpstreamError(error.code);
      }
      default:
        return [];
    }
  }

  /** Verifies that a normal SSE EOF followed a complete model response. */
  finish(): void {
    if (!this.#responseCompleted) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
  }

  /** Records the unique response identifier. */
  #created(data: unknown): readonly ModelStreamEvent[] {
    const created = parsePayload(createdSchema, data);
    if (this.#responseId !== null || this.#responseCompleted) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#responseId = created.response.id;
    return [{ type: 'response.started', responseId: created.response.id }];
  }

  /** Converts a text delta without buffering model content in the adapter. */
  #textDelta(data: unknown): readonly ModelStreamEvent[] {
    const delta = parsePayload(textDeltaSchema, data).delta;
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
    this.#calls.set(item.id, { callId: item.call_id, name, completed: false });
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
      : [{ type: 'tool.arguments.delta', callId: call.callId, delta: delta.delta }];
  }

  /** Completes a function call from its canonical arguments-done event. */
  #argumentsDone(data: unknown): readonly ModelStreamEvent[] {
    const done = parsePayload(argumentDoneSchema, data);
    const call = this.#calls.get(done.item_id);
    if (!call || call.completed) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    call.completed = true;
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
        return [];
      }
      existing.completed = true;
      return [
        {
          type: 'tool.completed',
          callId: existing.callId,
          name: existing.name,
          argumentsJson: item.arguments,
        },
      ];
    }

    this.#calls.set(item.id, { callId: item.call_id, name, completed: true });
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

  /** Completes the response only after every announced function call is complete. */
  #completed(data: unknown): readonly ModelStreamEvent[] {
    const completed = parsePayload(completedSchema, data);
    if (
      this.#responseId === null ||
      this.#responseCompleted ||
      completed.response.id !== this.#responseId ||
      [...this.#calls.values()].some((call) => !call.completed)
    ) {
      throw providerErrorFromCode('INVALID_RESPONSE');
    }
    this.#responseCompleted = true;
    return [
      {
        type: 'response.completed',
        responseId: completed.response.id,
        usage: normalizeUsage(completed.response.usage),
      },
    ];
  }
}
