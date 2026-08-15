import {
  modelBrowserActionSchema,
  modelBrowserToolArgumentsSchema,
  type ModelBrowserAction,
} from './browser-tool-schema';
import {
  tavilyCrawlSchema,
  tavilyExtractSchema,
  tavilySearchSchema,
  type TavilyCrawlToolInput,
  type TavilyExtractToolInput,
  type TavilySearchToolInput,
} from './tavily-tool-schema';

export const MODEL_TOOL_NAMES = [
  'browser.act',
  'tavily.search',
  'tavily.extract',
  'tavily.crawl',
] as const;

export type ParsedToolCall =
  | { readonly name: 'browser.act'; readonly arguments: ModelBrowserAction }
  | { readonly name: 'tavily.search'; readonly arguments: TavilySearchToolInput }
  | { readonly name: 'tavily.extract'; readonly arguments: TavilyExtractToolInput }
  | { readonly name: 'tavily.crawl'; readonly arguments: TavilyCrawlToolInput };

export class ToolCallError extends Error {
  readonly code: 'UNSUPPORTED_TOOL' | 'INVALID_ARGUMENTS';

  /** Creates a stable tool error that never copies model arguments into its message. */
  constructor(code: 'UNSUPPORTED_TOOL' | 'INVALID_ARGUMENTS') {
    super(code === 'UNSUPPORTED_TOOL' ? 'Unsupported tool call.' : 'Invalid tool arguments.');
    this.name = 'ToolCallError';
    this.code = code;
  }
}

/** Parses JSON without retaining model-supplied source in the thrown error. */
function parseArguments(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new ToolCallError('INVALID_ARGUMENTS');
  }
}

/** Validates one completed model tool call against the four approved strict schemas. */
export function parseToolCall(input: {
  readonly name: string;
  readonly argumentsJson: string;
}): ParsedToolCall {
  if (!(MODEL_TOOL_NAMES as readonly string[]).includes(input.name)) {
    throw new ToolCallError('UNSUPPORTED_TOOL');
  }
  const value = parseArguments(input.argumentsJson);
  if (input.name === 'browser.act') {
    const wrapped = modelBrowserToolArgumentsSchema.safeParse(value);
    if (wrapped.success) {
      return { name: 'browser.act', arguments: wrapped.data.action };
    }
    const direct = modelBrowserActionSchema.safeParse(value);
    if (direct.success) {
      return { name: 'browser.act', arguments: direct.data };
    }
  } else if (input.name === 'tavily.search') {
    const parsed = tavilySearchSchema.safeParse(value);
    if (parsed.success) return { name: input.name, arguments: parsed.data };
  } else if (input.name === 'tavily.extract') {
    const parsed = tavilyExtractSchema.safeParse(value);
    if (parsed.success) return { name: input.name, arguments: parsed.data };
  } else {
    const parsed = tavilyCrawlSchema.safeParse(value);
    if (parsed.success) return { name: 'tavily.crawl', arguments: parsed.data };
  }
  throw new ToolCallError('INVALID_ARGUMENTS');
}
