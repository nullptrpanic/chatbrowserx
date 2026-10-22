const SUCCESS_ENVELOPE_KEYS = new Set(['ok', 'tabId', 'url', 'data', 'observation']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactScrollObservation(value: unknown, currentEntries: Map<string, string>): unknown {
  const observation = record(value);
  if (
    observation === null ||
    observation.mode !== 'interactive' ||
    typeof observation.snapshot !== 'string'
  ) {
    return value;
  }

  const compact = { ...observation };
  // A full snapshot replaces the delta base; prior values can no longer suppress later upserts.
  if (Array.isArray(observation.elements)) currentEntries.clear();
  if (Array.isArray(observation.remove)) {
    for (const identity of observation.remove) {
      if (typeof identity === 'string') currentEntries.delete(identity);
    }
  }

  if (Array.isArray(observation.upsert)) {
    compact.upsert = observation.upsert.flatMap((value) => {
      const item = record(value);
      const entry = record(item?.e);
      if (item === null || entry === null || typeof item.k !== 'string') return [value];
      const signature = JSON.stringify(entry);
      const changed = currentEntries.get(item.k) !== signature;
      currentEntries.set(item.k, signature);
      return changed ? [value] : [];
    });
  }
  return compact;
}

function compactScrollData(data: Record<string, unknown>): Record<string, unknown> {
  if (data.action !== 'scroll') return data;
  const currentEntries = new Map<string, string>();
  const compact = { ...data };
  if (Array.isArray(data.observations)) {
    compact.observations = data.observations.map((observation) =>
      compactScrollObservation(observation, currentEntries),
    );
  }
  for (const key of ['verification', 'pageVerification'] as const) {
    if (key in data) compact[key] = compactScrollObservation(data[key], currentEntries);
  }
  return compact;
}

/**
 * Projects only protocol-defined redundant transport fields out of the model-visible receipt.
 * Any unrecognized shape remains byte-for-byte unchanged so its semantics are never guessed.
 */
export function compactBrowserModelOutput(fullOutput: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fullOutput);
  } catch {
    return fullOutput;
  }

  const envelope = record(parsed);
  const data = record(envelope?.data);
  const scrollOutput = data?.action === 'scroll';
  if (
    envelope === null ||
    envelope.ok !== true ||
    (typeof envelope.tabId !== 'number' && envelope.tabId !== null) ||
    (typeof envelope.url !== 'string' && envelope.url !== null) ||
    data === null ||
    (!scrollOutput && envelope.observation !== null) ||
    Object.keys(envelope).length !== SUCCESS_ENVELOPE_KEYS.size ||
    Object.keys(envelope).some((key) => !SUCCESS_ENVELOPE_KEYS.has(key))
  ) {
    return fullOutput;
  }

  const compact: Record<string, unknown> = {
    ...envelope,
    data: compactScrollData(data),
  };
  if (envelope.observation === null) delete compact.observation;
  return JSON.stringify(compact);
}
