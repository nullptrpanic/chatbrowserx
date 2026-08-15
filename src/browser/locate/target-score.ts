import type { FrameSegment, ObservedElement, Rect, ShadowSegment } from '../contracts/observation';
import type { ElementTarget } from '../contracts/target';

export const TARGET_WEIGHTS = {
  framePath: 50,
  shadowPath: 40,
  roleAndName: 40,
  label: 30,
  stableAttribute: 25,
  exactText: 20,
  ancestorHint: 15,
  geometryOverlap: 5,
  invisiblePenalty: -100,
  disabledPenalty: -100,
} as const;

/** Normalizes one bounded semantic string for case-insensitive target comparison. */
function semanticText(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** Compares frame segments semantically and falls back to index only when no stable hint exists. */
function sameFrameSegment(left: FrameSegment, right: FrameSegment): boolean {
  const leftHints = [left.name, left.title, left.origin].map(semanticText);
  const rightHints = [right.name, right.title, right.origin].map(semanticText);
  const hasHint = leftHints.some(Boolean) || rightHints.some(Boolean);
  return hasHint
    ? leftHints.every((value, index) => value === rightHints[index])
    : left.index === right.index;
}

/** Compares complete frame paths without using a transient frame index as the sole stable hint. */
function sameFramePath(left: readonly FrameSegment[], right: readonly FrameSegment[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index];
      return other !== undefined && sameFrameSegment(segment, other);
    })
  );
}

/** Compares Shadow Root host semantics and stable attributes at every path segment. */
function sameShadowPath(left: readonly ShadowSegment[], right: readonly ShadowSegment[]): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index];
      if (other === undefined) return false;
      if (
        semanticText(segment.hostRole) !== semanticText(other.hostRole) ||
        semanticText(segment.hostName) !== semanticText(other.hostName)
      ) {
        return false;
      }
      return Object.entries(segment.stableAttributes).every(
        ([name, value]) => other.stableAttributes[name] === value,
      );
    })
  );
}

/** Computes intersection-over-union for the weak last-known geometry hint. */
function geometryOverlap(left: Rect, right: Rect): number {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = left.width * left.height + right.width * right.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Scores one current candidate using the approved deterministic durable-target weights. */
export function scoreTargetCandidate(target: ElementTarget, candidate: ObservedElement): number {
  if (!sameFramePath(target.framePath, candidate.framePath)) return Number.NEGATIVE_INFINITY;
  if (!sameShadowPath(target.shadowPath, candidate.shadowPath)) return Number.NEGATIVE_INFINITY;

  let score = 0;
  score += TARGET_WEIGHTS.framePath;
  if (target.shadowPath.length > 0) score += TARGET_WEIGHTS.shadowPath;
  if (
    target.role !== null &&
    target.name !== null &&
    semanticText(target.role) === semanticText(candidate.role) &&
    semanticText(target.name) === semanticText(candidate.name)
  ) {
    score += TARGET_WEIGHTS.roleAndName;
  }
  if (target.label !== null && semanticText(target.label) === semanticText(candidate.label)) {
    score += TARGET_WEIGHTS.label;
  }
  if (
    Object.entries(target.stableAttributes).some(
      ([name, value]) => candidate.stableAttributes[name] === value,
    )
  ) {
    score += TARGET_WEIGHTS.stableAttribute;
  }
  if (target.text !== null && semanticText(target.text) === semanticText(candidate.text)) {
    score += TARGET_WEIGHTS.exactText;
  }
  if (
    target.ancestorHint !== null &&
    semanticText(target.ancestorHint) === semanticText(candidate.ancestorHint)
  ) {
    score += TARGET_WEIGHTS.ancestorHint;
  }
  if (target.lastKnownRect !== null && geometryOverlap(target.lastKnownRect, candidate.rect) > 0) {
    score += TARGET_WEIGHTS.geometryOverlap;
  }
  if (!candidate.visible) score += TARGET_WEIGHTS.invisiblePenalty;
  if (candidate.state.disabled) score += TARGET_WEIGHTS.disabledPenalty;
  return score;
}
