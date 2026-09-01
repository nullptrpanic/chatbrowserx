import type { RegisteredTool, ToolDeclaration, ToolRuntimeHooks } from './types';

/** Collects independently registered tools before sealing one deterministic process catalog. */
export class ToolDeclarationCatalog {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #budgetLimits = new Map<string, number>();
  #sealed: readonly RegisteredTool[] | null = null;

  get isSealed(): boolean {
    return this.#sealed !== null;
  }

  get tools(): readonly RegisteredTool[] {
    if (this.#sealed === null) throw new Error('Tool declaration catalog is not sealed.');
    return this.#sealed;
  }

  register(declaration: ToolDeclaration, runtime?: ToolRuntimeHooks): void {
    if (this.#sealed !== null) throw new Error('Tool declaration catalog is sealed.');
    this.#validateDeclaration(declaration);
    this.#tools.set(
      declaration.name,
      Object.freeze({ declaration, ...(runtime === undefined ? {} : { runtime }) }),
    );
  }

  #validateDeclaration(declaration: ToolDeclaration): void {
    if (declaration.name !== declaration.definition.name) {
      throw new Error('Tool declaration name must match its model definition name.');
    }
    if (this.#tools.has(declaration.name)) {
      throw new Error(`Duplicate tool declaration: ${declaration.name}`);
    }
    if (
      declaration.policy.budgetGroup.trim().length === 0 ||
      !Number.isSafeInteger(declaration.policy.maxCalls) ||
      declaration.policy.maxCalls <= 0
    ) {
      throw new Error(`Tool declaration has an invalid budget: ${declaration.name}`);
    }
    const budgetLimit = this.#budgetLimits.get(declaration.policy.budgetGroup);
    if (budgetLimit !== undefined && budgetLimit !== declaration.policy.maxCalls) {
      throw new Error(
        `Tool budget group has conflicting limits: ${declaration.policy.budgetGroup}`,
      );
    }
    if (declaration.order !== undefined && !Number.isSafeInteger(declaration.order)) {
      throw new Error(`Tool declaration order is invalid: ${declaration.name}`);
    }

    this.#budgetLimits.set(declaration.policy.budgetGroup, declaration.policy.maxCalls);
  }

  seal(): readonly RegisteredTool[] {
    if (this.#sealed !== null) return this.#sealed;
    this.#sealed = Object.freeze(
      [...this.#tools.values()].sort(
        (left, right) =>
          (left.declaration.order ?? 0) - (right.declaration.order ?? 0) ||
          left.declaration.name.localeCompare(right.declaration.name),
      ),
    );
    return this.#sealed;
  }
}

export const registeredToolCatalog = new ToolDeclarationCatalog();

/** Registers one process-static model-callable tool without a central concrete tool list. */
export function register(declaration: ToolDeclaration, runtime?: ToolRuntimeHooks): void {
  registeredToolCatalog.register(declaration, runtime);
}
