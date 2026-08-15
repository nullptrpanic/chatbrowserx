import { z } from 'zod';
import type { ModelToolDefinition } from '../../providers/provider-types';

/** Accepts only externally retrievable HTTP(S) URLs. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const httpUrlSchema = z.string().max(4_096).refine(isHttpUrl);

export const tavilySearchSchema = z
  .object({
    query: z.string().trim().min(1).max(2_000),
    maxResults: z.number().int().min(1).max(8),
  })
  .strict();

export const tavilyExtractSchema = z
  .object({ urls: z.array(httpUrlSchema).min(1).max(5) })
  .strict();

export const tavilyCrawlSchema = z
  .object({
    url: httpUrlSchema,
    maxDepth: z.number().int().min(1).max(2),
    maxBreadth: z.number().int().min(1).max(10),
  })
  .strict();

export type TavilySearchToolInput = z.infer<typeof tavilySearchSchema>;
export type TavilyExtractToolInput = z.infer<typeof tavilyExtractSchema>;
export type TavilyCrawlToolInput = z.infer<typeof tavilyCrawlSchema>;

export const TAVILY_TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    type: 'function',
    name: 'tavily.search',
    description: 'Search the public web with a bounded result count.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 2_000 },
        maxResults: { type: 'integer', minimum: 1, maximum: 8 },
      },
      required: ['query', 'maxResults'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'tavily.extract',
    description: 'Extract bounded text from up to five public HTTP(S) URLs.',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: { type: 'string', pattern: '^https?://' },
        },
      },
      required: ['urls'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: 'tavily.crawl',
    description: 'Crawl one public HTTP(S) root with strict depth and breadth limits.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', pattern: '^https?://' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 2 },
        maxBreadth: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['url', 'maxDepth', 'maxBreadth'],
      additionalProperties: false,
    },
    strict: true,
  },
];
