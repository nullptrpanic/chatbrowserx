import type {
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
} from 'openai/resources/responses/responses';

const applicationPrefix = 'chatbrowserx_';

export function decodeCodexToolName(name: string): string {
  return name.startsWith(applicationPrefix) ? name.slice(applicationPrefix.length) : name;
}

/** Codex reserves some namespace names for its own tools. Scope application tools on the wire. */
export function encodeCodexToolNames(body: ResponseCreateParamsStreaming): void {
  const namespaces = new Set(
    body.tools?.flatMap((tool) => (tool.type === 'namespace' ? [tool.name] : [])),
  );
  const encodeReferences = (text: string) =>
    text.replace(/\b([a-z_]\w*)\.(?=[a-z_]\w*)/gi, (reference: string, namespace: string) =>
      namespaces.has(namespace) ? applicationPrefix + reference : reference,
    );
  if (body.tools)
    body.tools = body.tools.map((tool) => {
      if (tool.type !== 'namespace') return tool;
      return {
        ...tool,
        name: applicationPrefix + tool.name,
        description: encodeReferences(tool.description),
        tools: tool.tools.map((member) =>
          typeof member.description === 'string'
            ? { ...member, description: encodeReferences(member.description) }
            : member,
        ),
      };
    });
  if (Array.isArray(body.input))
    body.input = body.input.map((item) =>
      item.type === 'function_call' && item.namespace
        ? { ...item, namespace: applicationPrefix + item.namespace }
        : item,
    );
  if (
    typeof body.tool_choice === 'object' &&
    body.tool_choice !== null &&
    body.tool_choice.type === 'function'
  )
    body.tool_choice = { ...body.tool_choice, name: encodeReferences(body.tool_choice.name) };
}

export function decodeCodexToolCall(item: ResponseOutputItem): ResponseOutputItem {
  if (item.type !== 'function_call') return item;
  if (item.namespace) return { ...item, namespace: decodeCodexToolName(item.namespace) };
  if (!item.name.startsWith(applicationPrefix)) return item;
  const separator = item.name.indexOf('.');
  return separator < 0
    ? item
    : {
        ...item,
        namespace: decodeCodexToolName(item.name.slice(0, separator)),
        name: item.name.slice(separator + 1),
      };
}
