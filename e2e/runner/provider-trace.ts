import type { BrowserContext, CDPSession } from '@playwright/test';
import { createHash } from 'node:crypto';
import { CODEX_RESPONSES_URL } from '../../src/providers/codex/codex-constants';
import { decodeCodexToolName } from '../../src/providers/codex/tool-namespace';
import { RUNTIME_SUPPLEMENT_PREFIX } from '../../src/agent/context/agent-context';
import { qualifiedToolName } from '../../src/tools/model-tool';
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

function toolDefinitionFingerprint(definitions: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(definitions)).digest('hex').slice(0, 16);
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
  const type = stringValue(item.type) ?? (typeof item.role === 'string' ? 'message' : 'unknown');
  if (type === 'message') return messageItemSummary(item, position, activeUserText);
  if (type === 'function_call') {
    const namespace = typeof item.namespace === 'string' ? item.namespace || undefined : undefined;
    return {
      position,
      type,
      ...(typeof item.name === 'string'
        ? { toolName: decodeCodexToolName(qualifiedToolName(item.name, namespace)) }
        : {}),
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
    toolDefinitionFingerprint: null,
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
    if (
      (item.type !== 'message' && !(item.type === undefined && typeof item.role === 'string')) ||
      !Array.isArray(item.content)
    )
      return [];
    return item.content.flatMap((candidate) => {
      const content = jsonRecord(candidate);
      return typeof content?.text === 'string' ? [content.text] : [];
    });
  });
  const toolDefinitions = Array.isArray(request.tools) ? request.tools : [];
  const tools = toolDefinitions.flatMap((candidate) => {
    const tool = jsonRecord(candidate);
    if (typeof tool?.name !== 'string') return [];
    const name = tool.name;
    if (tool.type !== 'namespace' || !Array.isArray(tool.tools)) return [name];
    return tool.tools.flatMap((member) => {
      const memberName = jsonRecord(member)?.name;
      return typeof memberName === 'string'
        ? [qualifiedToolName(memberName, decodeCodexToolName(name))]
        : [];
    });
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
    toolDefinitionFingerprint: toolDefinitionFingerprint(toolDefinitions),
    skillCatalogDisclosureCount:
      typeof request.instructions === 'string'
        ? new Set(request.instructions.match(/skill_[a-z0-9]{14}/g) ?? []).size
        : 0,
    toolChoice:
      typeof request.tool_choice === 'string'
        ? request.tool_choice
        : typeof choice?.name === 'string'
          ? decodeCodexToolName(choice.name)
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
    ...(summary.hostedToolOutputCount === undefined
      ? {}
      : { hostedToolOutputCount: summary.hostedToolOutputCount }),
    ...(summary.compactionOutputCount === undefined
      ? {}
      : { compactionOutputCount: summary.compactionOutputCount }),
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

interface CapturedResponse {
  readonly kind: 'response' | 'compaction';
  readonly entry: MutableTrace;
  readonly chunks: Buffer[];
  bytes: number;
  pending: boolean;
  readonly finished: Promise<void>;
  finish(): void;
}

/** Observes raw worker traffic without changing fetch, streaming, or the product's cancellation. */
export class ResponsesTraceCollector {
  readonly #responses = new Map<string, CapturedResponse>();
  readonly #pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
    }
  >();
  readonly #reads = new Set<Promise<void>>();
  #cdp: CDPSession | undefined;
  #sessionId = '';
  #commandId = 0;
  #activeUserText = '';
  #capturing = false;

  constructor(
    private readonly context: BrowserContext,
    private readonly extensionId: string,
    private readonly responsesUrl: string = CODEX_RESPONSES_URL,
  ) {}

  async start(activeUserText: string): Promise<void> {
    this.#activeUserText = activeUserText;
    this.#responses.clear();
    const origin = `chrome-extension://${this.extensionId}/`;
    const page = this.context.pages().find((value) => value.url().startsWith(origin));
    if (!page) throw new Error('E2E Provider trace requires the extension panel.');
    this.#cdp = await this.context.newCDPSession(page);
    const { targetInfos } = await this.#cdp.send('Target.getTargets');
    const worker = targetInfos.find(
      (target) => target.type === 'service_worker' && target.url.startsWith(origin),
    );
    if (!worker) throw new Error('E2E Provider trace could not locate the extension worker.');
    const { sessionId } = await this.#cdp.send('Target.attachToTarget', {
      targetId: worker.targetId,
      flatten: false,
    });
    this.#sessionId = sessionId;
    this.#cdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
      if (sessionId !== this.#sessionId) return;
      const event = JSON.parse(message) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (event.id !== undefined) {
        const pending = this.#pending.get(event.id);
        this.#pending.delete(event.id);
        if (event.error) pending?.reject(new Error('E2E Provider CDP command failed.'));
        else pending?.resolve(event.result ?? {});
      } else if (event.method && event.params) this.#onEvent(event.method, event.params);
    });
    await this.#send('Network.enable', { maxPostDataSize: 32 * 1024 * 1024 });
    this.#capturing = true;
  }

  async #send(method: string, params: object): Promise<Record<string, unknown>> {
    const cdp = this.#cdp;
    if (!cdp) throw new Error('E2E Provider CDP session is unavailable.');
    const id = ++this.#commandId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('E2E Provider CDP command timed out.'));
      }, 5000);
      this.#pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
      void cdp
        .send('Target.sendMessageToTarget', {
          sessionId: this.#sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(() => this.#pending.get(id)?.reject(new Error('E2E Provider CDP session closed.')));
    });
  }

  #onEvent(method: string, params: Record<string, unknown>): void {
    const requestId = String(params.requestId);
    if (method === 'Network.requestWillBeSent' && this.#capturing) {
      const request = params.request as {
        url: string;
        method: string;
        postData?: string;
      };
      if (
        request.method !== 'POST' ||
        ![this.responsesUrl, UNSUPPORTED_CODEX_COMPACT_URL].includes(request.url)
      )
        return;
      let body: unknown = null;
      try {
        body = JSON.parse(request.postData ?? 'null');
      } catch {
        /* Recorded as an invalid contract. */
      }
      const kind = request.url === UNSUPPORTED_CODEX_COMPACT_URL ? 'compaction' : 'response';
      let finish = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.#responses.set(requestId, {
        kind,
        chunks: [],
        bytes: 0,
        pending: false,
        finished,
        finish,
        entry: {
          ...summarizeResponsesRequestBody(body, this.#activeUserText),
          sequence: [...this.#responses.values()].filter((value) => value.kind === kind).length + 1,
          extensionOwned: true,
          response: emptyResponseSummary(),
        },
      });
    }
    const captured = this.#responses.get(requestId);
    if (!captured) return;
    if (method === 'Network.responseReceived') {
      const response = params.response as { status: number; mimeType: string };
      captured.entry.response = {
        ...captured.entry.response,
        status: response.status,
        contentType: response.mimeType,
      };
      // response.finished()/body() can stay pending when an SDK closes after response.completed.
      // CDP supplies both the bytes already buffered and later chunks before that cancellation.
      captured.pending = true;
      const read = this.#send('Network.streamResourceContent', { requestId })
        .then((result) => this.#append(captured, String(result.bufferedData ?? ''), true))
        .catch(async () => {
          const result = await this.#send('Network.getResponseBody', {
            requestId,
          });
          const body = Buffer.from(
            String(result.body ?? ''),
            result.base64Encoded ? 'base64' : 'utf8',
          );
          this.#append(captured, body.toString('base64'), true);
        })
        .catch(() => {
          captured.entry.response = {
            ...captured.entry.response,
            captureError: 'response_body_unavailable',
          };
        })
        .finally(() => {
          captured.pending = false;
          this.#reads.delete(read);
        });
      this.#reads.add(read);
    } else if (method === 'Network.dataReceived' && typeof params.data === 'string') {
      this.#append(captured, params.data);
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      captured.finish();
    }
  }

  #append(captured: CapturedResponse, data: string, initial = false): void {
    const chunk = Buffer.from(data, 'base64');
    captured.bytes += chunk.byteLength;
    if (captured.bytes > MAX_RESPONSE_BODY_BYTES) {
      captured.chunks.length = 0;
      return;
    }
    if (initial) captured.chunks.unshift(chunk);
    else captured.chunks.push(chunk);
  }

  async finish(responseWaitMs = 1_000): Promise<LiveProviderTrace> {
    this.#capturing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([
          ...this.#reads,
          ...[...this.#responses.values()].map((value) => value.finished),
        ]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, responseWaitMs);
        }),
      ]);
      const entries = [...this.#responses.values()].map(
        ({ kind, entry, chunks, bytes, pending }) => {
          const summary =
            kind === 'compaction'
              ? summarizeCompactionResponse(Buffer.concat(chunks), entry.response.status)
              : summarizeSseResponse(Buffer.concat(chunks), entry.response.status);
          return {
            kind,
            entry: {
              ...entry,
              response: {
                ...entry.response,
                ...summary,
                bodyBytes: bytes,
                bodyTooLarge: bytes > MAX_RESPONSE_BODY_BYTES,
                captureError:
                  bytes > MAX_RESPONSE_BODY_BYTES
                    ? 'response_body_exceeded_capture_limit'
                    : (entry.response.captureError ??
                      (pending ? 'response_body_pending' : summary.captureError)),
              },
            },
          };
        },
      );
      const requests = entries
        .filter((value) => value.kind === 'response')
        .map(({ entry }) => entry);
      const compactionRequests = entries
        .filter((value) => value.kind === 'compaction')
        .map(({ entry }) => entry);
      return {
        requestCount: requests.length,
        requests,
        compactionRequestCount: compactionRequests.length,
        compactionRequests,
      };
    } finally {
      if (timer) clearTimeout(timer);
      await this.#cdp?.detach().catch(() => undefined);
      this.#cdp = undefined;
      for (const pending of this.#pending.values())
        pending.reject(new Error('E2E Provider trace closed.'));
      this.#pending.clear();
      this.#responses.clear();
    }
  }
}
