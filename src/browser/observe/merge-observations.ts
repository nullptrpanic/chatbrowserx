import type {
  FrameSegment,
  ObservedElement,
  ObservedFrame,
  PageObservation,
  Rect,
  TextRegion,
} from '../contracts/observation';
import { DEFAULT_OBSERVATION_LIMITS } from './observation-limits';

/** Produces a deterministic semantic signature for one frame path. */
function framePathKey(path: readonly FrameSegment[]): string {
  return path
    .map((segment) =>
      [segment.index, segment.name ?? '', segment.title ?? '', segment.origin ?? ''].join('|'),
    )
    .join('>');
}

/** Computes intersection-over-union for two observation rectangles. */
function rectangleOverlap(left: Rect, right: Rect): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Scores whether DOM and CDP candidates describe the same current semantic element. */
function matchScore(dom: ObservedElement, cdp: ObservedElement): number {
  if (framePathKey(dom.framePath) !== framePathKey(cdp.framePath)) return -1;
  if (dom.role !== cdp.role || dom.name !== cdp.name) return -1;
  let score = 50;
  if (dom.shadowPath.length === cdp.shadowPath.length) score += 10;
  for (const [name, value] of Object.entries(dom.stableAttributes)) {
    if (cdp.stableAttributes[name] === value) score += 20;
  }
  score += rectangleOverlap(dom.rect, cdp.rect) * 10;
  return score;
}

/** Merges one matched pair while preserving live DOM state and CDP-only backend identity. */
function mergeElement(dom: ObservedElement, cdp: ObservedElement): ObservedElement {
  return {
    ...cdp,
    ...dom,
    stableAttributes: { ...cdp.stableAttributes, ...dom.stableAttributes },
    backendNodeId: cdp.backendNodeId,
    cdpSessionId: cdp.cdpSessionId,
  };
}

/** Appends nonduplicate frames from the secondary source in deterministic source order. */
function mergeFrames(
  primary: readonly ObservedFrame[],
  secondary: readonly ObservedFrame[],
): readonly ObservedFrame[] {
  const merged = [...primary];
  const keys = new Set(primary.map((frame) => framePathKey(frame.path)));
  for (const frame of secondary) {
    const key = framePathKey(frame.path);
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(frame);
    }
  }
  return merged;
}

/** Merges bounded unique text regions and reports whether an additional cap was reached. */
function mergeTextRegions(
  primary: readonly TextRegion[],
  secondary: readonly TextRegion[],
): { readonly regions: readonly TextRegion[]; readonly truncated: boolean } {
  const regions: TextRegion[] = [];
  const keys = new Set<string>();
  let characters = 0;
  let truncated = false;
  for (const region of [...primary, ...secondary]) {
    const key = `${framePathKey(region.framePath)}|${region.kind}|${region.text}`;
    if (keys.has(key)) continue;
    if (
      regions.length >= DEFAULT_OBSERVATION_LIMITS.textRegions ||
      characters >= DEFAULT_OBSERVATION_LIMITS.normalizedTextCharacters
    ) {
      truncated = true;
      continue;
    }
    const remaining = DEFAULT_OBSERVATION_LIMITS.normalizedTextCharacters - characters;
    const text = region.text.slice(0, remaining);
    if (text.length < region.text.length) truncated = true;
    keys.add(key);
    regions.push({ ...region, text });
    characters += text.length;
  }
  return { regions, truncated };
}

/** Combines DOM and CDP observations without duplicating matches or losing live form state. */
export function mergeObservations(dom: PageObservation, cdp: PageObservation): PageObservation {
  if (dom.tabId !== cdp.tabId) throw new Error('Cannot merge observations from different tabs.');
  const unusedCdp = new Set(cdp.elements.map((_, index) => index));
  const elements: ObservedElement[] = [];
  for (const domElement of dom.elements) {
    let bestIndex: number | null = null;
    let bestScore = -1;
    for (const index of unusedCdp) {
      const cdpElement = cdp.elements[index];
      if (cdpElement === undefined) continue;
      const score = matchScore(domElement, cdpElement);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex === null || bestScore < 50) {
      elements.push(domElement);
      continue;
    }
    const cdpElement = cdp.elements[bestIndex];
    if (cdpElement === undefined) {
      elements.push(domElement);
      continue;
    }
    unusedCdp.delete(bestIndex);
    elements.push(mergeElement(domElement, cdpElement));
  }
  for (const index of unusedCdp) {
    const cdpElement = cdp.elements[index];
    if (cdpElement !== undefined) elements.push(cdpElement);
  }
  const boundedElements = elements.slice(0, DEFAULT_OBSERVATION_LIMITS.interactiveElements);
  const text = mergeTextRegions(dom.textRegions, cdp.textRegions);

  return {
    ...dom,
    capturedAt: Math.max(dom.capturedAt, cdp.capturedAt),
    textRegions: text.regions,
    elements: boundedElements,
    frames: mergeFrames(dom.frames, cdp.frames),
    truncated:
      dom.truncated ||
      cdp.truncated ||
      text.truncated ||
      elements.length > DEFAULT_OBSERVATION_LIMITS.interactiveElements,
  };
}
