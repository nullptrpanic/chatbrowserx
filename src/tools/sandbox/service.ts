import type { SandboxExecutionPort } from '../../sandbox/sandbox-tool-executor';
import type { SkillCatalogPort } from '../../sandbox/skill-catalog';
import { createToolServiceToken } from '../service-resolver';

export interface SandboxToolService {
  readonly execution: SandboxExecutionPort;
  readonly catalog?: SkillCatalogPort;
}

export function createSandboxToolService(
  execution: SandboxExecutionPort,
  catalog?: SkillCatalogPort,
): SandboxToolService {
  return { execution, ...(catalog === undefined ? {} : { catalog }) };
}

export const sandboxService = createToolServiceToken<SandboxToolService>('sandbox');
