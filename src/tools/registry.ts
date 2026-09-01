import { parseToolCallArguments } from './tool-call-envelope';
import type { ToolServiceResolver } from './service-resolver';
import type {
  ModelToolContract,
  RegisteredTool,
  ToolDeclaration,
  ToolRuntimeHooks,
  ToolRuntimePort,
  ValidatedToolCall,
} from './types';

type ErasedDeclaration = ToolDeclaration<unknown>;

/** Binds one immutable declaration catalog to one Agent's isolated service resolver. */
export function bindToolRuntime(
  tools: readonly RegisteredTool[],
  services: ToolServiceResolver,
): ToolRuntimePort {
  const declarations = tools.map((tool) => tool.declaration);
  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
  const runtimeByDeclaration = new Map(
    tools.flatMap(({ declaration, runtime }) =>
      runtime === undefined ? [] : [[declaration.name, runtime] as const],
    ),
  );
  const runtimes = [
    ...new Set(tools.flatMap(({ runtime }) => (runtime === undefined ? [] : [runtime]))),
  ];
  const grouped = new Map<ToolRuntimeHooks, ErasedDeclaration[]>();
  const groups: {
    readonly runtime?: ToolRuntimeHooks;
    readonly declarations: ErasedDeclaration[];
  }[] = [];
  for (const { declaration, runtime } of tools) {
    if (runtime === undefined) {
      groups.push({ declarations: [declaration] });
      continue;
    }
    const declarationsForRuntime = grouped.get(runtime);
    if (declarationsForRuntime === undefined) {
      const declarationsForNewRuntime = [declaration];
      grouped.set(runtime, declarationsForNewRuntime);
      groups.push({ runtime, declarations: declarationsForNewRuntime });
    } else {
      declarationsForRuntime.push(declaration);
    }
  }

  const parse = (
    declaration: ErasedDeclaration,
    source: Parameters<ModelToolContract['parse']>[0],
  ): ValidatedToolCall => {
    const parsed = declaration.schema.parse(parseToolCallArguments(source));
    const base: ValidatedToolCall = Object.freeze({
      ...source,
      arguments: parsed,
    });
    return Object.freeze(declaration.createCall?.(base) ?? base);
  };

  const declarationFor = (name: string): ErasedDeclaration => {
    const declaration = byName.get(name);
    if (declaration === undefined) throw new Error(`Tool is not registered: ${name}`);
    return declaration;
  };

  return {
    async blocksCompletion(context) {
      for (const runtime of runtimes) {
        if ((await runtime.blocksCompletion?.(context, services)) === true) return true;
      }
      for (const declaration of declarations) {
        if ((await declaration.blocksCompletion?.(context)) === true) return true;
      }
      return false;
    },

    async preflight(call, context, signal) {
      return (
        (await runtimeByDeclaration.get(call.name)?.preflight?.(call, context, services, signal)) ??
        null
      );
    },

    async contextCompacted() {
      for (const runtime of runtimes) await runtime.contextCompacted?.(services);
    },

    async release(ownerId) {
      for (const runtime of runtimes) await runtime.release?.(ownerId, services);
    },

    policyFor(name) {
      return byName.get(name)?.policy ?? null;
    },

    canRecover(name) {
      return declarationFor(name).recover !== undefined;
    },

    callsUsed(name, context) {
      const declaration = declarationFor(name);
      if (declaration.callsUsed !== undefined) return declaration.callsUsed(context);
      const results = Array.isArray(context.toolResults) ? context.toolResults : [];
      return results.filter(
        (result) =>
          typeof result === 'object' &&
          result !== null &&
          'toolName' in result &&
          typeof result.toolName === 'string' &&
          byName.get(result.toolName)?.policy.budgetGroup === declaration.policy.budgetGroup,
      ).length;
    },

    parseRecorded(source) {
      return parse(declarationFor(source.name), source);
    },

    async contract(context, signal = new AbortController().signal): Promise<ModelToolContract> {
      const available = new Map<string, ErasedDeclaration>();
      const definitions = [];
      const forced: string[] = [];
      const instructions = new Set<string>();
      let preparedContext = context;
      for (const group of groups) {
        const preparation = await group.runtime?.prepare?.(preparedContext, services, signal);
        if (preparation?.context !== undefined) {
          preparedContext = { ...preparedContext, ...preparation.context };
        }
        for (const instruction of preparation?.instructions ?? []) instructions.add(instruction);
        let exposed = false;
        for (const declaration of group.declarations) {
          if ((await declaration.available?.(preparedContext)) === false) continue;
          const exposure =
            declaration.model === undefined
              ? { definition: declaration.definition }
              : await declaration.model(preparedContext);
          if (exposure === null) continue;
          exposed = true;
          available.set(declaration.name, declaration);
          definitions.push(exposure.definition);
          if (exposure.force === true) forced.push(declaration.name);
          for (const instruction of exposure.instructions ?? []) instructions.add(instruction);
        }
        if (exposed) {
          for (const instruction of group.runtime?.instructions ?? []) {
            instructions.add(instruction);
          }
        }
        if (forced.length > 0) break;
      }
      if (forced.length > 1) throw new Error('Multiple tools requested a forced model choice.');

      return Object.freeze({
        definitions: Object.freeze(definitions),
        ...(forced[0] === undefined
          ? {}
          : { toolChoice: { type: 'function' as const, name: forced[0] } }),
        instructions: Object.freeze([...instructions]),
        parse(source) {
          const declaration = available.get(source.name);
          if (declaration === undefined) {
            throw new Error(`Tool is not available in the current model turn: ${source.name}`);
          }
          return parse(declaration, source);
        },
      });
    },

    async execute(call, context, signal) {
      return declarationFor(call.name).execute(call, context, services, signal);
    },

    async recover(call, context, signal) {
      const declaration = declarationFor(call.name);
      if (declaration.recover === undefined) {
        throw new Error(`Tool does not support recovery: ${call.name}`);
      }
      return declaration.recover(call, context, services, signal);
    },

    failureFor(call, error, context) {
      return declarationFor(call.name).failure?.(error, call, context) ?? null;
    },
  };
}
