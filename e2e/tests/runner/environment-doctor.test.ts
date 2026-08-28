import { describe, expect, it } from 'vitest';
import {
  evaluateEnvironmentDoctor,
  satisfiesDeclaredNodeRange,
} from '../../runner/environment-doctor';

describe('E2E environment doctor', () => {
  it('accepts the repository Node engine range boundaries', () => {
    const declaredRange = '>=24.18.0 <25 || >=26.0.0 <27';

    expect(satisfiesDeclaredNodeRange('24.18.0', declaredRange)).toBe(true);
    expect(satisfiesDeclaredNodeRange('24.99.0', declaredRange)).toBe(true);
    expect(satisfiesDeclaredNodeRange('24.17.9', declaredRange)).toBe(false);
    expect(satisfiesDeclaredNodeRange('25.0.0', declaredRange)).toBe(false);
    expect(satisfiesDeclaredNodeRange('26.0.0', declaredRange)).toBe(true);
    expect(satisfiesDeclaredNodeRange('26.99.0', declaredRange)).toBe(true);
    expect(satisfiesDeclaredNodeRange('27.0.0', declaredRange)).toBe(false);
  });

  it('passes only when every local runtime prerequisite is available', () => {
    const passing = evaluateEnvironmentDoctor({
      nodeVersion: '24.18.0',
      declaredNodeRange: '>=24.18.0 <25',
      dependencyTreePresent: true,
      extensionBuildValid: true,
      extensionRuntimeReady: true,
      browserLaunchable: true,
      runtimeWritable: true,
    });
    const failing = evaluateEnvironmentDoctor({
      nodeVersion: '25.0.0',
      declaredNodeRange: '>=24.18.0 <25',
      dependencyTreePresent: true,
      extensionBuildValid: false,
      extensionRuntimeReady: false,
      browserLaunchable: true,
      runtimeWritable: true,
    });

    expect(passing.passed).toBe(true);
    expect(passing.checks.every(({ passed }) => passed)).toBe(true);
    expect(failing.passed).toBe(false);
    expect(failing.checks.filter(({ passed }) => !passed).map(({ name }) => name)).toEqual([
      'node-version',
      'extension-build',
      'extension-runtime',
    ]);
  });
});
