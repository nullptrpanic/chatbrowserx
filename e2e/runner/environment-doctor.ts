export interface EnvironmentDoctorFacts {
  readonly nodeVersion: string;
  readonly declaredNodeRange: string;
  readonly dependencyTreePresent: boolean;
  readonly extensionBuildValid: boolean;
  readonly extensionRuntimeReady: boolean;
  readonly browserLaunchable: boolean;
  readonly runtimeWritable: boolean;
}

export interface EnvironmentDoctorCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface EnvironmentDoctorReport {
  readonly passed: boolean;
  readonly checks: readonly EnvironmentDoctorCheck[];
}

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseSemanticVersion(value: string): SemanticVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: SemanticVersion, right: SemanticVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/** Checks the bounded Node engine clauses used by this repository without adding a dependency. */
export function satisfiesDeclaredNodeRange(version: string, range: string): boolean {
  const parsedVersion = parseSemanticVersion(version);
  if (parsedVersion === null) return false;
  return range.split(/\s*\|\|\s*/u).some((clause) => {
    const match = /^>=(\d+\.\d+\.\d+)\s+<(\d+)$/.exec(clause.trim());
    if (match === null) return false;
    const minimum = parseSemanticVersion(match[1] ?? '');
    return (
      minimum !== null &&
      compareVersions(parsedVersion, minimum) >= 0 &&
      parsedVersion.major < Number(match[2] ?? '')
    );
  });
}

function booleanCheck(name: string, passed: boolean, success: string, failure: string) {
  return { name, passed, detail: passed ? success : failure };
}

/** Produces a deterministic, credential-free readiness report from local machine facts. */
export function evaluateEnvironmentDoctor(facts: EnvironmentDoctorFacts): EnvironmentDoctorReport {
  const checks: EnvironmentDoctorCheck[] = [
    booleanCheck(
      'node-version',
      satisfiesDeclaredNodeRange(facts.nodeVersion, facts.declaredNodeRange),
      'The active Node.js version satisfies the repository engine range.',
      'The active Node.js version does not satisfy the repository engine range.',
    ),
    booleanCheck(
      'dependency-tree',
      facts.dependencyTreePresent,
      'The installed dependency tree is present.',
      'The installed dependency tree is missing.',
    ),
    booleanCheck(
      'extension-build',
      facts.extensionBuildValid,
      'The built extension manifest and side-panel entry are valid.',
      'The built extension manifest or side-panel entry is invalid.',
    ),
    booleanCheck(
      'extension-runtime',
      facts.extensionRuntimeReady,
      'The built extension reaches a ready Side Panel in a fresh Profile.',
      'The built extension does not reach a ready Side Panel in a fresh Profile.',
    ),
    booleanCheck(
      'browser-launch',
      facts.browserLaunchable,
      'The configured Playwright browser can launch.',
      'The configured Playwright browser cannot launch.',
    ),
    booleanCheck(
      'runtime-write',
      facts.runtimeWritable,
      'The local E2E runtime directory is writable.',
      'The local E2E runtime directory is not writable.',
    ),
  ];
  return { passed: checks.every(({ passed }) => passed), checks };
}
