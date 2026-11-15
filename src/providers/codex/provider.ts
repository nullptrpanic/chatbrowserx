import OpenAI from 'openai';
import { Stream } from 'openai/core/streaming';
import type {
  Response as CodexResponse,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { OpenAIResponsesModel, webSearchTool } from '@openai/agents-openai';
import type {
  ModelRequest,
  ModelRetryAdviceRequest,
  ModelRetryAdvice,
  ResponseStreamEvent as ModelStreamEvent,
} from '@openai/agents-core';
import { z } from 'zod';
import type { Provider, ProviderCredentialSync, ProviderModel, ModelSelection } from '../provider';
import type { ModelActivity, ModelUsage } from '../model-events';
import { isProviderError, providerErrorFromCode } from '../provider-error';
import { retryAfterMs } from '../../shared/net/http-failure';
import { compactionItemSchema } from '../../shared/protocol/compaction-item';
import { extractChatGptAccountId } from './access-token';
import { CODEX_CATALOG_CLIENT_VERSION, CODEX_RESPONSES_URL } from './codex-constants';
import { decodeCodexToolCall, encodeCodexToolNames } from './tool-namespace';
export type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function reportedUsage(raw: CodexResponse['usage'] | undefined): ModelUsage | null {
  if (!raw) return null;
  return {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    totalTokens: raw.total_tokens,
    ...(raw.input_tokens_details?.cached_tokens === undefined
      ? {}
      : { cachedInputTokens: raw.input_tokens_details.cached_tokens }),
    ...(raw.output_tokens_details?.reasoning_tokens === undefined
      ? {}
      : { reasoningOutputTokens: raw.output_tokens_details.reasoning_tokens }),
  };
}

function streamActivity(event: ResponseStreamEvent): ModelActivity | undefined {
  if (event.type === 'response.reasoning_summary_text.delta') {
    return {
      type: 'reasoning_summary_delta',
      key: `${event.item_id}:${event.summary_index}`,
      delta: event.delta,
    };
  }
  if (
    event.type === 'response.reasoning_summary_text.done' ||
    event.type === 'response.reasoning_summary_part.done'
  ) {
    return {
      type: 'reasoning_summary_done',
      key: `${event.item_id}:${event.summary_index}`,
      text: event.type === 'response.reasoning_summary_text.done' ? event.text : event.part.text,
    };
  }
  if (
    (event.type !== 'response.output_item.added' && event.type !== 'response.output_item.done') ||
    !event.item
  )
    return;
  const { item, output_index: index } = event;
  if (
    item.type === 'message' &&
    item.role === 'assistant' &&
    item.id &&
    (item.phase === 'commentary' || item.phase === 'final_answer')
  ) {
    if (event.type === 'response.output_item.added')
      return item.phase === 'final_answer'
        ? { type: 'assistant_final_answer', itemId: item.id }
        : undefined;
    if (!Array.isArray(item.content)) return;
    const text = item.content
      .flatMap((part) =>
        part.type === 'output_text' ? [part.text] : part.type === 'refusal' ? [part.refusal] : [],
      )
      .join('\n');
    if (text.trim())
      return item.phase === 'final_answer'
        ? { type: 'assistant_final_answer', itemId: item.id, text }
        : { type: 'assistant_commentary', itemId: item.id, index, text };
  }
  if (
    event.type === 'response.output_item.done' &&
    item.type === 'web_search_call' &&
    item.status === 'completed'
  ) {
    const { status, ...providerData } = item;
    return {
      type: 'hosted_tool_done',
      index,
      item: { type: 'hosted_tool_call', id: item.id, name: item.type, status, providerData },
    };
  }
}

const catalogSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().optional(),
      visibility: z.string().optional(),
      default_reasoning_level: z.string(),
      supported_reasoning_levels: z.array(z.object({ effort: z.string() })).min(1),
      context_window: z.number().int().positive(),
    }),
  ),
});

function normalizeError(error: unknown): never {
  if (isProviderError(error)) throw error;
  if (error instanceof OpenAI.APIUserAbortError) throw providerErrorFromCode('ABORTED');
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? null;
    const options = {
      status,
      retryAfterMs: retryAfterMs(error.headers?.get('retry-after') ?? null),
    };
    if (status === 401) throw providerErrorFromCode('AUTH', options);
    if (status === 403) throw providerErrorFromCode('FORBIDDEN', options);
    if (status === 429) throw providerErrorFromCode('RATE_LIMIT', options);
    if (error.code === 'context_length_exceeded')
      throw providerErrorFromCode('CONTEXT_LIMIT', options);
    if (status === null || status >= 500) throw providerErrorFromCode('TRANSIENT', options);
    throw providerErrorFromCode('INVALID_RESPONSE', {
      ...options,
      invalidResponseStage: 'request_contract',
    });
  }
  throw providerErrorFromCode('INVALID_RESPONSE', { invalidResponseStage: 'response_transport' });
}

/** Codex streams completed items separately and may leave the terminal output array empty. */
class CodexResponsesModel extends OpenAIResponsesModel {
  constructor(
    client: OpenAI,
    private readonly selection: ModelSelection,
  ) {
    super(client, selection.model);
  }

  private requestData(request: ModelRequest): ResponseCreateParamsStreaming {
    const built = this._buildResponsesCreateRequest(
      {
        ...request,
        tools:
          request.modelSettings.toolChoice === 'none'
            ? request.tools
            : [webSearchTool(), ...request.tools],
        modelSettings: {
          ...request.modelSettings,
          providerData: {
            ...request.modelSettings.providerData,
            include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
            reasoning: { effort: this.selection.reasoningEffort, summary: 'auto' },
            store: false,
          },
        },
      },
      true,
    );
    const body = built.requestData as ResponseCreateParamsStreaming;
    encodeCodexToolNames(body);
    return body;
  }

  override async *getStreamedResponse(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    try {
      for await (const event of super.getStreamedResponse(request)) {
        if (event.type === 'response_done') {
          const { rawUsage, ...response } = event.response;
          const usage = reportedUsage(rawUsage as CodexResponse['usage']);
          yield {
            ...event,
            response: { ...response, ...(usage ? { rawUsage: { ...usage } } : {}) },
          };
        } else if (event.type === 'model') {
          const activity = streamActivity(event.event as ResponseStreamEvent);
          yield activity ? { type: 'model', event: activity } : event;
        } else yield event;
      }
    } catch (error) {
      normalizeError(error);
    }
  }
  override getRetryAdvice(args: ModelRetryAdviceRequest): ModelRetryAdvice | undefined {
    if (!isProviderError(args.error)) return super.getRetryAdvice(args);
    return {
      suggested: args.error.retryable,
      ...(args.error.retryAfterMs === null ? {} : { retryAfterMs: args.error.retryAfterMs }),
      // HTTP rejection occurs before dispatch; transport interruption may have done hosted work.
      ...(args.error.status === null ? {} : { replaySafety: 'safe' as const }),
      normalized: {
        isAbort: args.error.code === 'ABORTED',
        isNetworkError: args.error.code === 'TRANSIENT',
        ...(args.error.status === null ? {} : { statusCode: args.error.status }),
      },
    };
  }
  protected override _fetchResponse(request: ModelRequest, stream: false): Promise<CodexResponse>;
  protected override _fetchResponse(
    request: ModelRequest,
    stream: true,
  ): Promise<Stream<ResponseStreamEvent>>;
  protected override async _fetchResponse(
    request: ModelRequest,
    streaming: boolean,
  ): Promise<CodexResponse | Stream<ResponseStreamEvent>> {
    const events = await this.events(this.requestData(request), request.signal);
    if (streaming) return events;
    for await (const event of events)
      if (event.type === 'response.completed') return event.response;
    throw providerErrorFromCode('TRANSIENT', { transientStage: 'stream_interrupted' });
  }

  private async events(
    body: ResponseCreateParamsStreaming,
    signal?: AbortSignal,
  ): Promise<Stream<ResponseStreamEvent>> {
    try {
      const source = await this._client.responses.create(body, {
        ...(signal === undefined ? {} : { signal }),
      });
      return new Stream<ResponseStreamEvent>(async function* () {
        const completed = new Map<number, CodexResponse['output'][number]>();
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const renew = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            timedOut = true;
            source.controller.abort();
          }, 90_000);
        };
        renew();
        try {
          for await (const raw of source) {
            renew();
            const event =
              raw.type === 'response.output_item.added' || raw.type === 'response.output_item.done'
                ? { ...raw, item: decodeCodexToolCall(raw.item) }
                : raw;
            if (event.type === 'response.failed')
              throw providerErrorFromCode(
                String(event.response.error?.code) === 'context_length_exceeded'
                  ? 'CONTEXT_LIMIT'
                  : 'TRANSIENT',
                { transientStage: 'upstream_error', usage: reportedUsage(event.response.usage) },
              );
            if (event.type === 'response.incomplete')
              throw providerErrorFromCode('TRANSIENT', {
                transientStage: 'response_incomplete',
                usage: reportedUsage(event.response.usage),
              });
            if (event.type === 'response.output_item.done')
              completed.set(event.output_index, event.item);
            if (event.type === 'response.completed') {
              const output = event.response.output.length
                ? event.response.output.map(decodeCodexToolCall)
                : [...completed].sort(([a], [b]) => a - b).map(([, item]) => item);
              yield { ...event, response: { ...event.response, output } };
              return;
            }
            yield event;
          }
          throw providerErrorFromCode(signal?.aborted ? 'ABORTED' : 'TRANSIENT', {
            transientStage: timedOut ? 'stream_idle_timeout' : 'stream_interrupted',
          });
        } catch (error) {
          if (timedOut)
            throw providerErrorFromCode('TRANSIENT', { transientStage: 'stream_idle_timeout' });
          if (signal?.aborted) throw providerErrorFromCode('ABORTED');
          normalizeError(error);
        } finally {
          clearTimeout(timer);
          source.controller.abort();
        }
      }, source.controller);
    } catch (error) {
      return normalizeError(error);
    }
  }

  async compact(request: ModelRequest): Promise<Awaited<ReturnType<Provider['compact']>>> {
    const body = this.requestData(request);
    const source = await this.events(
      {
        ...body,
        tool_choice: 'auto',
        input: [...(Array.isArray(body.input) ? body.input : []), { type: 'compaction_trigger' }],
      } as ResponseCreateParamsStreaming,
      request.signal,
    );
    let compacted: z.infer<typeof compactionItemSchema> | undefined;
    for await (const event of source) {
      if (event.type === 'response.output_item.done' && event.item.type === 'compaction') {
        const parsed = compactionItemSchema.safeParse(event.item);
        if (parsed.success) compacted = parsed.data;
      }
      if (event.type === 'response.completed') {
        const parsed = compactionItemSchema.safeParse(
          event.response.output.find((item) => item.type === 'compaction'),
        );
        const item = parsed.success ? parsed.data : compacted;
        const usage = reportedUsage(event.response.usage);
        if (!item)
          throw providerErrorFromCode('INVALID_RESPONSE', {
            invalidResponseStage: 'compaction_schema',
            usage,
          });
        return { items: [item], usage };
      }
    }
    throw providerErrorFromCode('INVALID_RESPONSE', { invalidResponseStage: 'compaction_schema' });
  }
}

export class CodexProvider implements Provider {
  private catalog: { token: string; at: number; models: readonly ProviderModel[] } | null = null;
  constructor(
    private readonly credentials: {
      getAccessToken(): Promise<string | undefined>;
      readonly credentialSync?: ProviderCredentialSync;
    },
    private readonly fetchPort: FetchPort = (input, init) => globalThis.fetch(input, init),
  ) {}

  get credentialSync(): ProviderCredentialSync | undefined {
    return this.credentials.credentialSync;
  }

  private async client(accessToken?: string, sessionId?: string): Promise<OpenAI> {
    const token = accessToken ?? (await this.credentials.getAccessToken());
    if (!token) throw providerErrorFromCode('AUTH');
    return new OpenAI({
      apiKey: token,
      baseURL: CODEX_RESPONSES_URL.replace(/\/responses$/, ''),
      defaultHeaders: {
        'ChatGPT-Account-ID': extractChatGptAccountId(token),
        ...(sessionId ? { 'session-id': sessionId } : {}),
      },
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
      timeout: 90_000,
      fetch: (input, init) => this.fetchPort(input, init),
    });
  }

  async getModel(selection: ModelSelection, sessionId?: string): Promise<CodexResponsesModel> {
    return new CodexResponsesModel(await this.client(undefined, sessionId), selection);
  }

  async listModels(signal: AbortSignal): Promise<readonly ProviderModel[]> {
    try {
      signal.throwIfAborted();
      const token = await this.credentials.getAccessToken();
      if (token && this.catalog?.token === token && Date.now() - this.catalog.at < 300_000)
        return this.catalog.models;
      const data = await (
        await this.client(token)
      ).get<unknown>('/models', {
        query: { client_version: CODEX_CATALOG_CLIENT_VERSION },
        signal,
      });
      const models = catalogSchema.parse(data).models.map((model) => ({
        id: model.slug,
        name: model.display_name ?? model.slug,
        ...(model.visibility === 'hide' ? { hidden: true } : {}),
        defaultReasoningEffort: model.default_reasoning_level,
        reasoningEfforts: model.supported_reasoning_levels.map((level) => level.effort),
        contextWindow: model.context_window,
      }));
      if (token) this.catalog = { token, at: Date.now(), models };
      return models;
    } catch (error) {
      return normalizeError(error);
    }
  }

  async compact(
    selection: ModelSelection,
    request: ModelRequest,
    sessionId?: string,
  ): Promise<Awaited<ReturnType<Provider['compact']>>> {
    try {
      return await (await this.getModel(selection, sessionId)).compact(request);
    } catch (error) {
      return normalizeError(error);
    }
  }
}
