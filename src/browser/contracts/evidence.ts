import type { BrowserActionKind } from '../../tasks/task-types';

export interface ResolvedTargetSummary {
  readonly role: string;
  readonly name: string;
  readonly frameDepth: number;
  readonly shadowDepth: number;
}

export interface BrowserActionEvidence {
  readonly actionId: string;
  readonly actionKind: BrowserActionKind;
  readonly driver: 'dom' | 'cdp';
  readonly status: 'executed' | 'unsupported' | 'blocked' | 'failed';
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly resolvedTarget: ResolvedTargetSummary | null;
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly commandResult: Readonly<Record<string, string | number | boolean | null>>;
}
