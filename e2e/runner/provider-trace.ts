import type { BrowserContext, Request, Response } from '@playwright/test';
import { CODEX_RESPONSES_URL } from '../../src/providers/codex/codex-constants';
import { RUNTIME_SUPPLEMENT_PREFIX } from '../../src/agent/context/agent-context';
import { jsonRecord } from './json-contract';
import { summarizeProviderSse } from './provider-sse';
import type {
  LiveProviderInputItemSummary,
  LiveProviderRequestBodySummary,
  LiveProviderResponseSummary,
  LiveProviderTrace,
} from './live-types';

const MAX_RESPONSE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_TYPES = 32;
/** Diagnostic-only legacy URL: production code must never dispatch it. */
const UNSUPPORTED_CODEX_COMPACT_URL = `${CODEX_RESPONSES_URL}/compact`;

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
    const content = jsonRecord(candidate);
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
    skillCatalogDisclosureCount: 0,
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
  const request = jsonRecord(body);
  if (request === null) return invalidRequestSummary();
  const input = Array.isArray(request.input)
    ? request.input.flatMap((candidate) => {
        const item = jsonRecord(candidate);
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
      const content = jsonRecord(candidate);
      return typeof content?.text === 'string' ? [content.text] : [];
    });
  });
  const toolDefinitions = Array.isArray(request.tools) ? request.tools : [];
  const tools = toolDefinitions.flatMap((candidate) => {
    const tool = jsonRecord(candidate);
    return typeof tool?.name === 'string' ? [tool.name] : [];
  });
  const choice = jsonRecord(request.tool_choice);

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
    skillCatalogDisclosureCount:
      typeof request.instructions === 'string'
        ? new Set(request.instructions.match(/skill_[a-z0-9]{14}/g) ?? []).size
        : 0,
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
  status: number | null,
): Omit<LiveProviderResponseSummary, 'status' | 'contentType'> {
  const summary = summarizeProviderSse(body, status);
  return {
    bodyBytes: summary.bodyBytes,
    bodyTooLarge: summary.bodyTooLarge,
    completed: summary.completed,
    failed: summary.failed,
    eventTypes: summary.eventTypes,
    encryptedReasoningOutputCount: summary.encryptedReasoningOutputCount,
    captureError: summary.captureError,
  };
}

/** Summarizes unary compaction without retaining response messages or encrypted content. */
function summarizeCompactionResponse(
  body: Buffer,
  status: number | null,
): Omit<LiveProviderResponseSummary, 'status' | 'contentType'> {
  if (body.byteLength > MAX_RESPONSE_BODY_BYTES) {
    return {
      bodyBytes: body.byteLength,
      bodyTooLarge: true,
      completed: false,
      failed: status !== null && status >= 400,
      eventTypes: [],
      encryptedReasoningOutputCount: 0,
      captureError: 'response_body_exceeded_capture_limit',
    };
  }
  let payload: Readonly<Record<string, unknown>> | null = null;
  try {
    payload = jsonRecord(JSON.parse(body.toString('utf8')));
  } catch {
    // A bounded structural error is sufficient; never retain the raw response body.
  }
  const output = Array.isArray(payload?.output)
    ? payload.output.flatMap((candidate) => {
        const item = jsonRecord(candidate);
        return item === null ? [] : [item];
      })
    : [];
  const objectType = stringValue(payload?.object);
  const outputTypes = output.flatMap((item) => {
    const type = stringValue(item.type);
    return type === null ? [] : [type];
  });
  const completed =
    status !== null &&
    status >= 200 &&
    status < 300 &&
    objectType === 'response.compaction' &&
    outputTypes.at(-1) === 'compaction';
  return {
    bodyBytes: body.byteLength,
    bodyTooLarge: false,
    completed,
    failed: status !== null && status >= 400,
    eventTypes: [...new Set([...(objectType === null ? [] : [objectType]), ...outputTypes])].slice(
      0,
      MAX_EVENT_TYPES,
    ),
    encryptedReasoningOutputCount: output.filter(
      (item) => item.type === 'compaction' && typeof item.encrypted_content === 'string',
    ).length,
    captureError:
      status !== null && status >= 400
        ? null
        : payload === null
          ? 'invalid_compaction_response_json'
          : completed
            ? null
            : 'invalid_compaction_response_shape',
  };
}

interface MutableTrace extends LiveProviderRequestBodySummary {
  sequence: number;
  extensionOwned: boolean;
  response: LiveProviderResponseSummary;
}

interface RequestTraceTarget {
  readonly kind: 'response' | 'compaction';
  readonly entry: MutableTrace;
}

/** Captures only sanitized Responses request/response structure from the extension service worker. */
export class ResponsesTraceCollector {
  readonly #extensionOrigin: string;
  readonly #requestEntries = new Map<Request, RequestTraceTarget>();
  readonly #entries: MutableTrace[] = [];
  readonly #compactionEntries: MutableTrace[] = [];
  readonly #responseTasks = new Map<Promise<void>, MutableTrace>();
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
    this.#compactionEntries.length = 0;
    this.#requestEntries.clear();
    this.#responseTasks.clear();
    this.#capturing = true;
  }

  async finish(responseWaitMs = 1_000): Promise<LiveProviderTrace> {
    this.#capturing = false;
    const pending = [...this.#responseTasks.keys()];
    if (pending.length > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, Math.max(0, responseWaitMs));
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
    for (const entry of this.#responseTasks.values()) {
      if (entry.response.captureError !== null) continue;
      entry.response = {
        ...entry.response,
        captureError: 'response_body_pending',
      };
    }
    return {
      requestCount: this.#entries.length,
      requests: this.#entries.map((entry) => ({
        ...entry,
        response: { ...entry.response },
      })),
      compactionRequestCount: this.#compactionEntries.length,
      compactionRequests: this.#compactionEntries.map((entry) => ({
        ...entry,
        response: { ...entry.response },
      })),
    };
  }

  readonly #onRequest = (request: Request): void => {
    const url = request.url();
    if (
      !this.#capturing ||
      (url !== CODEX_RESPONSES_URL && url !== UNSUPPORTED_CODEX_COMPACT_URL) ||
      request.method() !== 'POST'
    ) {
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
    const kind = url === UNSUPPORTED_CODEX_COMPACT_URL ? 'compaction' : 'response';
    const targetEntries = kind === 'compaction' ? this.#compactionEntries : this.#entries;
    const entry: MutableTrace = {
      ...summary,
      sequence: targetEntries.length + 1,
      extensionOwned: workerUrl.startsWith(this.#extensionOrigin),
      response: emptyResponseSummary(),
    };
    targetEntries.push(entry);
    this.#requestEntries.set(request, { kind, entry });
  };

  readonly #onResponse = (response: Response): void => {
    const target = this.#requestEntries.get(response.request());
    if (target === undefined) return;
    const { entry } = target;
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
          ...(target.kind === 'compaction'
            ? summarizeCompactionResponse(body, entry.response.status)
            : summarizeSseResponse(body, entry.response.status)),
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
    this.#responseTasks.set(task, entry);
  };
}
