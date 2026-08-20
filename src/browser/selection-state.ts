/** Reads the first normalized checked/selected fact in source-priority order. */
export function readSelectionState(state: unknown): boolean | undefined {
  if (!Array.isArray(state)) return undefined;
  for (const value of state) {
    if (value === 'checked' || value === 'selected') return true;
    if (value === 'checked=false' || value === 'selected=false') return false;
  }
  return undefined;
}
