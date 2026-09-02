import { jsonRecord } from './json-contract';

/** Reads the browser-reported traversal count; observations also include the initial state. */
export function readTraversalSegments(data: unknown): number | null {
  const segments = jsonRecord(data)?.segments;
  return typeof segments === 'number' && Number.isSafeInteger(segments) && segments >= 0
    ? segments
    : null;
}
