import type { ObservedElement } from '../contracts/observation';

export interface TargetCandidateSummary {
  readonly role: string;
  readonly name: string;
  readonly label: string | null;
  readonly ancestorHint: string | null;
  readonly score: number;
  readonly visible: boolean;
  readonly disabled: boolean;
}

export type TargetResolution =
  | {
      readonly kind: 'resolved';
      readonly element: ObservedElement;
      readonly score: number;
    }
  | {
      readonly kind: 'ambiguous';
      readonly candidates: readonly TargetCandidateSummary[];
    }
  | {
      readonly kind: 'not_found';
      readonly candidates: readonly TargetCandidateSummary[];
    };
