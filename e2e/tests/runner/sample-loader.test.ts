import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEvaluationSample } from '../../runner/sample-loader';
import { evaluationSampleDefinition } from './fixtures';

const sample = evaluationSampleDefinition();

async function createSampleRoot(value: unknown = sample): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-sample-loader-'));
  const directory = join(root, 'e2e', 'samples', sample.id);
  await mkdir(join(directory, 'results'), { recursive: true });
  await writeFile(join(directory, 'sample.json'), JSON.stringify(value), 'utf8');
  return root;
}

describe('self-contained E2E samples', () => {
  it('reconstructs the complete live scenario from sample.json', async () => {
    const root = await createSampleRoot();

    const loaded = await loadEvaluationSample(root, sample.id);

    expect(loaded.definition).toEqual(sample);
    expect(loaded.scenario).toEqual({
      contractVersion: 3,
      name: sample.id,
      description: 'Reads one complete example page.',
      exclusiveResources: [],
      startUrl: 'https://example.com/document',
      expectedOrigin: 'https://example.com',
      taskText: 'Read the complete page without changing it.',
      readinessTimeoutMs: 10_000,
      environment: {
        targetSetupMode: 'interactive',
        targetSetupInstructions: ['Sign in to the example site with the evaluation account.'],
        readinessChecks: [
          { kind: 'url_excludes', value: '/login' },
          {
            kind: 'page_text_any',
            values: ['Example document', 'Example workspace'],
          },
        ],
      },
      taskTimeoutMs: 20_000,
      maxToolCalls: 8,
      requiredTools: ['browser_inspect'],
      forbiddenTools: ['browser_type'],
      forbidScreenshotInspect: true,
      forbidSubmittedType: true,
      maxScrollSegmentsPerCall: 2,
      requireVerticalBoundaryCoverage: true,
      finalTextIncludes: ['complete'],
      finalTextIncludesAny: [['top', 'beginning']],
      requireFreshProviderContext: true,
      finalTextExcludes: ['blocked'],
      minFinalTextLength: 40,
      allowRemoteMutation: false,
    });
  });

  it('rejects a sample without a target URL', async () => {
    const value = structuredClone(sample) as unknown as {
      target: { url?: string };
    };
    delete value.target.url;
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow('target.url');
  });

  it('rejects a target origin that differs from the URL', async () => {
    const value = structuredClone(sample) as unknown as {
      target: { expectedOrigin: string };
    };
    value.target.expectedOrigin = 'https://different.example.com';
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      'target.expectedOrigin must match target.url',
    );
  });

  it('rejects a sample without materialized input', async () => {
    const value = structuredClone(sample) as unknown as {
      input: { text?: string };
    };
    delete value.input.text;
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow('input.text');
  });

  it('materializes required raw tool-result literals', async () => {
    const value = structuredClone(sample) as typeof sample & {
      evaluation: {
        policy: typeof sample.evaluation.policy & {
          requiredToolResultIncludes: string[];
        };
      };
    };
    value.evaluation.policy.requiredToolResultIncludes = ['TAIL_DIAGNOSTIC'];
    const root = await createSampleRoot(value);

    const loaded = await loadEvaluationSample(root, sample.id);

    expect(loaded.scenario).toMatchObject({
      requiredToolResultIncludes: ['TAIL_DIAGNOSTIC'],
    });
  });

  it('materializes named mutation readback requirements', async () => {
    const value = structuredClone(sample) as unknown as {
      evaluation: { policy: Record<string, unknown> };
    };
    value.evaluation.policy.requiredMutationReadbacks = [
      { actionName: 'Save', includes: ['unique event', 'Saved'] },
    ];
    const root = await createSampleRoot(value);

    const loaded = await loadEvaluationSample(root, sample.id);

    expect(loaded.scenario).toMatchObject({
      requiredMutationReadbacks: [{ actionName: 'Save', includes: ['unique event', 'Saved'] }],
    });
  });

  it('materializes the navigation keypress allowlist', async () => {
    const value = structuredClone(sample) as unknown as {
      evaluation: { policy: Record<string, unknown> };
    };
    value.evaluation.policy.allowedKeypresses = ['HOME'];
    const root = await createSampleRoot(value);

    const loaded = await loadEvaluationSample(root, sample.id);

    expect(loaded.scenario).toMatchObject({ allowedKeypresses: ['HOME'] });
  });

  it('materializes exclusive remote resource keys', async () => {
    const value = structuredClone(sample);
    value.resources.exclusive = ['lark:chat:self', 'lark:mailbox:self'];
    const root = await createSampleRoot(value);

    const loaded = await loadEvaluationSample(root, sample.id);

    expect(loaded.scenario.exclusiveResources).toEqual(['lark:chat:self', 'lark:mailbox:self']);
  });

  it('rejects duplicate exclusive resource keys', async () => {
    const value = structuredClone(sample);
    value.resources.exclusive = ['lark:chat:self', 'lark:chat:self'];
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      'resources.exclusive must not contain duplicate resource keys',
    );
  });

  it('rejects an interactive environment without setup instructions', async () => {
    const value = structuredClone(sample) as unknown as {
      environment: { targetSetupInstructions: string[] };
    };
    value.environment.targetSetupInstructions = [];
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      'environment.targetSetupInstructions',
    );
  });

  it('rejects an environment without machine-readable readiness checks', async () => {
    const value = structuredClone(sample) as unknown as {
      environment: { readinessChecks: unknown[] };
    };
    value.environment.readinessChecks = [];
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      'environment.readinessChecks',
    );
  });

  it('rejects an unknown readiness check kind', async () => {
    const value = structuredClone(sample) as unknown as {
      environment: { readinessChecks: unknown[] };
    };
    value.environment.readinessChecks = [{ kind: 'cookie_exists', value: 'session' }];
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      'environment.readinessChecks[0].kind',
    );
  });

  it('rejects the superseded sample schema with a bounded migration error', async () => {
    const value = structuredClone(sample) as unknown as {
      schemaVersion: number;
    };
    value.schemaVersion = 3;
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      'schemaVersion must equal 4',
    );
  });

  it.each([
    [
      'sideEffects.allowed',
      (value: Record<string, unknown>) => {
        (value.sideEffects as Record<string, unknown>).allowed = ['Legacy prose whitelist.'];
      },
    ],
    [
      'evaluation.requiredEvidence',
      (value: Record<string, unknown>) => {
        (value.evaluation as Record<string, unknown>).requiredEvidence = ['Legacy evidence prose.'];
      },
    ],
    [
      'evaluation.failureConditions',
      (value: Record<string, unknown>) => {
        (value.evaluation as Record<string, unknown>).failureConditions = ['Legacy failure prose.'];
      },
    ],
  ])('rejects removed schema v3 field %s', async (field, addRemovedField) => {
    const value = structuredClone(sample) as unknown as Record<string, unknown>;
    addRemovedField(value);
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      `${field} is not supported`,
    );
  });

  it.each([
    ['topLevel', (value: Record<string, unknown>) => (value.topLevel = true)],
    [
      'evaluation.policy.extraCheck',
      (value: Record<string, unknown>) => {
        const evaluation = value.evaluation as Record<string, unknown>;
        (evaluation.policy as Record<string, unknown>).extraCheck = true;
      },
    ],
  ])('rejects unknown current-schema field %s', async (field, addUnknownField) => {
    const value = structuredClone(sample) as unknown as Record<string, unknown>;
    addUnknownField(value);
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      `${field} is not supported`,
    );
  });

  it('rejects an unknown evaluation method', async () => {
    const value = structuredClone(sample) as unknown as {
      evaluation: { method: string };
    };
    value.evaluation.method = 'model_judge';
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      'evaluation.method must equal deterministic',
    );
  });

  it('rejects a tool that is both required and forbidden', async () => {
    const value = structuredClone(sample) as unknown as {
      execution: { forbiddenTools: string[] };
    };
    value.execution.forbiddenTools = ['browser_inspect'];
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).rejects.toThrow(
      'cannot be both required and forbidden',
    );
  });

  it('materializes mutation authorization from the side-effect mode alone', async () => {
    const value = structuredClone(sample) as unknown as {
      sideEffects: { mode: string };
    };
    value.sideEffects = { mode: 'page_state_mutation' };
    const root = await createSampleRoot(value);

    await expect(loadEvaluationSample(root, sample.id)).resolves.toMatchObject({
      definition: { sideEffects: { mode: 'page_state_mutation' } },
      scenario: { allowRemoteMutation: true },
    });
  });
});
