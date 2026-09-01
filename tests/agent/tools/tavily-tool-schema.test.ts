import { describe, expect, it } from 'vitest';
import {
  tavilyCrawlDefinition,
  tavilyCrawlSchema,
  tavilyCrawlTool,
  tavilyExtractDefinition,
  tavilyExtractSchema,
  tavilyExtractTool,
  tavilyRuntime,
  tavilySearchDefinition,
  tavilySearchSchema,
  tavilySearchTool,
} from '../../../src/tools/tavily/tool';
import { ToolDeclarationCatalog } from '../../../src/tools/register';
import { bindToolRuntime } from '../../../src/tools/registry';
import { ToolServiceResolver } from '../../../src/tools/service-resolver';

const TAVILY_TOOL_DEFINITIONS = [
  tavilySearchDefinition,
  tavilyExtractDefinition,
  tavilyCrawlDefinition,
];

const catalog = new ToolDeclarationCatalog();
catalog.register(tavilySearchTool, tavilyRuntime);
catalog.register(tavilyExtractTool, tavilyRuntime);
catalog.register(tavilyCrawlTool, tavilyRuntime);
const runtime = bindToolRuntime(catalog.seal(), new ToolServiceResolver());

const SEARCH = {
  query: 'latest browser automation reliability research',
  searchDepth: 'advanced',
  topic: 'general',
  timeRange: 'month',
  maxResults: 8,
  includeDomains: ['Example.COM'],
  excludeDomains: [],
} as const;

const EXTRACT = {
  urls: ['https://example.com/a', 'https://example.com/b'],
  query: 'authentication details',
  extractDepth: 'basic',
} as const;

const CRAWL = {
  url: 'https://docs.example.com/',
  instructions: 'Find authentication API documentation.',
  maxDepth: 2,
  maxPages: 10,
} as const;

describe('Tavily tool schemas', () => {
  it('normalizes the approved search contract', () => {
    expect(tavilySearchSchema.parse(SEARCH)).toEqual({
      ...SEARCH,
      includeDomains: ['example.com'],
    });
  });

  it('accepts the approved extract and crawl contracts', () => {
    expect(tavilyExtractSchema.parse(EXTRACT)).toEqual(EXTRACT);
    expect(tavilyCrawlSchema.parse(CRAWL)).toEqual(CRAWL);
  });

  it.each([
    [{ ...SEARCH, maxResults: 9 }],
    [{ ...SEARCH, extra: true }],
    [{ ...SEARCH, timeRange: undefined }],
    [{ ...SEARCH, includeDomains: ['https://example.com'] }],
    [
      {
        ...SEARCH,
        includeDomains: ['example.com'],
        excludeDomains: ['EXAMPLE.COM'],
      },
    ],
    [
      {
        ...SEARCH,
        includeDomains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'],
      },
    ],
  ])('rejects an invalid search payload', (value) => {
    expect(tavilySearchSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    [{ ...EXTRACT, urls: [] }],
    [
      {
        ...EXTRACT,
        urls: Array.from({ length: 6 }, (_, index) => `https://e${index}.com`),
      },
    ],
    [{ ...EXTRACT, urls: ['http://127.0.0.1/private'] }],
    [{ ...EXTRACT, urls: ['https://user:pass@example.com/private'] }],
    [{ ...EXTRACT, query: 'x'.repeat(501) }],
    [{ ...EXTRACT, extra: true }],
  ])('rejects an invalid extract payload', (value) => {
    expect(tavilyExtractSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    [{ ...CRAWL, url: 'http://localhost:3000' }],
    [{ ...CRAWL, instructions: ' ' }],
    [{ ...CRAWL, maxDepth: 3 }],
    [{ ...CRAWL, maxPages: 11 }],
    [{ ...CRAWL, extra: true }],
  ])('rejects an invalid crawl payload', (value) => {
    expect(tavilyCrawlSchema.safeParse(value).success).toBe(false);
  });
});

describe('TAVILY_TOOL_DEFINITIONS', () => {
  it('exposes only the three strict underscore-named contracts', () => {
    expect(TAVILY_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
    ]);
    for (const definition of TAVILY_TOOL_DEFINITIONS) {
      expect(definition.strict).toBe(true);
      expect(definition.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      const parameters = definition.parameters as {
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required: readonly string[];
      };
      expect(parameters.required).toEqual(Object.keys(parameters.properties));
    }
  });

  it('omits JSON Schema keywords unsupported by the function-tool contract', () => {
    expect(JSON.stringify(TAVILY_TOOL_DEFINITIONS)).not.toContain('"uniqueItems"');
  });
});

describe('registered Tavily tool parsing', () => {
  it('returns a typed, normalized search call', async () => {
    const contract = await runtime.contract({ tavilyConfigured: true });
    expect(
      contract.parse({
        callId: 'call_1',
        name: 'tavily_search',
        argumentsJson: JSON.stringify(SEARCH),
      }),
    ).toEqual({
      operation: 'search',
      callId: 'call_1',
      name: 'tavily_search',
      argumentsJson: JSON.stringify(SEARCH),
      arguments: { ...SEARCH, includeDomains: ['example.com'] },
    });
  });

  it.each([
    {
      callId: 'call_1',
      name: 'tavily.search',
      argumentsJson: JSON.stringify(SEARCH),
    },
    { callId: 'call_1', name: 'browser_act', argumentsJson: '{}' },
    {
      callId: '',
      name: 'tavily_search',
      argumentsJson: JSON.stringify(SEARCH),
    },
    {
      callId: 'c'.repeat(257),
      name: 'tavily_search',
      argumentsJson: JSON.stringify(SEARCH),
    },
    { callId: 'call_1', name: 'tavily_search', argumentsJson: '{secret-value' },
    {
      callId: 'call_1',
      name: 'tavily_search',
      argumentsJson: `${' '.repeat(32 * 1_024)}${JSON.stringify(SEARCH)}`,
    },
    {
      callId: 'call_1',
      name: 'tavily_search',
      argumentsJson: JSON.stringify({ ...SEARCH, query: '' }),
    },
  ])('rejects unsupported or malformed calls', async (input) => {
    const contract = await runtime.contract({ tavilyConfigured: true });
    expect(() => contract.parse(input)).toThrow();
  });
});
