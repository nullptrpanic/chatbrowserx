import { z } from 'zod';
import { register } from '../register';
import type { ToolDeclaration, ToolRuntimeContext, ToolRuntimeHooks } from '../types';
import { strictFunctionTool } from '../model-tool';
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

export const skillLoaderTool: ToolDeclaration<Record<string, never>> = {
  name: 'skill_loader',
  definition: strictFunctionTool('skill_loader', 'Load configured Sandbox Skills.', {}),
  schema: z.object({}).strict(),
  order: 199,
  policy: sandboxPolicy,
  available: () => false,
  async execute() {
    throw new Error('skill_loader is not model-callable.');
  },
};

export const sandboxReadTool: ToolDeclaration<SandboxReadInput> = {
  name: 'sandbox_read',
  definition: sandboxReadDefinition,
  schema: sandboxReadSchema,
  order: 201,
  policy: sandboxPolicy,
  available: sandboxAvailable,
  createCall: (call) => ({
    ...call,
    family: 'sandbox' as const,
    operation: 'read' as const,
    replay: 'safe' as const,
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
    family: 'sandbox' as const,
    operation: 'exec' as const,
    replay: 'mutation' as const,
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
    if (!services.has(sandboxService)) return { context: { sandboxAvailable: false } };
    const prompt = await loadSandboxSkillPrompt(services, signal);
    return {
      context: {
        sandboxAvailable: true,
        ...(prompt === null ? {} : { sandboxSkillPrompt: prompt }),
      },
    };
  },
} satisfies ToolRuntimeHooks;

register(skillLoaderTool, sandboxRuntime);
register(sandboxReadTool, sandboxRuntime);
register(sandboxExecTool, sandboxRuntime);
