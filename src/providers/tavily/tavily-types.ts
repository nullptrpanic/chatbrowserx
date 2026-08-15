export interface TavilySearchInput {
  readonly query: string;
  readonly maxResults: number;
}

export interface TavilyExtractInput {
  readonly urls: readonly string[];
}

export interface TavilyCrawlInput {
  readonly url: string;
  readonly maxDepth: number;
  readonly maxBreadth: number;
}

export type TavilyResultSource = 'search' | 'extract' | 'crawl';

export interface TavilyResult {
  readonly title: string | null;
  readonly url: string;
  readonly content: string;
  readonly score: number | null;
  readonly source: TavilyResultSource;
}

export interface TavilyResultSet {
  readonly results: readonly TavilyResult[];
  readonly truncated: boolean;
}
