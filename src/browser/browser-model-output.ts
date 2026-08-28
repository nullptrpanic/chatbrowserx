const SUCCESS_ENVELOPE_KEYS = new Set(['ok', 'tabId', 'url', 'data', 'observation']);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactScrollObservation(
  value: unknown,
  currentEntries: Map<string, string>,
  keepCoverage: boolean,
): unknown {
  const observation = record(value);
  if (
    observation === null ||
    observation.mode !== 'interactive' ||
    typeof observation.snapshot !== 'string'
  ) {
    return value;
  }

  const compact = { ...observation };
  if (Array.isArray(observation.remove)) {
    for (const identity of observation.remove) {
      if (typeof identity === 'string') currentEntries.delete(identity);
    }
    const actionableRemovals = observation.remove.filter(
      (identity): identity is string => typeof identity === 'string' && identity.startsWith('ref:'),
    );
    if (actionableRemovals.length === 0) delete compact.remove;
    else compact.remove = actionableRemovals;
  }

  if (Array.isArray(observation.upsert)) {
    compact.upsert = observation.upsert.filter((value) => {
      const item = record(value);
      const entry = record(item?.e);
      if (item === null || entry === null || typeof item.k !== 'string') return true;
      const signature = JSON.stringify(entry);
      const changed = currentEntries.get(item.k) !== signature;
      currentEntries.set(item.k, signature);
      return changed;
    });
  }
  if (!keepCoverage) delete compact.coverage;
  return compact;
}

function compactScrollData(data: Record<string, unknown>): Record<string, unknown> {
  if (data.action !== 'scroll') return data;
  const currentEntries = new Map<string, string>();
  const compact = { ...data };
  if (Array.isArray(data.observations)) {
    const lastObservationIndex = data.observations.length - 1;
    compact.observations = data.observations.map((observation, index) =>
      compactScrollObservation(observation, currentEntries, index === lastObservationIndex),
    );
  }
  for (const key of ['verification', 'pageVerification'] as const) {
    if (key in data) compact[key] = compactScrollObservation(data[key], currentEntries, true);
  }
  return compact;
}

/**
 * Removes only browser-envelope fields whose absence is protocol-equivalent to their value.
 * Any unrecognized shape remains byte-for-byte unchanged so audit evidence cannot be lost.
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
