import type { TaskHistoryReaderPort } from '../../tasks/task-history-reader';
import { createToolServiceToken } from '../service-resolver';

export const historyService = createToolServiceToken<TaskHistoryReaderPort>('history');
