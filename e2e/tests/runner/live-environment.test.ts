import { describe, expect, it } from 'vitest';
import {
  evaluateTargetEnvironment,
  verifyConfiguredLiveEnvironment,
  waitForTargetEnvironment,
} from '../../runner/live-environment';
import type { LiveEnvironmentDefinition, LiveScenario } from '../../runner/live-types';

const environment: LiveEnvironmentDefinition = {
  targetSetupMode: 'interactive',
  targetSetupInstructions: ['Sign in with the evaluation account.'],
  readinessChecks: [
    { kind: 'url_includes', value: '/document' },
    { kind: 'url_excludes', value: '/login' },
    { kind: 'page_text_includes', value: 'Workspace' },
    { kind: 'page_text_excludes', value: 'Sign in' },
    { kind: 'page_text_any', values: ['Ready', 'Document loaded'] },
  ],
};

describe('live target environment verification', () => {
  it('passes only when every declared readiness check matches', () => {
    const result = evaluateTargetEnvironment(environment, {
      url: 'https://example.com/document/1',
      pageText: 'Example workspace\nDocument loaded',
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(5);
    expect(result.checks.every(({ passed }) => passed)).toBe(true);
  });

  it('reports failed checks without echoing page contents or URL credentials', () => {
    const result = evaluateTargetEnvironment(environment, {
      url: 'https://example.com/login?token=secret-query',
      pageText: 'Sign in\nPRIVATE PAGE CONTENT',
    });

    expect(result.passed).toBe(false);
    expect(result.checks.filter(({ passed }) => !passed).map(({ kind }) => kind)).toEqual([
      'url_includes',
      'url_excludes',
      'page_text_includes',
      'page_text_excludes',
      'page_text_any',
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE PAGE CONTENT');
    expect(JSON.stringify(result)).not.toContain('secret-query');
  });

  it('matches page text case-insensitively after whitespace normalization', () => {
    const result = evaluateTargetEnvironment(
      {
        targetSetupMode: 'none',
        targetSetupInstructions: [],
        readinessChecks: [{ kind: 'page_text_includes', value: 'example workspace' }],
      },
      { url: 'https://example.com/', pageText: 'Example\n\tWorkspace' },
    );

    expect(result.passed).toBe(true);
  });

  it('requires two consecutive passing snapshots before declaring readiness', async () => {
    let now = 0;
    let reads = 0;

    const result = await waitForTargetEnvironment(environment, {
      timeoutMs: 1_000,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      readState: async () => {
        reads += 1;
        return reads === 1
          ? { url: 'https://example.com/login', pageText: 'Sign in' }
          : {
              url: 'https://example.com/document/1',
              pageText: 'Example workspace Document loaded',
            };
      },
    });

    expect(result.passed).toBe(true);
    expect(reads).toBe(3);
  });

  it('retries bounded navigation-context replacement before stable readiness', async () => {
    let now = 0;
    let reads = 0;

    const result = await waitForTargetEnvironment(environment, {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      readState: async () => {
        reads += 1;
        if (reads <= 2) {
          throw new Error('Execution context was destroyed, most likely because of a navigation.');
        }
        return {
          url: 'https://example.com/document/1',
          pageText: 'Example workspace Document loaded',
        };
      },
    });

    expect(result.passed).toBe(true);
    expect(reads).toBe(4);
  });

  it('reports a bounded category when navigation replacement persists to the deadline', async () => {
    let now = 0;

    await expect(
      waitForTargetEnvironment(environment, {
        timeoutMs: 20,
        pollIntervalMs: 10,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        readState: async () => {
          throw new Error(
            'Execution context was destroyed, most likely because of a navigation at a private URL.',
          );
        },
      }),
    ).rejects.toThrow('navigation_context_replaced');
  });

  it('verifies Provider configuration, extension access, origin, and target readiness together', async () => {
    const scenario = {
      name: 'example-read',
      expectedOrigin: 'https://example.com',
      environment,
    } as LiveScenario;
    const result = await verifyConfiguredLiveEnvironment(
      {
        async verifyEnvironment() {
          return {
            passed: true,
            checks: environment.readinessChecks.map(({ kind }) => ({
              kind,
              passed: true,
              detail: 'Matched.',
            })),
          };
        },
        async send() {
          return {
            settings: { hasCodexToken: true },
            tab: { id: 42, supported: true, hasPermission: true },
          };
        },
      },
      scenario,
      { tabId: 42, url: 'https://example.com/document/1' },
      'verify_1',
    );

    expect(result.passed).toBe(true);
    expect(result.checks.map(({ name }) => name)).toEqual([
      'target-origin',
      'codex-token',
      'extension-tab-access',
      'target:url_includes:1',
      'target:url_excludes:2',
      'target:page_text_includes:3',
      'target:page_text_excludes:4',
      'target:page_text_any:5',
    ]);
  });

  it('preserves a safe readiness error category without exposing the raw error', async () => {
    const scenario = {
      name: 'example-read',
      expectedOrigin: 'https://example.com',
      environment,
    } as LiveScenario;
    const result = await verifyConfiguredLiveEnvironment(
      {
        async verifyEnvironment() {
          throw new Error(
            'Target page, context or browser has been closed at https://private.example/secret',
          );
        },
        async send() {
          return {
            settings: { hasCodexToken: true },
            tab: { id: 42, supported: true, hasPermission: true },
          };
        },
      },
      scenario,
      { tabId: 42, url: 'https://example.com/document/1' },
      'verify_closed',
    );

    expect(result.passed).toBe(false);
    expect(JSON.stringify(result)).toContain('page_closed');
    expect(JSON.stringify(result)).not.toContain('private.example');
  });
});
