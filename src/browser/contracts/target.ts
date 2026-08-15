import type { FrameSegment, ObservedElement, Rect, ShadowSegment } from './observation';

export interface ElementTarget {
  readonly framePath: readonly FrameSegment[];
  readonly shadowPath: readonly ShadowSegment[];
  readonly role: string | null;
  readonly name: string | null;
  readonly label: string | null;
  readonly text: string | null;
  readonly stableAttributes: Readonly<Record<string, string>>;
  readonly ancestorHint: string | null;
  readonly lastKnownRect: Rect | null;
}

/**
 * Converts an observed element into a durable semantic target without retaining ephemeral IDs.
 */
export function createElementTarget(
  element: ObservedElement,
  ancestorHint?: string | null,
): ElementTarget {
  return {
    framePath: element.framePath.map((segment) => ({ ...segment })),
    shadowPath: element.shadowPath.map((segment) => ({
      ...segment,
      stableAttributes: { ...segment.stableAttributes },
    })),
    role: element.role,
    name: element.name,
    label: element.label,
    text: element.text,
    stableAttributes: { ...element.stableAttributes },
    ancestorHint: ancestorHint === undefined ? element.ancestorHint : ancestorHint,
    lastKnownRect: { ...element.rect },
  };
}
