import type { SandboxExecutionPort } from '../../sandbox/sandbox-tool-executor';
import { createToolServiceToken } from '../service-resolver';

export interface SandboxToolService {
  readonly execution: SandboxExecutionPort;
}

export function createSandboxToolService(execution: SandboxExecutionPort): SandboxToolService {
  return { execution };
}

export const sandboxService = createToolServiceToken<SandboxToolService>('sandbox');
