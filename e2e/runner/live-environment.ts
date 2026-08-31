import type { ExtensionMessage } from '../../src/shared/protocol/message-types';
import { jsonRecord } from './json-contract';
import type {
  LiveEnvironmentDefinition,
  LiveEnvironmentReadinessCheck,
  LiveScenario,
} from './live-types';

const DEFAULT_POLL_INTERVAL_MS = 250;
const REQUIRED_STABLE_PASSES = 2;

type TargetStateReadErrorCategory =
  'navigation_context_replaced' | 'page_closed' | 'target_destroyed' | 'state_read_failed';

class TargetStateReadError extends Error {
  readonly category: TargetStateReadErrorCategory;

  constructor(category: TargetStateReadErrorCategory) {
    super('Target environment state read failed (' + category + ').');
    this.name = 'TargetStateReadError';
    this.category = category;
  }
}

export interface LiveEnvironmentState {
  readonly url: string;
  readonly pageText: string;
}

export interface LiveEnvironmentCheckResult {
  readonly kind: LiveEnvironmentReadinessCheck['kind'];
  readonly passed: boolean;
  readonly detail: string;
}

export interface LiveEnvironmentVerification {
  readonly passed: boolean;
  readonly checks: readonly LiveEnvironmentCheckResult[];
}

export interface WaitForTargetEnvironmentOptions {
  readonly timeoutMs: number;
  readonly readState: () => Promise<LiveEnvironmentState>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMs?: number;
}

export interface ConfiguredEnvironmentRuntime {
  readonly verifyEnvironment?: (
    scenario: LiveScenario,
    target: { readonly tabId: number; readonly url: string },
  ) => Promise<LiveEnvironmentVerification>;
  readonly send: (message: ExtensionMessage) => Promise<unknown>;
}

export interface ConfiguredEnvironmentCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ConfiguredEnvironmentVerification {
  readonly passed: boolean;
  readonly checks: readonly ConfiguredEnvironmentCheck[];
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function evaluateCheck(
  check: LiveEnvironmentReadinessCheck,
  state: LiveEnvironmentState,
): LiveEnvironmentCheckResult {
  const normalizedPageText = normalizedText(state.pageText);
  let passed: boolean;
  switch (check.kind) {
    case 'url_includes':
      passed = state.url.includes(check.value);
      break;
    case 'url_excludes':
      passed = !state.url.includes(check.value);
      break;
    case 'page_text_includes':
      passed = normalizedPageText.includes(normalizedText(check.value));
      break;
    case 'page_text_excludes':
      passed = !normalizedPageText.includes(normalizedText(check.value));
      break;
    case 'page_text_any':
      passed = check.values.some((value) => normalizedPageText.includes(normalizedText(value)));
      break;
  }
  return {
    kind: check.kind,
    passed,
    detail: passed
      ? 'Declared readiness condition matched.'
      : 'Declared readiness condition failed.',
  };
}

/** Evaluates one bounded target snapshot without retaining or echoing page contents. */
export function evaluateTargetEnvironment(
  environment: LiveEnvironmentDefinition,
  state: LiveEnvironmentState,
): LiveEnvironmentVerification {
  const checks = environment.readinessChecks.map((check) => evaluateCheck(check, state));
  return { passed: checks.every(({ passed }) => passed), checks };
}

function targetStateReadErrorCategory(error: unknown): TargetStateReadErrorCategory {
  if (error instanceof TargetStateReadError) return error.category;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /execution context was destroyed|cannot find context with specified id|frame was detached|because of a navigation/iu.test(
      message,
    )
  ) {
    return 'navigation_context_replaced';
  }
  if (/page, context or browser has been closed|page has been closed/iu.test(message)) {
    return 'page_closed';
  }
  if (/target.*(?:closed|destroyed)/iu.test(message)) return 'target_destroyed';
  return 'state_read_failed';
}

function readinessFailureDetail(error: unknown): string {
  return 'The target readiness verifier failed (' + targetStateReadErrorCategory(error) + ').';
}

/** Polls a live target until all declared conditions pass or the readiness budget expires. */
export async function waitForTargetEnvironment(
  environment: LiveEnvironmentDefinition,
  options: WaitForTargetEnvironmentOptions,
): Promise<LiveEnvironmentVerification> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (async (milliseconds: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const deadline = now() + Math.max(1, options.timeoutMs);
  let latest: LiveEnvironmentVerification | null = null;
  let stablePasses = 0;
  while (true) {
    try {
      latest = evaluateTargetEnvironment(environment, await options.readState());
      stablePasses = latest.passed ? stablePasses + 1 : 0;
      if (stablePasses >= REQUIRED_STABLE_PASSES) return latest;
    } catch (error) {
      stablePasses = 0;
      const category = targetStateReadErrorCategory(error);
      if (category !== 'navigation_context_replaced') {
        throw new TargetStateReadError(category);
      }
      if (now() >= deadline) throw new TargetStateReadError(category);
    }
    if (now() >= deadline) {
      if (latest === null) throw new TargetStateReadError('navigation_context_replaced');
      return { ...latest, passed: false };
    }
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
}

export function targetEnvironmentFailureMessage(verification: LiveEnvironmentVerification): string {
  const failedKinds = verification.checks
    .filter(({ passed }) => !passed)
    .map(({ kind }) => kind)
    .join(', ');
  return `Target environment verification failed: ${failedKinds || 'unknown condition'}.`;
}

function configuredCheck(
  name: string,
  passed: boolean,
  success: string,
  failure: string,
): ConfiguredEnvironmentCheck {
  return { name, passed, detail: passed ? success : failure };
}

function unavailableTargetVerification(
  environment: LiveEnvironmentDefinition | undefined,
  detail: string,
): LiveEnvironmentVerification {
  const readinessChecks = environment?.readinessChecks ?? [];
  return {
    passed: readinessChecks.length === 0,
    checks: readinessChecks.map(({ kind }) => ({
      kind,
      passed: false,
      detail,
    })),
  };
}

/** Applies the shared complete preflight contract to already collected, non-persisted state. */
export function evaluateConfiguredLiveEnvironment(
  scenario: LiveScenario,
  target: { readonly tabId: number; readonly url: string },
  snapshotValue: unknown,
  targetVerification = unavailableTargetVerification(
    scenario.environment,
    'The target readiness verifier is unavailable.',
  ),
): ConfiguredEnvironmentVerification {
  const originMatches = (() => {
    try {
      return new URL(target.url).origin === scenario.expectedOrigin;
    } catch {
      return false;
    }
  })();
  const snapshot = jsonRecord(snapshotValue);
  const settings = jsonRecord(snapshot?.settings);
  const tab = jsonRecord(snapshot?.tab);
  const hasCodexToken = settings?.hasCodexToken === true;
  const requiresSandbox =
    scenario.requiredTools?.some((name) => name.startsWith('sandbox_')) ?? false;
  const sandboxConfigured =
    typeof settings?.sandboxServer === 'string' &&
    settings.sandboxServer.trim().length > 0 &&
    settings.hasSandboxToken === true;
  const extensionTabAccess =
    tab?.id === target.tabId && tab.supported === true && tab.hasPermission === true;
  const checks: ConfiguredEnvironmentCheck[] = [
    configuredCheck(
      'target-origin',
      originMatches,
      'The target origin matches the sample contract.',
      'The target origin does not match the sample contract.',
    ),
    configuredCheck(
      'codex-token',
      hasCodexToken,
      'The extension has a configured Codex access token.',
      'The extension has no configured Codex access token.',
    ),
    configuredCheck(
      'extension-tab-access',
      extensionTabAccess,
      'The extension can access the intended target tab.',
      'The extension cannot access the intended target tab.',
    ),
  ];
  if (requiresSandbox) {
    checks.push(
      configuredCheck(
        'sandbox-configuration',
        sandboxConfigured,
        'The required Sandbox connection is configured.',
        'The required Sandbox connection is not configured.',
      ),
    );
  }
  for (const [index, readiness] of targetVerification.checks.entries()) {
    checks.push({
      name: `target:${readiness.kind}:${String(index + 1)}`,
      passed: readiness.passed,
      detail: readiness.detail,
    });
  }
  return { passed: checks.every(({ passed }) => passed), checks };
}

/**
 * Verifies the complete reusable live environment without exposing credentials, URLs, or page
 * contents. This is shared by interactive setup and standalone preflight verification.
 */
export async function verifyConfiguredLiveEnvironment(
  runtime: ConfiguredEnvironmentRuntime,
  scenario: LiveScenario,
  target: { readonly tabId: number; readonly url: string },
  requestId: string,
): Promise<ConfiguredEnvironmentVerification> {
  let snapshot: unknown;
  try {
    snapshot = await runtime.send({
      version: 1,
      requestId,
      type: 'panel.getSnapshot',
      payload: { tabId: target.tabId },
    });
  } catch {
    snapshot = null;
  }
  let targetVerification = unavailableTargetVerification(
    scenario.environment,
    'The target readiness verifier is unavailable.',
  );
  if (scenario.environment !== undefined && runtime.verifyEnvironment !== undefined) {
    try {
      targetVerification = await runtime.verifyEnvironment(scenario, target);
    } catch (error) {
      targetVerification = {
        ...unavailableTargetVerification(scenario.environment, readinessFailureDetail(error)),
        passed: false,
      };
    }
  }
  return evaluateConfiguredLiveEnvironment(scenario, target, snapshot, targetVerification);
}

export function configuredEnvironmentFailureMessage(
  verification: ConfiguredEnvironmentVerification,
): string {
  const failures = verification.checks
    .filter(({ passed }) => !passed)
    .map(({ name, detail }) => `${name}: ${detail}`)
    .join('; ');
  return `Configured live environment verification failed: ${failures || 'unknown condition'}.`;
}
