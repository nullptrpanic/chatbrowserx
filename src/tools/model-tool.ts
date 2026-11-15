export interface ModelToolDefinition {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export type ModelToolChoice = 'auto' | { readonly type: 'function'; readonly name: string };

export type JsonSchemaProperty = Readonly<Record<string, unknown>>;

export function strictObjectSchema(properties: Readonly<Record<string, JsonSchemaProperty>>) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  } as const;
}

export function qualifiedToolName(name: string, namespace?: string): string {
  return namespace === undefined ? name : `${namespace}.${name}`;
}

export function toolNameParts(qualifiedName: string): { name: string; namespace?: string } {
  const separator = qualifiedName.indexOf('.');
  return separator < 0
    ? { name: qualifiedName }
    : { name: qualifiedName.slice(separator + 1), namespace: qualifiedName.slice(0, separator) };
}

/** Creates the strict flat object contract required by model-facing tools. */
export function strictFunctionTool(
  name: string,
  description: string,
  properties: Readonly<Record<string, JsonSchemaProperty>>,
): ModelToolDefinition {
  return {
    type: 'function',
    name,
    description,
    parameters: strictObjectSchema(properties),
    strict: true,
  };
}
