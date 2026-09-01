import { register } from '../register';
import type { ToolDeclaration, ToolRuntimeHooks } from '../types';
import { searchSkillCatalog } from '../../sandbox/skill-catalog';
import {
  sandboxExecDefinition,
  sandboxExecSchema,
  sandboxReadDefinition,
  sandboxReadSchema,
  skillSearchDefinition,
  skillSearchSchema,
  type SandboxExecInput,
  type SandboxReadInput,
  type SandboxSkillSearchInput,
  type SandboxToolCall,
} from './contract';
import { sandboxFailure } from './failure';
import { sandboxService } from './service';

export const skillSearchTool: ToolDeclaration<SandboxSkillSearchInput> = {
  name: 'skill_search',
  definition: skillSearchDefinition,
  schema: skillSearchSchema,
  order: 200,
  policy: {
    budgetGroup: 'sandbox',
    budgetLabel: 'Sandbox',
    maxCalls: 128,
    errorSource: 'sandbox',
  },
  available: (context) => context.skillSearchAvailable === true,
  createCall: (call) => ({
    ...call,
    family: 'sandbox' as const,
    operation: 'skill_search' as const,
    replay: 'safe' as const,
  }),
  async execute(call, _context, services, signal) {
    const catalog = services.get(sandboxService).catalog;
    const snapshot = catalog === undefined ? null : await catalog.get(signal).catch(() => null);
    return {
      output: JSON.stringify({
        ok: snapshot !== null,
        ...(snapshot === null
          ? { matches: [], truncated: false }
          : searchSkillCatalog(snapshot, call.arguments.query, call.arguments.limit)),
      }),
    };
  },
  failure: sandboxFailure,
};

export const sandboxReadTool: ToolDeclaration<SandboxReadInput> = {
  name: 'sandbox_read',
  definition: sandboxReadDefinition,
  schema: sandboxReadSchema,
  order: 201,
  policy: {
    budgetGroup: 'sandbox',
    budgetLabel: 'Sandbox',
    maxCalls: 128,
    errorSource: 'sandbox',
  },
  available: (context) => context.sandboxAvailable === true,
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
    budgetGroup: 'sandbox',
    budgetLabel: 'Sandbox',
    maxCalls: 128,
    mutation: true,
    executionIdPrefix: 'sandboxExecution',
    errorSource: 'sandbox',
    ambiguousMessage:
      'The previous Sandbox command may already have run. Inspect its effects before choosing the next action.',
  },
  available: (context) => context.sandboxAvailable === true,
  createCall: (call) => ({
    ...call,
    family: 'sandbox' as const,
    operation: 'exec' as const,
    replay: 'mutation' as const,
  }),
  async execute(call, context, services, signal) {
    const executionId = typeof context.executionId === 'string' ? context.executionId : undefined;
    return {
      output: await services
        .get(sandboxService)
        .execution.execute(call as SandboxToolCall, signal, {
          ...(executionId === undefined ? {} : { executionId }),
        }),
    };
  },
  async recover(_call, context, services, signal) {
    if (typeof context.executionId !== 'string') {
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
  async prepare(context, services, signal) {
    if (typeof context.sandboxAvailable === 'boolean') return {};
    if (!services.has(sandboxService)) {
      return { context: { sandboxAvailable: false } };
    }
    const catalog = services.get(sandboxService).catalog;
    const snapshot = catalog === undefined ? null : await catalog.get(signal).catch(() => null);
    if (snapshot === null) return { context: { sandboxAvailable: false } };
    return {
      context: {
        sandboxAvailable: true,
        skillSearchAvailable: snapshot.entries.length > 0,
      },
    };
  },
} satisfies ToolRuntimeHooks;

register(skillSearchTool, sandboxRuntime);
register(sandboxReadTool, sandboxRuntime);
register(sandboxExecTool, sandboxRuntime);
