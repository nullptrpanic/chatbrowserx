import { createToolServiceToken } from '../service-resolver';
import type { TavilyExecutionPort } from './types';

export const tavilyService = createToolServiceToken<TavilyExecutionPort>('tavily');
