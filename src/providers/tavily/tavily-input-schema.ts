import { z } from 'zod';
import { isPublicHttpUrl } from '../../shared/net/public-http-url';

const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i;

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

export const tavilySearchInputSchema = z
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

export const tavilyExtractInputSchema = z
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

export const tavilyCrawlInputSchema = z
  .object({
    url: publicUrlSchema,
    instructions: z.string().trim().min(1).max(1_000),
    maxDepth: z.number().int().min(1).max(2),
    maxPages: z.number().int().min(1).max(10),
  })
  .strict();
