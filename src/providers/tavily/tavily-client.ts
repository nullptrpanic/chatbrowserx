import { z } from 'zod';
import type { CredentialStore } from '../../persistence/credential-store';
import { isProviderError, providerErrorFromCode } from '../provider-errors';
import { throwTavilyHttpError } from './tavily-errors';
import type {
  TavilyCrawlInput,
  TavilyExtractInput,
  TavilyResult,
  TavilyResultSet,
  TavilyResultSource,
  TavilySearchInput,
} from './tavily-types';

export const TAVILY_ENDPOINTS = Object.freeze({
  search: 'https://api.tavily.com/search',
  extract: 'https://api.tavily.com/extract',
  crawl: 'https://api.tavily.com/crawl',
});

export const TAVILY_LIMITS = Object.freeze({
  searchResults: 8,
  extractUrls: 5,
  crawlDepth: 2,
  crawlBreadth: 10,
  resultTextCharacters: 12_000,
  totalCharacters: 40_000,
});

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Validates that Tavily receives only credential-free public HTTP(S) URLs. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

const httpUrlSchema = z.string().max(4_096).refine(isHttpUrl);
const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    maxResults: z.number().int().min(1).max(TAVILY_LIMITS.searchResults),
  })
  .strict();
const extractInputSchema = z
  .object({ urls: z.array(httpUrlSchema).min(1).max(TAVILY_LIMITS.extractUrls) })
  .strict();
const crawlInputSchema = z
  .object({
    url: httpUrlSchema,
    maxDepth: z.number().int().min(1).max(TAVILY_LIMITS.crawlDepth),
    maxBreadth: z.number().int().min(1).max(TAVILY_LIMITS.crawlBreadth),
  })
  .strict();

const searchResponseSchema = z
  .object({
    results: z.array(
      z
        .object({
          title: z.string(),
          url: z.string(),
          content: z.string(),
          score: z.number().finite().nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const contentResponseSchema = z
  .object({
    results: z.array(z.object({ url: z.string(), raw_content: z.string() }).passthrough()),
  })
  .passthrough();

interface RawResult {
  readonly title: string | null;
  readonly url: string;
  readonly content: string;
  readonly score: number | null;
}

/** Detects abort-shaped platform failures without retaining their unsafe messages. */
function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/** Normalizes and revalidates one URL before exposing it to the model. */
function normalizeUrl(value: string): string {
  if (!isHttpUrl(value)) throw providerErrorFromCode('INVALID_RESPONSE');
  return new URL(value).href;
}

/** Parses a bounded UTF-8 JSON response without allocating an unbounded text body. */
async function readJson(response: Response): Promise<unknown> {
  if (response.body === null) throw providerErrorFromCode('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw providerErrorFromCode('INVALID_RESPONSE');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}

/** Applies per-result and aggregate text limits while retaining stable source metadata. */
function normalizeResults(
  rawResults: readonly RawResult[],
  source: TavilyResultSource,
  resultLimit: number,
): TavilyResultSet {
  const results: TavilyResult[] = [];
  let totalCharacters = 0;
  let truncated = rawResults.length > resultLimit;
  for (const raw of rawResults.slice(0, resultLimit)) {
    const url = normalizeUrl(raw.url);
    const title = raw.title === null ? null : raw.title.slice(0, 500);
    if (raw.title !== null && title !== null && title.length !== raw.title.length) truncated = true;
    let content = raw.content.slice(0, TAVILY_LIMITS.resultTextCharacters);
    if (content.length !== raw.content.length) truncated = true;
    const remaining = TAVILY_LIMITS.totalCharacters - totalCharacters;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (content.length > remaining) {
      content = content.slice(0, remaining);
      truncated = true;
    }
    results.push({ title, url, content, score: raw.score, source });
    totalCharacters += content.length;
    if (totalCharacters >= TAVILY_LIMITS.totalCharacters && results.length < rawResults.length) {
      truncated = true;
      break;
    }
  }
  return { results, truncated };
}

export class TavilyClient {
  readonly #credentials: Pick<CredentialStore, 'getTavilyKey'>;
  readonly #fetch: FetchPort;

  /** Creates the bounded Tavily adapter around trusted credentials and injectable fetch. */
  constructor(
    credentials: Pick<CredentialStore, 'getTavilyKey'>,
    fetchPort: FetchPort = globalThis.fetch,
  ) {
    this.#credentials = credentials;
    this.#fetch = fetchPort;
  }

  /** Searches the public web using basic depth and a caller-bounded result count. */
  async search(input: TavilySearchInput, signal: AbortSignal): Promise<TavilyResultSet> {
    const parsed = searchInputSchema.safeParse(input);
    if (!parsed.success) throw providerErrorFromCode('INVALID_RESPONSE');
    const payload = await this.#post(
      TAVILY_ENDPOINTS.search,
      {
        query: parsed.data.query,
        search_depth: 'basic',
        max_results: parsed.data.maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        auto_parameters: false,
        safe_search: true,
      },
      signal,
    );
    const response = searchResponseSchema.safeParse(payload);
    if (!response.success) throw providerErrorFromCode('INVALID_RESPONSE');
    return normalizeResults(
      response.data.results.map((result) => ({
        title: result.title,
        url: result.url,
        content: result.content,
        score: result.score ?? null,
      })),
      'search',
      parsed.data.maxResults,
    );
  }

  /** Extracts bounded markdown from at most five validated public URLs. */
  async extract(input: TavilyExtractInput, signal: AbortSignal): Promise<TavilyResultSet> {
    const parsed = extractInputSchema.safeParse(input);
    if (!parsed.success) throw providerErrorFromCode('INVALID_RESPONSE');
    const urls = parsed.data.urls.map(normalizeUrl);
    const payload = await this.#post(
      TAVILY_ENDPOINTS.extract,
      {
        urls,
        extract_depth: 'basic',
        include_images: false,
        format: 'markdown',
      },
      signal,
    );
    const response = contentResponseSchema.safeParse(payload);
    if (!response.success) throw providerErrorFromCode('INVALID_RESPONSE');
    return normalizeResults(
      response.data.results.map((result) => ({
        title: null,
        url: result.url,
        content: result.raw_content,
        score: null,
      })),
      'extract',
      TAVILY_LIMITS.extractUrls,
    );
  }

  /** Crawls one validated public root with explicit depth, breadth, and total page limits. */
  async crawl(input: TavilyCrawlInput, signal: AbortSignal): Promise<TavilyResultSet> {
    const parsed = crawlInputSchema.safeParse(input);
    if (!parsed.success) throw providerErrorFromCode('INVALID_RESPONSE');
    const payload = await this.#post(
      TAVILY_ENDPOINTS.crawl,
      {
        url: normalizeUrl(parsed.data.url),
        max_depth: parsed.data.maxDepth,
        max_breadth: parsed.data.maxBreadth,
        limit: parsed.data.maxBreadth,
        allow_external: false,
        include_images: false,
        extract_depth: 'basic',
        format: 'markdown',
      },
      signal,
    );
    const response = contentResponseSchema.safeParse(payload);
    if (!response.success) throw providerErrorFromCode('INVALID_RESPONSE');
    return normalizeResults(
      response.data.results.map((result) => ({
        title: null,
        url: result.url,
        content: result.raw_content,
        score: null,
      })),
      'crawl',
      parsed.data.maxBreadth,
    );
  }

  /** Sends one authenticated JSON POST and returns only a bounded parsed response. */
  async #post(
    url: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) throw providerErrorFromCode('ABORTED');
    let apiKey: string | undefined;
    try {
      apiKey = await this.#credentials.getTavilyKey();
    } catch {
      throw providerErrorFromCode('AUTH');
    }
    if (!apiKey) throw providerErrorFromCode('AUTH');

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
    const contentType = response.headers.get('Content-Type');
    if (!contentType?.toLowerCase().includes('application/json')) {
      await response.body?.cancel().catch(() => undefined);
      throw providerErrorFromCode('INVALID_RESPONSE', { status: response.status });
    }
    try {
      return await readJson(response);
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) throw providerErrorFromCode('ABORTED');
      if (isProviderError(error)) throw error;
      throw providerErrorFromCode('TRANSIENT');
    }
  }
}
