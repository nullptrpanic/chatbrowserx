import { strictFunctionTool } from '../model-tool';
import { register } from '../register';
import type { ToolDeclaration, ToolExecutionPolicy, ToolRuntimeHooks } from '../types';
import { tavilyFailure } from './failure';
import {
  tavilyCrawlInputSchema,
  tavilyExtractInputSchema,
  tavilySearchInputSchema,
} from './input-schema';
import { tavilyService } from './service';
import type { TavilyCrawlInput, TavilyExtractInput, TavilySearchInput } from './types';

export const tavilySearchSchema = tavilySearchInputSchema;
export const tavilyExtractSchema = tavilyExtractInputSchema;
export const tavilyCrawlSchema = tavilyCrawlInputSchema;

const policy: ToolExecutionPolicy = {
  budgetGroup: 'tavily',
  budgetLabel: 'Tavily',
  maxCalls: 8,
  errorSource: 'tavily',
};
const domainArray = {
  type: 'array',
  maxItems: 5,
  items: { type: 'string', minLength: 1, maxLength: 253 },
} as const;

export const tavilySearchDefinition = strictFunctionTool(
  'tavily_search',
  'Search the public web with bounded quality, recency, and domain filters.',
  {
    query: { type: 'string', minLength: 1, maxLength: 2_000 },
    searchDepth: { type: 'string', enum: ['basic', 'advanced'] },
    topic: { type: 'string', enum: ['general', 'news', 'finance'] },
    timeRange: {
      type: 'string',
      enum: ['any', 'day', 'week', 'month', 'year'],
    },
    maxResults: { type: 'integer', minimum: 1, maximum: 8 },
    includeDomains: domainArray,
    excludeDomains: domainArray,
  },
);

export const tavilyExtractDefinition = strictFunctionTool(
  'tavily_extract',
  'Extract bounded Markdown content from one to five public web pages.',
  {
    urls: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: 4_096 },
    },
    query: { type: 'string', maxLength: 500 },
    extractDepth: { type: 'string', enum: ['basic', 'advanced'] },
  },
);

export const tavilyCrawlDefinition = strictFunctionTool(
  'tavily_crawl',
  'Crawl a bounded set of pages below one public website root.',
  {
    url: { type: 'string', minLength: 1, maxLength: 4_096 },
    instructions: { type: 'string', minLength: 1, maxLength: 1_000 },
    maxDepth: { type: 'integer', minimum: 1, maximum: 2 },
    maxPages: { type: 'integer', minimum: 1, maximum: 10 },
  },
);

export const tavilySearchTool: ToolDeclaration<TavilySearchInput> = {
  name: 'tavily_search',
  definition: tavilySearchDefinition,
  schema: tavilySearchSchema,
  order: 100,
  policy,
  available: (context) => context.tavilyConfigured === true,
  createCall: (call) => ({ ...call, operation: 'search' as const }),
  async execute(call, _context, services, signal) {
    const result = await services.get(tavilyService).search(call.arguments, signal);
    return { output: JSON.stringify({ ok: true, ...result }) };
  },
  failure: tavilyFailure,
};

export const tavilyExtractTool: ToolDeclaration<TavilyExtractInput> = {
  name: 'tavily_extract',
  definition: tavilyExtractDefinition,
  schema: tavilyExtractSchema,
  order: 101,
  policy,
  available: (context) => context.tavilyConfigured === true,
  createCall: (call) => ({ ...call, operation: 'extract' as const }),
  async execute(call, _context, services, signal) {
    const result = await services.get(tavilyService).extract(call.arguments, signal);
    return { output: JSON.stringify({ ok: true, ...result }) };
  },
  failure: tavilyFailure,
};

export const tavilyCrawlTool: ToolDeclaration<TavilyCrawlInput> = {
  name: 'tavily_crawl',
  definition: tavilyCrawlDefinition,
  schema: tavilyCrawlSchema,
  order: 102,
  policy,
  available: (context) => context.tavilyConfigured === true,
  createCall: (call) => ({ ...call, operation: 'crawl' as const }),
  async execute(call, _context, services, signal) {
    const result = await services.get(tavilyService).crawl(call.arguments, signal);
    return { output: JSON.stringify({ ok: true, ...result }) };
  },
  failure: tavilyFailure,
};

export const tavilyRuntime = {
  async prepare(context, services) {
    if (typeof context.tavilyConfigured === 'boolean') return {};
    const tavilyConfigured =
      services.has(tavilyService) &&
      (await services
        .get(tavilyService)
        .isConfigured()
        .catch(() => false));
    return { context: { tavilyConfigured } };
  },
} satisfies ToolRuntimeHooks;

register(tavilySearchTool, tavilyRuntime);
register(tavilyExtractTool, tavilyRuntime);
register(tavilyCrawlTool, tavilyRuntime);
