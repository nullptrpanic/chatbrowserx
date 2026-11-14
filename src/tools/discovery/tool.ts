import { z } from 'zod';
import { strictFunctionTool } from '../model-tool';
import { register } from '../register';
import type { ToolDeclaration, ToolRuntimeContext } from '../types';

const name = 'load_tools';
const schema = z.object({ names: z.array(z.string().min(1).max(128)).min(1).max(20) }).strict();
const definition = strictFunctionTool(
  name,
  'Load optional tools by name. A user request to use an optional capability, such as searching the web, requires loading and using that tool before answering; existing knowledge is not a substitute for the requested action. Loading does not execute the tool. Use loaded tools on the next turn; they stay loaded for this task.',
  { names: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } } },
);

function requestedTools(context: ToolRuntimeContext): Set<string> {
  const names = new Set<string>();
  for (const result of context.toolResults ?? []) {
    if (result.toolName !== name || result.taskId !== context.task?.id) continue;
    try {
      const output = JSON.parse(result.output) as { ok?: boolean; requested?: unknown };
      if (output.ok === true && Array.isArray(output.requested))
        for (const requested of output.requested)
          if (typeof requested === 'string') names.add(requested);
    } catch {
      // Failed or incomplete receipts cannot enable a capability.
    }
  }
  return names;
}

const loader: ToolDeclaration<z.infer<typeof schema>> = {
  name,
  definition,
  schema,
  order: -60,
  policy: { budgetGroup: 'discovery', maxCalls: 20 },
  model(context) {
    const tools = context.optionalTools ?? [];
    if (tools.length === 0) return null;
    const requested = requestedTools(context);
    return {
      definition: {
        ...definition,
        parameters: {
          ...definition.parameters,
          properties: {
            names: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: { type: 'string', enum: tools.map((tool) => tool.name) },
            },
          },
        },
      },
      additionalTools: tools.filter((tool) => requested.has(tool.name)),
    };
  },
  async execute(call) {
    return { output: JSON.stringify({ ok: true, requested: [...new Set(call.arguments.names)] }) };
  },
};

register(loader);
