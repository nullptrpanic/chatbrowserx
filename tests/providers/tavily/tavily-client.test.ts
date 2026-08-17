import { describe, expect, it, vi } from 'vitest';
import { TavilyClient, type TavilyFetchPort } from '../../../src/providers/tavily/tavily-client';

const SIGNAL = new AbortController().signal;

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function createClient(fetch: TavilyFetchPort, key = 'synthetic-tavily-key'): TavilyClient {
  return new TavilyClient({ getTavilyKey: vi.fn(async () => key) }, fetch);
}

describe('TavilyClient requests', () => {
  it('builds the fixed advanced search request without putting the key in the body', async () => {
    const fetch = vi.fn<TavilyFetchPort>(async () => jsonResponse({ results: [] }));
    const client = createClient(fetch);

    await client.search(
      {
        query: 'browser reliability',
        searchDepth: 'advanced',
        topic: 'general',
        timeRange: 'month',
        maxResults: 8,
        includeDomains: ['example.com'],
        excludeDomains: [],
      },
      SIGNAL,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer synthetic-tavily-key',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: SIGNAL,
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'browser reliability',
      search_depth: 'advanced',
      chunks_per_source: 3,
      max_results: 8,
      topic: 'general',
      time_range: 'month',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_image_descriptions: false,
      include_favicon: false,
      include_domains: ['example.com'],
      exclude_domains: [],
      auto_parameters: false,
      exact_match: false,
      include_usage: true,
      safe_search: true,
    });
    expect(String(init?.body)).not.toContain('synthetic-tavily-key');
  });

  it('omits optional Tavily fields when search and extract sentinels are selected', async () => {
    const fetch = vi.fn<TavilyFetchPort>(async () => jsonResponse({ results: [] }));
    const client = createClient(fetch);

    await client.search(
      {
        query: 'browser reliability',
        searchDepth: 'basic',
        topic: 'news',
        timeRange: 'any',
        maxResults: 3,
        includeDomains: [],
        excludeDomains: ['spam.example'],
      },
      SIGNAL,
    );
    await client.extract(
      {
        urls: ['https://example.com/a'],
        query: '',
        extractDepth: 'basic',
      },
      SIGNAL,
    );

    const searchBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(searchBody).not.toHaveProperty('time_range');
    expect(searchBody).not.toHaveProperty('chunks_per_source');
    const extractBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.tavily.com/extract');
    expect(extractBody).toEqual({
      urls: ['https://example.com/a'],
      extract_depth: 'basic',
      format: 'markdown',
      include_images: false,
      include_favicon: false,
      timeout: 30,
      include_usage: true,
    });
  });

  it('maps extract reranking and bounded crawl controls exactly', async () => {
    const fetch = vi.fn<TavilyFetchPort>(async () => jsonResponse({ results: [] }));
    const client = createClient(fetch);

    await client.extract(
      {
        urls: ['https://example.com/a', 'https://example.com/b'],
        query: 'authentication details',
        extractDepth: 'advanced',
      },
      SIGNAL,
    );
    await client.crawl(
      {
        url: 'https://docs.example.com/',
        instructions: 'Find authentication API documentation.',
        maxDepth: 2,
        maxPages: 7,
      },
      SIGNAL,
    );

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      urls: ['https://example.com/a', 'https://example.com/b'],
      query: 'authentication details',
      chunks_per_source: 3,
      extract_depth: 'advanced',
      format: 'markdown',
      include_images: false,
      include_favicon: false,
      timeout: 30,
      include_usage: true,
    });
    expect(fetch.mock.calls[1]?.[0]).toBe('https://api.tavily.com/crawl');
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      url: 'https://docs.example.com/',
      instructions: 'Find authentication API documentation.',
      chunks_per_source: 3,
      max_depth: 2,
      limit: 7,
      max_breadth: 7,
      allow_external: false,
      include_images: false,
      extract_depth: 'basic',
      format: 'markdown',
      include_favicon: false,
      timeout: 60,
      include_usage: true,
    });
  });
});

describe('TavilyClient response normalization', () => {
  it('normalizes search fields and enforces per-result and aggregate character limits', async () => {
    const fetch = vi.fn<TavilyFetchPort>(async () =>
      jsonResponse({
        results: Array.from({ length: 5 }, (_, index) => ({
          title: index === 0 ? 't'.repeat(501) : `Result ${index}`,
          url: `https://example.com/${index}`,
          content: String(index).repeat(15_000),
          score: 1 - index / 10,
          raw_content: 'must-not-be-exposed',
        })),
        request_id: 'must-not-be-exposed',
        usage: { credits: 999 },
      }),
    );
    const client = createClient(fetch);

    const result = await client.search(
      {
        query: 'bounded output',
        searchDepth: 'advanced',
        topic: 'general',
        timeRange: 'any',
        maxResults: 8,
        includeDomains: [],
        excludeDomains: [],
      },
      SIGNAL,
    );

    expect(result.truncated).toBe(true);
    expect(result.results).toHaveLength(4);
    expect(result.results.map(({ content }) => content.length)).toEqual([
      12_000, 12_000, 12_000, 4_000,
    ]);
    expect(result.results[0]).toMatchObject({
      title: 't'.repeat(500),
      url: 'https://example.com/0',
      score: 1,
      source: 'search',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-be-exposed');
  });

  it('uses only raw_content for extract and crawl results', async () => {
    const fetch = vi
      .fn<TavilyFetchPort>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              url: 'https://example.com/a',
              raw_content: '# Extracted',
              content: 'wrong-field',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ url: 'https://example.com/b', raw_content: '# Crawled' }],
        }),
      );
    const client = createClient(fetch);

    const extracted = await client.extract(
      { urls: ['https://example.com/a'], query: '', extractDepth: 'basic' },
      SIGNAL,
    );
    const crawled = await client.crawl(
      {
        url: 'https://example.com/',
        instructions: 'Find docs.',
        maxDepth: 1,
        maxPages: 1,
      },
      SIGNAL,
    );

    expect(extracted).toEqual({
      results: [
        {
          title: null,
          url: 'https://example.com/a',
          content: '# Extracted',
          score: null,
          source: 'extract',
        },
      ],
      truncated: false,
    });
    expect(crawled.results[0]).toMatchObject({ content: '# Crawled', source: 'crawl' });
  });

  it.each([
    [new Response('plain text', { headers: { 'Content-Type': 'text/plain' } })],
    [new Response('{broken', { headers: { 'Content-Type': 'application/json' } })],
    [jsonResponse({ answer: 'missing results' })],
    [jsonResponse({ results: [{ url: 'http://127.0.0.1/private', content: 'unsafe' }] })],
    [
      jsonResponse({
        results: [{ url: `https://example.com/${'a'.repeat(4_096)}`, content: 'too long' }],
      }),
    ],
    [
      new Response('x'.repeat(2 * 1024 * 1024 + 1), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ],
  ])('rejects malformed, unsafe, or oversized success responses', async (response) => {
    const client = createClient(vi.fn(async () => response));

    await expect(
      client.search(
        {
          query: 'invalid response',
          searchDepth: 'basic',
          topic: 'general',
          timeRange: 'any',
          maxResults: 5,
          includeDomains: [],
          excludeDomains: [],
        },
        SIGNAL,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('TavilyClient failures', () => {
  it('requires a key before making a request', async () => {
    const fetch = vi.fn<TavilyFetchPort>();
    const client = createClient(fetch, '');

    await expect(
      client.search(
        {
          query: 'missing key',
          searchDepth: 'basic',
          topic: 'general',
          timeRange: 'any',
          maxResults: 5,
          includeDomains: [],
          excludeDomains: [],
        },
        SIGNAL,
      ),
    ).rejects.toMatchObject({ code: 'AUTH' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'AUTH', null],
    [403, 'AUTH', null],
    [429, 'RATE_LIMIT', 3_000],
    [503, 'TRANSIENT', null],
    [400, 'INVALID_RESPONSE', null],
  ] as const)('maps HTTP %s to %s without leaking its body', async (status, code, retryAfterMs) => {
    const secret = 'unsafe-upstream-secret';
    const client = createClient(
      vi.fn(
        async () =>
          new Response(secret, {
            status,
            headers: status === 429 ? { 'Retry-After': '3' } : {},
          }),
      ),
    );
    let thrown: unknown;

    try {
      await client.extract(
        { urls: ['https://example.com/a'], query: '', extractDepth: 'basic' },
        SIGNAL,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code, retryAfterMs });
    expect(String(thrown)).not.toContain(secret);
  });

  it('maps aborted and other fetch failures without exposing thrown messages', async () => {
    const secret = 'unsafe-network-secret';
    const aborted = createClient(
      vi.fn(async () => {
        throw new DOMException(secret, 'AbortError');
      }),
    );
    const transient = createClient(
      vi.fn(async () => {
        throw new Error(secret);
      }),
    );

    await expect(
      aborted.extract(
        { urls: ['https://example.com/a'], query: '', extractDepth: 'basic' },
        SIGNAL,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(
      transient.extract(
        { urls: ['https://example.com/a'], query: '', extractDepth: 'basic' },
        SIGNAL,
      ),
    ).rejects.toMatchObject({ code: 'TRANSIENT' });
  });

  it('rejects invalid provider-boundary input before reading credentials or fetching', async () => {
    const getTavilyKey = vi.fn(async () => 'synthetic-tavily-key');
    const fetch = vi.fn<TavilyFetchPort>();
    const client = new TavilyClient({ getTavilyKey }, fetch);

    await expect(
      client.crawl(
        {
          url: 'http://localhost:3000/',
          instructions: 'Read local data.',
          maxDepth: 2,
          maxPages: 10,
        },
        SIGNAL,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(getTavilyKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes provider-boundary domains before checking filter overlap', async () => {
    const getTavilyKey = vi.fn(async () => 'synthetic-tavily-key');
    const fetch = vi.fn<TavilyFetchPort>(async () => jsonResponse({ results: [] }));
    const client = new TavilyClient({ getTavilyKey }, fetch);

    await expect(
      client.search(
        {
          query: 'overlapping filters',
          searchDepth: 'basic',
          topic: 'general',
          timeRange: 'any',
          maxResults: 5,
          includeDomains: ['EXAMPLE.com'],
          excludeDomains: ['example.com'],
        },
        SIGNAL,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(getTavilyKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('normalizes provider-boundary URLs before checking uniqueness', async () => {
    const getTavilyKey = vi.fn(async () => 'synthetic-tavily-key');
    const fetch = vi.fn<TavilyFetchPort>(async () => jsonResponse({ results: [] }));
    const client = new TavilyClient({ getTavilyKey }, fetch);

    await expect(
      client.extract(
        {
          urls: ['https://example.com', 'https://example.com/'],
          query: '',
          extractDepth: 'basic',
        },
        SIGNAL,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(getTavilyKey).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
