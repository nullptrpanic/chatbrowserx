/** Identity token for one Agent-scoped service consumed by a registered tool. */
export interface ToolServiceToken<T> {
  readonly id: symbol;
  readonly name: string;
  readonly serviceType?: T;
}

/** Creates one identity-based token without capturing a mutable service instance. */
export function createToolServiceToken<T>(name: string): ToolServiceToken<T> {
  if (name.trim().length === 0) throw new Error('Tool service token name is required.');
  return Object.freeze({ id: Symbol(name), name });
}

/** Owns the concrete services bound to one Agent runtime. */
export class ToolServiceResolver {
  readonly #services = new Map<symbol, unknown>();

  constructor(entries: readonly (readonly [ToolServiceToken<unknown>, unknown])[] = []) {
    for (const [token, service] of entries) this.bind(token, service);
  }

  bind<T>(token: ToolServiceToken<T>, service: T): void {
    if (this.#services.has(token.id)) {
      throw new Error(`Tool service is already bound: ${token.name}`);
    }
    this.#services.set(token.id, service);
  }

  has<T>(token: ToolServiceToken<T>): boolean {
    return this.#services.has(token.id);
  }

  get<T>(token: ToolServiceToken<T>): T {
    if (!this.#services.has(token.id)) {
      throw new Error(`Tool service is unavailable: ${token.name}`);
    }
    return this.#services.get(token.id) as T;
  }
}
