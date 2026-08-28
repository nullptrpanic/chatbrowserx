import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJsonContract, readJsonFile } from './json-contract';
import type { LiveScenario } from './live-types';

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;
const nonEmptyString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must be a non-empty string.' });
const positiveInteger = z.number().refine((value) => Number.isSafeInteger(value) && value >= 1, {
  message: 'must be a positive safe integer.',
});
const nonNegativeInteger = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0, {
  message: 'must be a non-negative safe integer.',
});
const nonEmptyStrings = z
  .array(nonEmptyString)
  .min(1, { message: 'must contain one or more non-empty strings.' });

const readinessCheckSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['url_includes', 'url_excludes', 'page_text_includes', 'page_text_excludes']),
      value: nonEmptyString,
    })
    .strict(),
  z.object({ kind: z.literal('page_text_any'), values: nonEmptyStrings }).strict(),
]);

const environmentSchema = z
  .object({
    targetSetupMode: z.enum(['none', 'interactive']),
    targetSetupInstructions: z.array(nonEmptyString),
    readinessChecks: z
      .array(readinessCheckSchema)
      .min(1, { message: 'must contain one or more checks.' }),
  })
  .strict()
  .superRefine((environment, context) => {
    if (
      environment.targetSetupMode === 'interactive' &&
      environment.targetSetupInstructions.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['targetSetupInstructions'],
        message: 'must contain one or more non-empty strings.',
      });
    }
  });

const policySchema = z
  .object({
    expectedSubmittedTypeCount: nonNegativeInteger.optional(),
    expectedToolCounts: z.record(nonEmptyString, nonNegativeInteger).optional(),
    requiredVerifiedTools: nonEmptyStrings.optional(),
    forbidScreenshotInspect: z.boolean(),
    forbidSubmittedType: z.boolean(),
    maxScrollSegmentsPerCall: positiveInteger.optional(),
    stopScrollingAfterActiveElementNames: z.array(nonEmptyString).optional(),
    requireVerticalBoundaryCoverage: z.boolean().optional(),
    maxAttachmentCount: nonNegativeInteger.optional(),
    requiredTypedTextIncludes: z.array(nonEmptyString).optional(),
    requiredToolOutputIncludes: z.array(nonEmptyString).optional(),
    finalTextIncludes: nonEmptyStrings,
    finalTextIncludesAny: z.array(nonEmptyStrings).min(1).optional(),
    requireFreshProviderContext: z.boolean().optional(),
    finalTextExcludes: z.array(nonEmptyString).optional(),
    minFinalTextLength: nonNegativeInteger,
    minimumMarkdownTableRows: positiveInteger.optional(),
  })
  .strict();

const sampleSchema = z
  .object({
    schemaVersion: z.literal(3, { error: 'must equal 3.' }),
    id: nonEmptyString.regex(SAFE_ID, { message: 'must use lowercase kebab-case.' }),
    contractVersion: positiveInteger,
    description: nonEmptyString,
    requiredRuns: positiveInteger,
    target: z
      .object({
        url: nonEmptyString,
        expectedOrigin: nonEmptyString,
        readinessTimeoutMs: positiveInteger,
      })
      .strict(),
    environment: environmentSchema,
    input: z.object({ text: nonEmptyString }).strict(),
    execution: z
      .object({
        taskTimeoutMs: positiveInteger,
        maxToolCalls: positiveInteger,
        requiredTools: nonEmptyStrings,
        forbiddenTools: z.array(nonEmptyString),
      })
      .strict(),
    sideEffects: z.object({ mode: z.enum(['read_only', 'page_state_mutation']) }).strict(),
    evaluation: z
      .object({
        method: z.literal('deterministic', { error: 'must equal deterministic.' }),
        policy: policySchema,
      })
      .strict(),
  })
  .strict();

export type SampleSideEffectMode = z.infer<typeof sampleSchema>['sideEffects']['mode'];
export type EvaluationPolicyDefinition = z.infer<typeof policySchema>;
export type EvaluationSampleDefinition = z.infer<typeof sampleSchema>;

export interface LoadedEvaluationSample {
  readonly directory: string;
  readonly definition: EvaluationSampleDefinition;
  readonly scenario: LiveScenario;
}

/** Parses one sample identifier without consulting a code-owned registry. */
export function parseEvaluationSampleId(arguments_: readonly string[]): string {
  const normalized = arguments_[0] === '--' ? arguments_.slice(1) : [...arguments_];
  const id = normalized[0]?.trim();
  if (normalized.length !== 1 || id === undefined || id.length === 0) {
    throw new Error('Usage: pass exactly one <sample-id> argument.');
  }
  if (!SAFE_ID.test(id)) throw new Error('Sample ID must use lowercase kebab-case.');
  return id;
}

/** Requires an explicit process-local opt-in before a sample may mutate remote data. */
export function validateEvaluationSampleAuthorization(
  scenario: LiveScenario,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (scenario.allowRemoteMutation && environment.CHATBROWSERX_LIVE_ALLOW_MUTATION !== '1') {
    throw new Error(
      `Live E2E sample "${scenario.name}" mutates remote data and requires explicit opt-in via CHATBROWSERX_LIVE_ALLOW_MUTATION=1.`,
    );
  }
}

export function parseEvaluationSample(
  value: unknown,
  directoryId: string,
): EvaluationSampleDefinition {
  const sample = parseJsonContract(sampleSchema, value, `Sample "${directoryId}"`);
  if (sample.id !== directoryId) {
    throw new Error(`Sample "${sample.id}" must use a directory with the same name.`);
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(sample.target.url);
  } catch (error) {
    throw new Error(`Sample "${sample.id}" target.url must be an absolute URL.`, { cause: error });
  }
  if (targetUrl.origin !== sample.target.expectedOrigin) {
    throw new Error(`Sample "${sample.id}" target.expectedOrigin must match target.url.`);
  }
  const forbiddenTools = new Set(sample.execution.forbiddenTools);
  const overlap = sample.execution.requiredTools.find((tool) => forbiddenTools.has(tool));
  if (overlap !== undefined) {
    throw new Error(
      `Sample "${sample.id}" tool "${overlap}" cannot be both required and forbidden.`,
    );
  }
  return sample;
}

export function materializeLiveScenario(sample: EvaluationSampleDefinition): LiveScenario {
  const policy = sample.evaluation.policy;
  return {
    contractVersion: sample.contractVersion,
    name: sample.id,
    description: sample.description,
    startUrl: sample.target.url,
    expectedOrigin: sample.target.expectedOrigin,
    taskText: sample.input.text,
    readinessTimeoutMs: sample.target.readinessTimeoutMs,
    environment: sample.environment,
    taskTimeoutMs: sample.execution.taskTimeoutMs,
    maxToolCalls: sample.execution.maxToolCalls,
    requiredTools: sample.execution.requiredTools,
    forbiddenTools: sample.execution.forbiddenTools,
    forbidScreenshotInspect: policy.forbidScreenshotInspect,
    forbidSubmittedType: policy.forbidSubmittedType,
    finalTextIncludes: policy.finalTextIncludes,
    minFinalTextLength: policy.minFinalTextLength,
    ...(policy.expectedSubmittedTypeCount === undefined
      ? {}
      : { expectedSubmittedTypeCount: policy.expectedSubmittedTypeCount }),
    ...(policy.expectedToolCounts === undefined
      ? {}
      : { expectedToolCounts: policy.expectedToolCounts }),
    ...(policy.requiredVerifiedTools === undefined
      ? {}
      : { requiredVerifiedTools: policy.requiredVerifiedTools }),
    ...(policy.maxScrollSegmentsPerCall === undefined
      ? {}
      : { maxScrollSegmentsPerCall: policy.maxScrollSegmentsPerCall }),
    ...(policy.stopScrollingAfterActiveElementNames === undefined
      ? {}
      : { stopScrollingAfterActiveElementNames: policy.stopScrollingAfterActiveElementNames }),
    ...(policy.requireVerticalBoundaryCoverage === undefined
      ? {}
      : { requireVerticalBoundaryCoverage: policy.requireVerticalBoundaryCoverage }),
    ...(policy.maxAttachmentCount === undefined
      ? {}
      : { maxAttachmentCount: policy.maxAttachmentCount }),
    ...(policy.requiredTypedTextIncludes === undefined
      ? {}
      : { requiredTypedTextIncludes: policy.requiredTypedTextIncludes }),
    ...(policy.requiredToolOutputIncludes === undefined
      ? {}
      : { requiredToolOutputIncludes: policy.requiredToolOutputIncludes }),
    ...(policy.finalTextIncludesAny === undefined
      ? {}
      : { finalTextIncludesAny: policy.finalTextIncludesAny }),
    ...(policy.requireFreshProviderContext === undefined
      ? {}
      : { requireFreshProviderContext: policy.requireFreshProviderContext }),
    ...(policy.finalTextExcludes === undefined
      ? {}
      : { finalTextExcludes: policy.finalTextExcludes }),
    ...(policy.minimumMarkdownTableRows === undefined
      ? {}
      : { minimumMarkdownTableRows: policy.minimumMarkdownTableRows }),
    allowRemoteMutation: sample.sideEffects.mode === 'page_state_mutation',
  };
}

export async function loadEvaluationSample(
  repositoryRoot: string,
  id: string,
): Promise<LoadedEvaluationSample> {
  if (!SAFE_ID.test(id)) throw new Error('Sample ID must use lowercase kebab-case.');
  const directory = join(repositoryRoot, 'e2e', 'samples', id);
  const definition = parseEvaluationSample(await readJsonFile(join(directory, 'sample.json')), id);
  return { directory, definition, scenario: materializeLiveScenario(definition) };
}

export async function listEvaluationSamples(
  repositoryRoot: string,
): Promise<readonly LoadedEvaluationSample[]> {
  const samplesRoot = join(repositoryRoot, 'e2e', 'samples');
  const entries = await readdir(samplesRoot, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error('The e2e samples directory is missing.', { cause: error });
  });
  const ids = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (ids.length === 0) throw new Error('The e2e sample catalog is empty.');
  return Promise.all(ids.map(async (id) => loadEvaluationSample(repositoryRoot, id)));
}
