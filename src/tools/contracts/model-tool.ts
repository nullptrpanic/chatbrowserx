export interface ModelToolDefinition {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict: true;
}

export type ModelToolChoice = 'auto' | { readonly type: 'function'; readonly name: string };

type JsonSchemaProperty = Readonly<Record<string, unknown>>;

/** Creates the strict flat object contract required by the Responses API. */
export function strictFunctionTool(
  name: string,
  description: string,
  properties: Readonly<Record<string, JsonSchemaProperty>>,
): ModelToolDefinition {
  return {
    type: 'function',
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    strict: true,
  };
}
