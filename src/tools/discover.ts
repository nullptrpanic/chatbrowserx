import { registeredToolCatalog, type ToolDeclarationCatalog } from './register';
import type { RegisteredTool, ToolDeclaration } from './types';

// Import every conventional entrypoint at build time. Each module registers itself, while eager
// discovery avoids one runtime chunk and async load per built-in tool.
import.meta.glob('./*/tool.ts', { eager: true });

/** Seals the tools contributed by conventional built-in entrypoints. */
export function discoverTools(
  catalog: ToolDeclarationCatalog = registeredToolCatalog,
): readonly RegisteredTool[] {
  if (catalog.isSealed) return catalog.tools;
  return catalog.seal();
}

/** Projects stable model-callable declarations for audits without becoming a composition list. */
export function discoverToolDeclarations(
  catalog: ToolDeclarationCatalog = registeredToolCatalog,
): readonly ToolDeclaration[] {
  return discoverTools(catalog).map((tool) => tool.declaration);
}
