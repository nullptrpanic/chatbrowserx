import { toolNameParts } from '../../../../src/tools/model-tool';

type FixtureEvent = { type: string; [key: string]: unknown };

export function codexFixtureToolName(qualifiedName: string) {
  const { name, namespace } = toolNameParts(qualifiedName);
  return namespace ? { name, namespace: `chatbrowserx_${namespace}` } : { name };
}

/** Builds complete Responses envelopes for synthetic browser fixtures, including final output. */
export function codexFixtureEvents<T extends FixtureEvent>(events: readonly T[]): T[] {
  const output = events
    .filter((event) => event.type === 'response.output_item.done')
    .map((event) => event.item);
  const text = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta)
    .join('');
  return events.map((event) => {
    if (event.type !== 'response.created' && event.type !== 'response.completed') return event;
    const response = event.response as Record<string, unknown>;
    const completed = event.type === 'response.completed';
    return {
      ...event,
      response: {
        object: 'response',
        status: completed ? 'completed' : 'in_progress',
        output: completed
          ? [
              ...output,
              ...(text
                ? [
                    {
                      type: 'message',
                      id: `msg_${String(response.id)}`,
                      role: 'assistant',
                      status: 'completed',
                      content: [{ type: 'output_text', text, annotations: [] }],
                    },
                  ]
                : []),
            ]
          : [],
        ...(completed ? { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } : {}),
        ...response,
      },
    };
  });
}
