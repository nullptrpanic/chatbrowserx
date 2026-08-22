import type { BrowserContext, Request, Response } from '@playwright/test';
import { CODEX_RESPONSES_URL } from '../../src/providers/codex/codex-constants';
import { RUNTIME_SUPPLEMENT_PREFIX } from '../../src/agent/context/agent-context';
import type {
  LiveProviderInputItemSummary,
  LiveProviderRequestBodySummary,
  LiveProviderResponseSummary,
  LiveProviderTrace,
} from './live-types';

const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_TYPES = 32;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function serializedCharacters(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function messageItemSummary(
  item: Readonly<Record<string, unknown>>,
  position: number,
  activeUserText: string,
): LiveProviderInputItemSummary {
  const contents = Array.isArray(item.content) ? item.content : [];
  const contentRecords = contents.flatMap((candidate) => {
    const content = record(candidate);
    return content === null ? [] : [content];
  });
  const texts = contentRecords.flatMap((content) =>
    typeof content.text === 'string' ? [content.text] : [],
  );
  return {
    position,
    type: 'message',
    ...(typeof item.role === 'string' ? { role: item.role } : {}),
    contentTypes: contentRecords.map((content) => stringValue(content.type) ?? 'unknown'),
    textCharacters: texts.reduce((total, text) => total + text.length, 0),
    matchesActiveUserRequest: item.role === 'user' && texts.includes(activeUserText),
  };
}

function inputItemSummary(
  item: Readonly<Record<string, unknown>>,
  position: number,
  activeUserText: string,
): LiveProviderInputItemSummary {
  const type = stringValue(item.type) ?? 'unknown';
  if (type === 'message') return messageItemSummary(item, position, activeUserText);
  if (type === 'function_call') {
    return {
      position,
      type,
      ...(typeof item.name === 'string' ? { toolName: item.name } : {}),
      argumentCharacters: serializedCharacters(item.arguments),
    };
  }
  if (type === 'function_call_output') {
    return {
      position,
      type,
      outputCharacters: serializedCharacters(item.output),
    };
  }
  if (type === 'reasoning') {
    return {
      position,
      type,
      encryptedContentCharacters:
        typeof item.encrypted_content === 'string' ? item.encrypted_content.length : 0,
    };
  }
  return { position, type };
}

function invalidRequestSummary(): LiveProviderRequestBodySummary {
  return {
    bodyValid: false,
    model: null,
    instructionCharacters: 0,
    store: null,
    stream: null,
    parallelToolCalls: null,
    includesEncryptedReasoning: false,
    toolNames: [],
    toolDefinitionCharacters: 0,
    toolChoice: null,
    inputItems: [],
    activeUserRequestOccurrences: 0,
    runtimeSupplementOccurrences: 0,
    functionCallCount: 0,
    functionOutputCount: 0,
    orphanFunctionOutputCount: 0,
    unpairedFunctionCallCount: 0,
    duplicateFunctionCallIds: false,
    encryptedReasoningInputCount: 0,
  };
}

/** Produces bounded structural evidence without retaining prompt, tool output, or opaque IDs. */
export function summarizeResponsesRequestBody(
  body: unknown,
  activeUserText: string,
): LiveProviderRequestBodySummary {
  const request = record(body);
  if (request === null) return invalidRequestSummary();
  const input = Array.isArray(request.input)
    ? request.input.flatMap((candidate) => {
        const item = record(candidate);
        return item === null ? [] : [item];
      })
    : null;
  if (input === null) return invalidRequestSummary();

  const callCounts = new Map<string, number>();
  const outputCounts = new Map<string, number>();
  for (const item of input) {
    const type = stringValue(item.type);
    const callId = stringValue(item.call_id);
    if (callId === null) continue;
    const target =
      type === 'function_call' ? callCounts : type === 'function_call_output' ? outputCounts : null;
    if (target !== null) target.set(callId, (target.get(callId) ?? 0) + 1);
  }
  const functionCallCount = [...callCounts.values()].reduce((total, count) => total + count, 0);
  const functionOutputCount = [...outputCounts.values()].reduce((total, count) => total + count, 0);
  const inputItems = input.map((item, position) =>
    inputItemSummary(item, position, activeUserText),
  );
  const messageTexts = input.flatMap((item) => {
    if (item.type !== 'message' || !Array.isArray(item.content)) return [];
    return item.content.flatMap((candidate) => {
      const content = record(candidate);
      return typeof content?.text === 'string' ? [content.text] : [];
    });
  });
  const toolDefinitions = Array.isArray(request.tools) ? request.tools : [];
  const tools = toolDefinitions.flatMap((candidate) => {
    const tool = record(candidate);
    return typeof tool?.name === 'string' ? [tool.name] : [];
  });
  const choice = record(request.tool_choice);

  return {
    bodyValid: true,
    model: stringValue(request.model),
    instructionCharacters:
      typeof request.instructions === 'string' ? request.instructions.length : 0,
    store: booleanValue(request.store),
    stream: booleanValue(request.stream),
    parallelToolCalls: booleanValue(request.parallel_tool_calls),
    includesEncryptedReasoning:
      Array.isArray(request.include) && request.include.includes('reasoning.encrypted_content'),
    toolNames: tools.slice(0, 64),
    toolDefinitionCharacters: toolDefinitions.reduce(
      (total, definition) => total + serializedCharacters(definition),
      0,
    ),
    toolChoice:
      typeof request.tool_choice === 'string'
        ? request.tool_choice
        : typeof choice?.name === 'string'
          ? choice.name
          : null,
    inputItems,
    activeUserRequestOccurrences: messageTexts.filter((text) => text === activeUserText).length,
    runtimeSupplementOccurrences: messageTexts.filter((text) =>
      text.startsWith(RUNTIME_SUPPLEMENT_PREFIX),
    ).length,
    functionCallCount,
    functionOutputCount,
    orphanFunctionOutputCount: [...outputCounts].reduce(
      (total, [callId, count]) => total + (callCounts.has(callId) ? 0 : count),
      0,
    ),
    unpairedFunctionCallCount: [...callCounts].reduce(
      (total, [callId, count]) => total + Math.max(0, count - (outputCounts.get(callId) ?? 0)),
      0,
    ),
    duplicateFunctionCallIds: [...callCounts.values()].some((count) => count > 1),
    encryptedReasoningInputCount: input.filter(
      (item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string',
    ).length,
  };
}

function emptyResponseSummary(): LiveProviderResponseSummary {
  return {
    status: null,
    contentType: null,
    bodyBytes: 0,
    bodyTooLarge: false,
    completed: false,
    failed: false,
    eventTypes: [],
    encryptedReasoningOutputCount: 0,
    captureError: null,
  };
}

function summarizeSseResponse(
  body: Buffer,
): Omit<LiveProviderResponseSummary, 'status' | 'contentType'> {
  if (body.byteLength > MAX_RESPONSE_BODY_BYTES) {
    return {
      bodyBytes: body.byteLength,
      bodyTooLarge: true,
      completed: false,
      failed: false,
      eventTypes: [],
      encryptedReasoningOutputCount: 0,
      captureError: 'response_body_exceeded_capture_limit',
    };
  }
  const eventTypes = new Set<string>();
  const reasoningItems = new Set<string>();
  let completed = false;
  let failed = false;
  for (const line of body.toString('utf8').split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      const eventType = line.slice('event:'.length).trim();
      if (eventType.length > 0 && eventTypes.size < MAX_EVENT_TYPES) eventTypes.add(eventType);
      if (eventType === 'response.completed') completed = true;
      if (eventType === 'response.failed' || eventType === 'error') failed = true;
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const serialized = line.slice('data:'.length).trim();
    if (serialized.length === 0 || serialized === '[DONE]') continue;
    try {
      const payload = record(JSON.parse(serialized));
      const eventType = stringValue(payload?.type);
      if (eventType !== null && eventTypes.size < MAX_EVENT_TYPES) eventTypes.add(eventType);
      if (eventType === 'response.completed') completed = true;
      if (eventType === 'response.failed' || eventType === 'error') failed = true;
      const item = record(payload?.item);
      if (item?.type === 'reasoning' && typeof item.encrypted_content === 'string') {
        reasoningItems.add(stringValue(item.id) ?? `reasoning_${String(reasoningItems.size + 1)}`);
      }
    } catch {
      // Other SSE payloads remain irrelevant to this bounded structural audit.
    }
  }
  return {
    bodyBytes: body.byteLength,
    bodyTooLarge: false,
    completed,
    failed,
    eventTypes: [...eventTypes],
    encryptedReasoningOutputCount: reasoningItems.size,
    captureError: null,
  };
}

interface MutableTrace extends LiveProviderRequestBodySummary {
  sequence: number;
  extensionOwned: boolean;
  response: LiveProviderResponseSummary;
}

/** Captures only sanitized Responses request/response structure from the extension service worker. */
export class ResponsesTraceCollector {
  readonly #extensionOrigin: string;
  readonly #requestEntries = new Map<Request, MutableTrace>();
  readonly #entries: MutableTrace[] = [];
  readonly #responseTasks = new Set<Promise<void>>();
  #activeUserText = '';
  #capturing = false;

  constructor(context: BrowserContext, extensionId: string) {
    this.#extensionOrigin = `chrome-extension://${extensionId}`;
    context.on('request', this.#onRequest);
    context.on('response', this.#onResponse);
  }

  start(activeUserText: string): void {
    this.#activeUserText = activeUserText;
    this.#entries.length = 0;
    this.#requestEntries.clear();
    this.#capturing = true;
  }

  async finish(): Promise<LiveProviderTrace> {
    this.#capturing = false;
    await Promise.all([...this.#responseTasks]);
    return {
      requestCount: this.#entries.length,
      requests: this.#entries.map((entry) => ({
        ...entry,
        response: { ...entry.response },
      })),
    };
  }

  readonly #onRequest = (request: Request): void => {
    if (!this.#capturing || request.url() !== CODEX_RESPONSES_URL || request.method() !== 'POST') {
      return;
    }
    let body: unknown;
    try {
      const serialized = request.postData();
      body = serialized === null ? null : JSON.parse(serialized);
    } catch {
      body = null;
    }
    const summary = summarizeResponsesRequestBody(body, this.#activeUserText);
    const workerUrl = request.serviceWorker()?.url() ?? '';
    const entry: MutableTrace = {
      ...summary,
      sequence: this.#entries.length + 1,
      extensionOwned: workerUrl.startsWith(this.#extensionOrigin),
      response: emptyResponseSummary(),
    };
    this.#entries.push(entry);
    this.#requestEntries.set(request, entry);
  };

  readonly #onResponse = (response: Response): void => {
    const entry = this.#requestEntries.get(response.request());
    if (entry === undefined) return;
    entry.response = {
      ...entry.response,
      status: response.status(),
      contentType: response.headers()['content-type'] ?? null,
    };
    const task = response
      .finished()
      .then(async () => response.body())
      .then((body) => {
        entry.response = {
          status: entry.response.status,
          contentType: entry.response.contentType,
          ...summarizeSseResponse(body),
        };
      })
      .catch(() => {
        entry.response = {
          ...entry.response,
          captureError: 'response_body_unavailable',
        };
      })
      .finally(() => {
        this.#responseTasks.delete(task);
      });
    this.#responseTasks.add(task);
  };
}
