import { z } from 'zod';
import { providerErrorFromCode } from '../../providers/provider-errors';
import type { ModelToolDefinition } from '../../providers/provider-types';
import { isPublicHttpUrl } from '../../shared/net/public-http-url';

const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;
const MAX_TOOL_CALL_ID_CHARACTERS = 256;
const MAX_TOOL_ARGUMENTS_JSON_CHARACTERS = 32 * 1_024;

const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((value) => value.trim() === value && !/[:/@*\s]/.test(value))
  .refine((value) => DOMAIN_PATTERN.test(value))
  .transform((value) => value.toLowerCase().replace(/\.$/, ''))
  .refine((value) => isPublicHttpUrl(`https://${value}`));

const domainArraySchema = z
  .array(domainSchema)
  .max(5)
  .superRefine((domains, context) => {
    if (new Set(domains).size !== domains.length) {
      context.addIssue({ code: 'custom', message: 'Domains must be unique.' });
    }
  });

const publicUrlSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isPublicHttpUrl)
  .transform((value) => new URL(value).href);

export const tavilySearchSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    searchDepth: z.enum(['basic', 'advanced']),
    topic: z.enum(['general', 'news', 'finance']),
    timeRange: z.enum(['any', 'day', 'week', 'month', 'year']),
    maxResults: z.number().int().min(1).max(8),
    includeDomains: domainArraySchema,
    excludeDomains: domainArraySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const excluded = new Set(value.excludeDomains);
    if (value.includeDomains.some((domain) => excluded.has(domain))) {
      context.addIssue({ code: 'custom', message: 'Domain filters must not overlap.' });
    }
  });

export const tavilyExtractSchema = z
  .object({
    urls: z
      .array(publicUrlSchema)
      .min(1)
      .max(5)
      .superRefine((urls, context) => {
        if (new Set(urls).size !== urls.length) {
          context.addIssue({ code: 'custom', message: 'URLs must be unique.' });
        }
      }),
    query: z.string().trim().max(500),
    extractDepth: z.enum(['basic', 'advanced']),
  })
  .strict();

export const tavilyCrawlSchema = z
  .object({
    url: publicUrlSchema,
    instructions: z.string().trim().min(1).max(1_000),
    maxDepth: z.number().int().min(1).max(2),
    maxPages: z.number().int().min(1).max(10),
  })
  .strict();

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
