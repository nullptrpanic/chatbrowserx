import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { discoverToolDeclarations } from '../../../src/tools/discover';
import { strictFunctionTool } from '../../../src/tools/model-tool';
import { ToolDeclarationCatalog } from '../../../src/tools/register';

describe('discoverToolDeclarations', () => {
  it('seals registered declarations in their stable model order', () => {
    const catalog = new ToolDeclarationCatalog();
    const tool = (name: string) => ({
      name,
      definition: strictFunctionTool(name, 'description', {}),
      schema: z.object({}).strict(),
      policy: { budgetGroup: name, maxCalls: 1 },
      execute: vi.fn(async () => ({ output: name })),
    });
    catalog.register({ ...tool('z_tool'), order: 20 });
    catalog.register({ ...tool('a_tool'), order: 10 });

    const declarations = discoverToolDeclarations(catalog);

    expect(declarations.map(({ name }) => name)).toEqual(['a_tool', 'z_tool']);
  });
});
