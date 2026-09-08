import { register } from '../register';
import type { ToolDeclaration, ToolRuntimeContext, ToolRuntimeHooks } from '../types';
import {
  sandboxExecDefinition,
  sandboxExecSchema,
  sandboxReadDefinition,
  sandboxReadSchema,
  type SandboxExecInput,
  type SandboxReadInput,
  type SandboxToolCall,
} from './contract';
import { sandboxFailure } from './failure';
import { loadSandboxSkillPrompt } from './skill-loader';
import { sandboxService } from './service';

const sandboxPolicy = {
  budgetGroup: 'sandbox',
  budgetLabel: 'Sandbox',
  maxCalls: 128,
  errorSource: 'sandbox',
} as const;
const sandboxAvailable = (context: ToolRuntimeContext): boolean =>
  context.sandboxAvailable === true;

export const sandboxReadTool: ToolDeclaration<SandboxReadInput> = {
  name: 'sandbox_read',
  definition: sandboxReadDefinition,
  schema: sandboxReadSchema,
  order: 201,
  policy: sandboxPolicy,
  available: sandboxAvailable,
  createCall: (call) => ({
    ...call,
    operation: 'read' as const,
  }),
  async execute(call, _context, services, signal) {
    return {
      output: await services.get(sandboxService).execution.execute(call as SandboxToolCall, signal),
    };
  },
  failure: sandboxFailure,
};

export const sandboxExecTool: ToolDeclaration<SandboxExecInput> = {
  name: 'sandbox_exec',
  definition: sandboxExecDefinition,
  schema: sandboxExecSchema,
  order: 202,
  policy: {
    ...sandboxPolicy,
    mutation: true,
    executionIdPrefix: 'sandboxExecution',
    ambiguousMessage:
      'The previous Sandbox command may already have run. Inspect its effects before choosing the next action.',
  },
  available: sandboxAvailable,
  createCall: (call) => ({
    ...call,
    operation: 'exec' as const,
  }),
  async execute(call, context, services, signal) {
    return {
      output: await services
        .get(sandboxService)
        .execution.execute(call as SandboxToolCall, signal, {
          ...(context.executionId === undefined ? {} : { executionId: context.executionId }),
        }),
    };
  },
  async recover(_call, context, services, signal) {
    if (context.executionId === undefined) {
      throw new Error('Sandbox execution recovery identifier is unavailable.');
    }
    const recovery = await services
      .get(sandboxService)
      .execution.recover(context.executionId, signal);
    if (recovery.status === 'finished') {
      return { status: 'finished', result: { output: recovery.output } };
    }
    if (recovery.status === 'running') {
      return {
        status: 'running',
        reason: 'sandbox_execution_recovery_pending',
        userMessage:
          'The Sandbox command is still running or its status is temporarily unavailable.',
      };
    }
    return { status: 'not_found' };
  },
  failure: sandboxFailure,
};

export const sandboxRuntime = {
  system_prompt(context) {
    return typeof context.sandboxSkillPrompt === 'string' ? context.sandboxSkillPrompt : null;
  },
  async prepare(context, services, signal) {
    const key = services.has(sandboxService)
      ? await services.get(sandboxService).execution.configurationKey()
      : null;
    if (key === null) return { context: { sandboxAvailable: false, sandboxSkillPrompt: null } };
    const prompt = await loadSandboxSkillPrompt(services, signal, key);
    return {
      context: {
        sandboxAvailable: true,
        sandboxSkillPrompt: prompt,
      },
    };
  },
} satisfies ToolRuntimeHooks;

register(sandboxReadTool, sandboxRuntime);
register(sandboxExecTool, sandboxRuntime);
