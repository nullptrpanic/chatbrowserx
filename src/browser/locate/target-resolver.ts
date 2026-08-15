import type { ObservedElement, PageObservation } from '../contracts/observation';
import type { ElementTarget } from '../contracts/target';
import type { TargetCandidateSummary, TargetResolution } from './target-resolution';
import { scoreTargetCandidate } from './target-score';

export const TARGET_MINIMUM_SCORE = 60;
export const TARGET_MINIMUM_MARGIN = 15;
export const TARGET_CANDIDATE_LIMIT = 5;

interface ScoredCandidate {
  readonly element: ObservedElement;
  readonly score: number;
}

/** Produces a stable ordering key independent of transient observation traversal order. */
function candidateOrderingKey(candidate: ObservedElement): string {
  return JSON.stringify([
    candidate.framePath,
    candidate.shadowPath,
    candidate.role,
    candidate.name,
    candidate.label,
    candidate.ancestorHint,
    Object.entries(candidate.stableAttributes).sort(([left], [right]) => left.localeCompare(right)),
    candidate.rect.x,
    candidate.rect.y,
    candidate.rect.width,
    candidate.rect.height,
  ]);
}

/** Converts a scored element into a bounded candidate summary for diagnostics and replanning. */
function summarizeCandidate(candidate: ScoredCandidate): TargetCandidateSummary {
  return {
    role: candidate.element.role.slice(0, 80),
    name: candidate.element.name.slice(0, 200),
    label: candidate.element.label?.slice(0, 200) ?? null,
    ancestorHint: candidate.element.ancestorHint?.slice(0, 200) ?? null,
    score: candidate.score,
    visible: candidate.element.visible,
    disabled: candidate.element.state.disabled,
  };
}

/** Returns whether a target contains at least one semantic field beyond paths and geometry. */
function hasSemanticIdentity(target: ElementTarget): boolean {
  return (
    target.role !== null ||
    target.name !== null ||
    target.label !== null ||
    target.text !== null ||
    Object.keys(target.stableAttributes).length > 0
  );
}

/** Resolves a durable semantic target only when score and uniqueness thresholds are both met. */
export function resolveTarget(
  observation: PageObservation,
  target: ElementTarget,
): TargetResolution {
  if (!hasSemanticIdentity(target)) return { kind: 'not_found', candidates: [] };
  const scored = observation.elements
    .map((element) => ({ element, score: scoreTargetCandidate(target, element) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => {
      const scoreOrder = right.score - left.score;
      return scoreOrder !== 0
        ? scoreOrder
        : candidateOrderingKey(left.element).localeCompare(candidateOrderingKey(right.element));
    });
  const candidates = scored.slice(0, TARGET_CANDIDATE_LIMIT).map(summarizeCandidate);
  const best = scored[0];
  if (best === undefined || best.score < TARGET_MINIMUM_SCORE) {
    return { kind: 'not_found', candidates };
  }
  const secondScore = scored[1]?.score ?? Number.NEGATIVE_INFINITY;
  if (best.score - secondScore < TARGET_MINIMUM_MARGIN) {
    return { kind: 'ambiguous', candidates };
  }
  return { kind: 'resolved', element: best.element, score: best.score };
}
