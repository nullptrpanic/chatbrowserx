import type { BrowserActionRequest } from '../contracts/action';
import type { BrowserActionEvidence } from '../contracts/evidence';
import type { ObservedElement } from '../contracts/observation';

export interface ActionDriverContext {
  readonly target: ObservedElement | null;
  readonly destination: ObservedElement | null;
}

export interface ActionDriver {
  readonly kind: 'dom' | 'cdp';
  execute(
    request: BrowserActionRequest,
    context?: ActionDriverContext,
  ): Promise<BrowserActionEvidence>;
}
