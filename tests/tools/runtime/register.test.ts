import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { strictFunctionTool } from '../../../src/tools/model-tool';
import { ToolDeclarationCatalog } from '../../../src/tools/register';
import type { ToolDeclaration } from '../../../src/tools/types';

/** Creates one complete declaration whose differences are explicit in each validation test. */
function declaration(
  name: string,
  overrides: Partial<ToolDeclaration<string>> = {},
): ToolDeclaration<string> {
  return {
    name,
    definition: strictFunctionTool(name, `${name} description`, {
      value: { type: 'string' },
    }),
    schema: z
      .object({ value: z.string() })
      .strict()
      .transform(({ value }) => value),
    policy: {
      budgetGroup: 'test',
      maxCalls: 4,
    },
    execute: vi.fn(async ({ arguments: value }) => value),
    ...overrides,
  };
}

describe('ToolDeclarationCatalog', () => {
  it('seals a deterministically ordered immutable declaration catalog', () => {
    const catalog = new ToolDeclarationCatalog();
    catalog.register(declaration('z_tool', { order: 20 }));
    catalog.register(declaration('a_tool', { order: 10 }));

    const sealed = catalog.seal();

    expect(sealed.map(({ declaration: { name } }) => name)).toEqual(['a_tool', 'z_tool']);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(() => catalog.register(declaration('later_tool'))).toThrow(/sealed/i);
  });

  it('rejects duplicate names and definition-name mismatches', () => {
    const duplicates = new ToolDeclarationCatalog();
    duplicates.register(declaration('same_tool'));
    expect(() => duplicates.register(declaration('same_tool'))).toThrow(/duplicate/i);

    const mismatch = new ToolDeclarationCatalog();
    expect(() =>
      mismatch.register(
        declaration('declared_name', {
          definition: strictFunctionTool('different_name', 'description', {}),
        }),
      ),
    ).toThrow(/name/i);
  });

  it('rejects invalid and conflicting budget declarations', () => {
    const catalog = new ToolDeclarationCatalog();

    catalog.register(declaration('base_budget'));
    expect(() =>
      catalog.register(
        declaration('bad_budget', {
          policy: {
            budgetGroup: 'test',
            maxCalls: 3,
          },
        }),
      ),
    ).toThrow(/budget/i);
  });
});
