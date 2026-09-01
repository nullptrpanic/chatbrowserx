import type { BrowserExecutionPort } from '../../browser/browser-execution-types';
import { createToolServiceToken } from '../service-resolver';

export const browserService = createToolServiceToken<BrowserExecutionPort>('browser');
