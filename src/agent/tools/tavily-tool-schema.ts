import type { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import {
  tavilyCrawlInputSchema,
  tavilyExtractInputSchema,
  tavilySearchInputSchema,
} from '../../providers/tavily/tavily-input-schema';
import { strictFunctionTool } from '../../tools/contracts/model-tool';
import {
  parseToolCallArguments,
  type ModelToolCallSource,
} from '../../tools/contracts/tool-call-envelope';

export const tavilySearchSchema = tavilySearchInputSchema;
export const tavilyExtractSchema = tavilyExtractInputSchema;
export const tavilyCrawlSchema = tavilyCrawlInputSchema;

export type TavilySearchToolInput = z.infer<typeof tavilySearchSchema>;
export type TavilyExtractToolInput = z.infer<typeof tavilyExtractSchema>;
export type TavilyCrawlToolInput = z.infer<typeof tavilyCrawlSchema>;

export type ParsedTavilyToolCall =
  | {
      readonly operation: 'search';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilySearchToolInput;
    }
  | {
      readonly operation: 'extract';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilyExtractToolInput;
    }
  | {
      readonly operation: 'crawl';
      readonly callId: string;
      readonly argumentsJson: string;
      readonly arguments: TavilyCrawlToolInput;
    };

const domainArrayJsonSchema = {
  type: 'array',
  maxItems: 5,
  items: { type: 'string', minLength: 1, maxLength: 253 },
} as const;

export const TAVILY_TOOL_DEFINITIONS = [
  strictFunctionTool(
    'tavily_search',
    'Search the public web with bounded quality, recency, and domain filters.',
    {
      query: { type: 'string', minLength: 1, maxLength: 2_000 },
      searchDepth: { type: 'string', enum: ['basic', 'advanced'] },
      topic: { type: 'string', enum: ['general', 'news', 'finance'] },
      timeRange: { type: 'string', enum: ['any', 'day', 'week', 'month', 'year'] },
      maxResults: { type: 'integer', minimum: 1, maximum: 8 },
      includeDomains: domainArrayJsonSchema,
      excludeDomains: domainArrayJsonSchema,
    },
  ),
  strictFunctionTool(
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
  ),
  strictFunctionTool(
    'tavily_crawl',
    'Crawl a bounded set of pages below one public website root.',
    {
      url: { type: 'string', minLength: 1, maxLength: 4_096 },
      instructions: { type: 'string', minLength: 1, maxLength: 1_000 },
      maxDepth: { type: 'integer', minimum: 1, maximum: 2 },
      maxPages: { type: 'integer', minimum: 1, maximum: 10 },
    },
  ),
];

export type TavilyToolCallSource = ModelToolCallSource;

/** Parses one model function call while replacing all unsafe validation details. */
export function parseTavilyToolCall(input: TavilyToolCallSource): ParsedTavilyToolCall {
  try {
    const value = parseToolCallArguments(input);
    switch (input.name) {
      case 'tavily_search':
        return {
          operation: 'search',
          callId: input.callId,
          argumentsJson: input.argumentsJson,
          arguments: tavilySearchSchema.parse(value),
        };
      case 'tavily_extract':
        return {
          operation: 'extract',
          callId: input.callId,
          argumentsJson: input.argumentsJson,
          arguments: tavilyExtractSchema.parse(value),
        };
      case 'tavily_crawl':
        return {
          operation: 'crawl',
          callId: input.callId,
          argumentsJson: input.argumentsJson,
          arguments: tavilyCrawlSchema.parse(value),
        };
      default:
        throw new Error('Unsupported tool.');
    }
  } catch {
    throw providerErrorFromCode('INVALID_RESPONSE');
  }
}
