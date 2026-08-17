export interface TavilySearchInput {
  readonly query: string;
  readonly searchDepth: 'basic' | 'advanced';
  readonly topic: 'general' | 'news' | 'finance';
  readonly timeRange: 'any' | 'day' | 'week' | 'month' | 'year';
  readonly maxResults: number;
  readonly includeDomains: readonly string[];
  readonly excludeDomains: readonly string[];
}

export interface TavilyExtractInput {
  readonly urls: readonly string[];
  readonly query: string;
  readonly extractDepth: 'basic' | 'advanced';
}

export interface TavilyCrawlInput {
  readonly url: string;
  readonly instructions: string;
  readonly maxDepth: number;
  readonly maxPages: number;
}

export interface TavilyResult {
  readonly title: string | null;
  readonly url: string;
  readonly content: string;
  readonly score: number | null;
  readonly source: 'search' | 'extract' | 'crawl';
}

export interface TavilyResultSet {
  readonly results: readonly TavilyResult[];
  readonly truncated: boolean;
}

export interface TavilyExecutionPort {
  search(input: TavilySearchInput, signal: AbortSignal): Promise<TavilyResultSet>;
  extract(input: TavilyExtractInput, signal: AbortSignal): Promise<TavilyResultSet>;
  crawl(input: TavilyCrawlInput, signal: AbortSignal): Promise<TavilyResultSet>;
}
