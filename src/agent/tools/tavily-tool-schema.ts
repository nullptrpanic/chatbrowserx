import type { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import type { ModelToolDefinition } from '../../providers/provider-types';
import {
  tavilyCrawlInputSchema,
  tavilyExtractInputSchema,
  tavilySearchInputSchema,
} from '../../providers/tavily/tavily-input-schema';

const MAX_TOOL_CALL_ID_CHARACTERS = 256;
const MAX_TOOL_ARGUMENTS_JSON_CHARACTERS = 32 * 1_024;

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

export const TAVILY_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    type: 'function',
    name: 'tavily_search',
    description: 'Search the public web with bounded quality, recency, and domain filters.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2_000 },
        searchDepth: { type: 'string', enum: ['basic', 'advanced'] },
        topic: { type: 'string', enum: ['general', 'news', 'finance'] },
        timeRange: { type: 'string', enum: ['any', 'day', 'week', 'month', 'year'] },
        maxResults: { type: 'integer', minimum: 1, maximum: 8 },
        includeDomains: domainArrayJsonSchema,
        excludeDomains: domainArrayJsonSchema,
      },
      required: [
        'query',
        'searchDepth',
        'topic',
        'timeRange',
        'maxResults',
        'includeDomains',
        'excludeDomains',
      ],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'tavily_extract',
    description: 'Extract bounded Markdown content from one to five public web pages.',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'string', minLength: 1, maxLength: 4_096 },
        },
        query: { type: 'string', maxLength: 500 },
        extractDepth: { type: 'string', enum: ['basic', 'advanced'] },
      },
      required: ['urls', 'query', 'extractDepth'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'tavily_crawl',
    description: 'Crawl a bounded set of pages below one public website root.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 4_096 },
        instructions: { type: 'string', minLength: 1, maxLength: 1_000 },
        maxDepth: { type: 'integer', minimum: 1, maximum: 2 },
        maxPages: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['url', 'instructions', 'maxDepth', 'maxPages'],
      additionalProperties: false,
    },
    strict: true,
  },
];

export interface TavilyToolCallSource {
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
}

/** Parses one model function call while replacing all unsafe validation details. */
export function parseTavilyToolCall(input: TavilyToolCallSource): ParsedTavilyToolCall {
  try {
    if (
      input.callId.trim().length === 0 ||
      input.callId.length > MAX_TOOL_CALL_ID_CHARACTERS ||
      input.argumentsJson.length > MAX_TOOL_ARGUMENTS_JSON_CHARACTERS
    ) {
      throw new Error('Invalid tool call envelope.');
    }
    const value: unknown = JSON.parse(input.argumentsJson);
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
