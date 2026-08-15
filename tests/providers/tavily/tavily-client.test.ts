import { describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '../../../src/persistence/credential-store';
import {
  TAVILY_ENDPOINTS,
  TAVILY_LIMITS,
  TavilyClient,
} from '../../../src/providers/tavily/tavily-client';

const TAVILY_KEY = 'tvly-synthetic-test-key';

/** Creates a trusted credential port for Tavily adapter tests. */
function credentialStore(key?: string): CredentialStore {
  return {
    initialize: vi.fn(async () => undefined),
    getCodexAccessToken: vi.fn(async () => undefined),
    setCodexAccessToken: vi.fn(async () => undefined),
    getTavilyKey: vi.fn(async () => key),
    setTavilyKey: vi.fn(async () => undefined),
  };
}

/** Creates a JSON response with the production content type. */
function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });
}

describe('TavilyClient', () => {
  it('uses the fixed Search endpoint, bearer auth, and strict output limits', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: Array.from({ length: 10 }, (_, index) => ({
          title: `Result ${String(index)}`,
          url: `https://example.test/${String(index)}`,
          content: `${String(index)}${'x'.repeat(13_000)}`,
          score: 0.9,
        })),
      }),
    );
    const client = new TavilyClient(credentialStore(TAVILY_KEY), fetchMock);

    const result = await client.search(
      { query: 'browser reliability', maxResults: 8 },
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(TAVILY_ENDPOINTS.search);
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TAVILY_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      query: 'browser reliability',
      search_depth: 'basic',
      max_results: 8,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      auto_parameters: false,
      safe_search: true,
    });
    expect(body).not.toHaveProperty('api_key');
    expect(result.results.length).toBeLessThanOrEqual(TAVILY_LIMITS.searchResults);
    expect(result.results[0]).toMatchObject({
      title: 'Result 0',
      url: 'https://example.test/0',
      score: 0.9,
      source: 'search',
    });
    expect(result.results.every((item) => item.content.length <= 12_000)).toBe(true);
    expect(result.results.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(
      40_000,
    );
    expect(result.truncated).toBe(true);
  });

  it('uses bounded Extract and Crawl request contracts', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { url: 'https://example.test/a', raw_content: 'Extracted A' },
            { url: 'https://example.test/b', raw_content: 'Extracted B' },
          ],
          failed_results: [],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          base_url: 'example.test',
          results: [{ url: 'https://example.test/docs', raw_content: 'Crawled docs' }],
        }),
      );
    const client = new TavilyClient(credentialStore(TAVILY_KEY), fetchMock);

    await expect(
      client.extract(
        { urls: ['https://example.test/a', 'https://example.test/b'] },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      results: [
        {
          title: null,
          url: 'https://example.test/a',
          content: 'Extracted A',
          score: null,
          source: 'extract',
        },
        {
          title: null,
          url: 'https://example.test/b',
          content: 'Extracted B',
          score: null,
          source: 'extract',
        },
      ],
      truncated: false,
    });
    await expect(
      client.crawl(
        { url: 'https://example.test', maxDepth: 2, maxBreadth: 10 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      results: [{ source: 'crawl', url: 'https://example.test/docs', content: 'Crawled docs' }],
      truncated: false,
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      TAVILY_ENDPOINTS.extract,
      TAVILY_ENDPOINTS.crawl,
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      urls: ['https://example.test/a', 'https://example.test/b'],
      extract_depth: 'basic',
      include_images: false,
      format: 'markdown',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      url: 'https://example.test/',
      max_depth: 2,
      max_breadth: 10,
      limit: 10,
      allow_external: false,
      include_images: false,
      extract_depth: 'basic',
      format: 'markdown',
    });
  });

  it.each([
    () => ({ urls: ['file:///etc/passwd'] }),
    () => ({ urls: Array.from({ length: 6 }, (_, index) => `https://example.test/${index}`) }),
  ])('rejects invalid extract input before reading credentials or fetching', async (input) => {
    const credentials = credentialStore(TAVILY_KEY);
    const fetchMock = vi.fn<typeof fetch>();
    const client = new TavilyClient(credentials, fetchMock);

    await expect(client.extract(input(), new AbortController().signal)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(credentials.getTavilyKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes missing credentials and aborts without a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const noKeyClient = new TavilyClient(credentialStore(), fetchMock);
    await expect(
      noKeyClient.search({ query: 'test', maxResults: 1 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AUTH' });

    const controller = new AbortController();
    controller.abort();
    const abortedClient = new TavilyClient(credentialStore(TAVILY_KEY), fetchMock);
    await expect(
      abortedClient.search({ query: 'test', maxResults: 1 }, controller.signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'AUTH', false],
    [429, 'RATE_LIMIT', true],
    [503, 'TRANSIENT', true],
    [400, 'INVALID_RESPONSE', false],
  ] as const)(
    'normalizes HTTP %s without exposing key or body',
    async (status, code, retryable) => {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        jsonResponse(
          { detail: { error: `unsafe ${TAVILY_KEY}` } },
          status,
          status === 429 ? { 'Retry-After': '3' } : {},
        ),
      );
      const client = new TavilyClient(credentialStore(TAVILY_KEY), fetchMock);

      let thrown: unknown;
      try {
        await client.search({ query: 'test', maxResults: 1 }, new AbortController().signal);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code,
        retryable,
        status,
        retryAfterMs: status === 429 ? 3_000 : null,
      });
      expect(String(thrown)).not.toContain(TAVILY_KEY);
    },
  );

  it('normalizes network aborts, invalid JSON, and unsafe upstream URLs', async () => {
    const abortedFetch = vi.fn<typeof fetch>(async () => {
      throw new DOMException('unsafe abort detail', 'AbortError');
    });
    await expect(
      new TavilyClient(credentialStore(TAVILY_KEY), abortedFetch).search(
        { query: 'test', maxResults: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });

    const invalidJson = vi.fn<typeof fetch>(
      async () =>
        new Response('{broken', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      new TavilyClient(credentialStore(TAVILY_KEY), invalidJson).search(
        { query: 'test', maxResults: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const unsafeUrl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [{ title: 'Unsafe', url: 'javascript:alert(1)', content: 'bad', score: 1 }],
      }),
    );
    await expect(
      new TavilyClient(credentialStore(TAVILY_KEY), unsafeUrl).search(
        { query: 'test', maxResults: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
