export interface ObservationLimits {
  readonly interactiveElements: number;
  readonly textRegions: number;
  readonly normalizedTextCharacters: number;
  readonly depth: number;
}

export const DEFAULT_OBSERVATION_LIMITS: ObservationLimits = {
  interactiveElements: 400,
  textRegions: 120,
  normalizedTextCharacters: 20_000,
  depth: 40,
};
