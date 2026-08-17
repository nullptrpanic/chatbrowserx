import { z } from 'zod';
import type { CredentialStore } from '../../persistence/credential-store';
import { isPublicHttpUrl } from '../../shared/net/public-http-url';
import { isProviderError, providerErrorFromCode } from '../provider-errors';
import { throwTavilyHttpError } from './tavily-errors';
import type {
  TavilyCrawlInput,
  TavilyExecutionPort,
  TavilyExtractInput,
  TavilyResult,
  TavilyResultSet,
  TavilySearchInput,
} from './tavily-types';

const TAVILY_ENDPOINTS = {
  search: 'https://api.tavily.com/search',
  extract: 'https://api.tavily.com/extract',
  crawl: 'https://api.tavily.com/crawl',
} as const;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_CONTENT_CHARACTERS = 12_000;
const MAX_RESULT_SET_CONTENT_CHARACTERS = 40_000;
const MAX_RESULT_TITLE_CHARACTERS = 500;
const MAX_RESULT_URL_CHARACTERS = 4_096;

export type TavilyFetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((value) => value === value.trim() && !/[:/@*\s]/.test(value))
  .transform((value) => value.toLowerCase().replace(/\.$/, ''))
  .refine((value) => isPublicHttpUrl(`https://${value}`));
const domainsSchema = z
  .array(domainSchema)
  .max(5)
  .refine((value) => new Set(value).size === value.length);
const publicUrlSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isPublicHttpUrl)
  .transform((value) => new URL(value).href);
const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    searchDepth: z.enum(['basic', 'advanced']),
    topic: z.enum(['general', 'news', 'finance']),
    timeRange: z.enum(['any', 'day', 'week', 'month', 'year']),
    maxResults: z.number().int().min(1).max(8),
    includeDomains: domainsSchema,
    excludeDomains: domainsSchema,
  })
  .strict()
  .refine((value) => !value.includeDomains.some((domain) => value.excludeDomains.includes(domain)));
const extractInputSchema = z
  .object({
    urls: z
      .array(publicUrlSchema)
      .min(1)
      .max(5)
      .refine((value) => new Set(value).size === value.length),
    query: z.string().trim().max(500),
    extractDepth: z.enum(['basic', 'advanced']),
  })
  .strict();
const crawlInputSchema = z
  .object({
    url: publicUrlSchema,
    instructions: z.string().trim().min(1).max(1_000),
    maxDepth: z.number().int().min(1).max(2),
    maxPages: z.number().int().min(1).max(10),
  })
  .strict();

const responseEnvelopeSchema = z.object({ results: z.array(z.unknown()).max(1_000) }).passthrough();
const searchResultSchema = z
  .object({
    title: z.string().nullable().optional(),
    url: z.string().min(1).max(MAX_RESULT_URL_CHARACTERS),
    content: z.string(),
    score: z.number().finite().nullable().optional(),
  })
  .passthrough();
const contentResultSchema = z
  .object({
    title: z.string().nullable().optional(),
    url: z.string().min(1).max(MAX_RESULT_URL_CHARACTERS),
    raw_content: z.string(),
  })
  .passthrough();

interface NormalizedSourceResult {
  readonly title: string | null;
  readonly url: string;
  readonly content: string;
  readonly score: number | null;
}

/** Detects abort-shaped platform failures without retaining their messages. */
function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/** Reads one success body under a byte cap before decoding and parsing JSON. */
async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw providerErrorFromCode('INVALID_RESPONSE', { status: response.status });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw providerErrorFromCode('ABORTED');
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw providerErrorFromCode('INVALID_RESPONSE', { status: response.status });
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (isProviderError(error)) throw error;
    if (signal.aborted || isAbortFailure(error)) throw providerErrorFromCode('ABORTED');
    throw providerErrorFromCode('TRANSIENT');
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE', { status: response.status });
  }
}

/** Applies count, title, per-result, and aggregate context bounds in source order. */
function normalizeResults(
  values: readonly NormalizedSourceResult[],
  source: TavilyResult['source'],
  maxResults: number,
): TavilyResultSet {
  const results: TavilyResult[] = [];
  let remaining = MAX_RESULT_SET_CONTENT_CHARACTERS;
  let truncated = values.length > maxResults;

  for (const value of values.slice(0, maxResults)) {
    if (!isPublicHttpUrl(value.url)) throw providerErrorFromCode('INVALID_RESPONSE');
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const title = value.title?.slice(0, MAX_RESULT_TITLE_CHARACTERS) ?? null;
    const contentLimit = Math.min(MAX_RESULT_CONTENT_CHARACTERS, remaining);
    const content = value.content.slice(0, contentLimit);
    if (
      (value.title !== null && value.title.length > MAX_RESULT_TITLE_CHARACTERS) ||
      value.content.length > content.length
    ) {
      truncated = true;
    }
    results.push({
      title,
      url: new URL(value.url).href,
      content,
      score: value.score,
      source,
    });
    remaining -= content.length;
  }

  return { results, truncated };
}

function parseSearchResults(value: unknown, maxResults: number): TavilyResultSet {
  const envelope = responseEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw providerErrorFromCode('INVALID_RESPONSE');
  const results = envelope.data.results.map((item) => {
    const parsed = searchResultSchema.safeParse(item);
    if (!parsed.success) throw providerErrorFromCode('INVALID_RESPONSE');
    return {
      title: parsed.data.title ?? null,
      url: parsed.data.url,
      content: parsed.data.content,
      score: parsed.data.score ?? null,
    };
  });
  return normalizeResults(results, 'search', maxResults);
}

function parseContentResults(
  value: unknown,
  source: 'extract' | 'crawl',
  maxResults: number,
): TavilyResultSet {
  const envelope = responseEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw providerErrorFromCode('INVALID_RESPONSE');
  const results = envelope.data.results.map((item) => {
    const parsed = contentResultSchema.safeParse(item);
    if (!parsed.success) throw providerErrorFromCode('INVALID_RESPONSE');
    return {
      title: parsed.data.title ?? null,
      url: parsed.data.url,
      content: parsed.data.raw_content,
      score: null,
    };
  });
  return normalizeResults(results, source, maxResults);
}

export class TavilyClient implements TavilyExecutionPort {
  readonly #credentials: Pick<CredentialStore, 'getTavilyKey'>;
  readonly #fetch: TavilyFetchPort;

  constructor(
    credentials: Pick<CredentialStore, 'getTavilyKey'>,
    fetchPort: TavilyFetchPort = globalThis.fetch,
  ) {
    this.#credentials = credentials;
    this.#fetch = (input, init) => fetchPort(input, init);
  }

  async search(input: TavilySearchInput, signal: AbortSignal): Promise<TavilyResultSet> {
    const parsed = this.#parseInput(searchInputSchema, input);
    const body = {
      query: parsed.query,
      search_depth: parsed.searchDepth,
      ...(parsed.searchDepth === 'advanced' ? { chunks_per_source: 3 } : {}),
      max_results: parsed.maxResults,
      topic: parsed.topic,
      ...(parsed.timeRange === 'any' ? {} : { time_range: parsed.timeRange }),
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_image_descriptions: false,
      include_favicon: false,
      include_domains: parsed.includeDomains,
      exclude_domains: parsed.excludeDomains,
      auto_parameters: false,
      exact_match: false,
      include_usage: true,
      safe_search: true,
    };
    const result = await this.#request(TAVILY_ENDPOINTS.search, body, signal);
    return parseSearchResults(result, parsed.maxResults);
  }

  async extract(input: TavilyExtractInput, signal: AbortSignal): Promise<TavilyResultSet> {
    const parsed = this.#parseInput(extractInputSchema, input);
    const body = {
      urls: parsed.urls,
      ...(parsed.query.length === 0 ? {} : { query: parsed.query, chunks_per_source: 3 }),
      extract_depth: parsed.extractDepth,
      format: 'markdown',
      include_images: false,
      include_favicon: false,
      timeout: 30,
      include_usage: true,
    };
    const result = await this.#request(TAVILY_ENDPOINTS.extract, body, signal);
    return parseContentResults(result, 'extract', parsed.urls.length);
  }

  async crawl(input: TavilyCrawlInput, signal: AbortSignal): Promise<TavilyResultSet> {
    const parsed = this.#parseInput(crawlInputSchema, input);
    const body = {
      url: parsed.url,
      instructions: parsed.instructions,
      chunks_per_source: 3,
      max_depth: parsed.maxDepth,
      limit: parsed.maxPages,
      max_breadth: Math.min(parsed.maxPages, 10),
      allow_external: false,
      include_images: false,
      extract_depth: 'basic',
      format: 'markdown',
      include_favicon: false,
      timeout: 60,
      include_usage: true,
    };
    const result = await this.#request(TAVILY_ENDPOINTS.crawl, body, signal);
    return parseContentResults(result, 'crawl', parsed.maxPages);
  }

  #parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw providerErrorFromCode('INVALID_RESPONSE');
    return parsed.data;
  }

  async #request(
    endpoint: (typeof TAVILY_ENDPOINTS)[keyof typeof TAVILY_ENDPOINTS],
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw providerErrorFromCode('ABORTED');

    let key: string | undefined;
    try {
      key = await this.#credentials.getTavilyKey();
    } catch {
      throw providerErrorFromCode('AUTH');
    }
    if (!key || key.trim().length === 0) throw providerErrorFromCode('AUTH');

    let response: Response;
    try {
      response = await this.#fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key.trim()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) throw providerErrorFromCode('ABORTED');
      throw providerErrorFromCode('TRANSIENT');
    }

    if (!response.ok) return await throwTavilyHttpError(response);
    if (signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      throw providerErrorFromCode('ABORTED');
    }
    return readBoundedJson(response, signal);
  }
}
