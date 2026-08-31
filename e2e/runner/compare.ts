import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareEvaluationResultBatches } from './result-comparison';
import { validateEvaluationCatalog } from './evaluation-catalog';
import { loadEvaluationResults } from './evaluation-result-loader';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,199}$/;

function parseArguments(arguments_: readonly string[]): {
  readonly sampleId: string;
  readonly leftRevision: string;
  readonly rightRevision: string;
  readonly runs?: number;
} {
  const values = arguments_[0] === '--' ? arguments_.slice(1) : [...arguments_];
  if (values.length < 3 || values.length > 4) {
    throw new Error(
      'Usage: npm run e2e:benchmark:compare -- <sample-id> <left-revision> <right-revision> [runs].',
    );
  }
  const [sampleId = '', leftRevision = '', rightRevision = '', runsText] = values;
  if (![sampleId, leftRevision, rightRevision].every((value) => SAFE_ID.test(value))) {
    throw new Error('Sample and revision identifiers are invalid.');
  }
  const runs = runsText === undefined ? undefined : Number(runsText);
  if (runs !== undefined && (!Number.isSafeInteger(runs) || runs < 1)) {
    throw new Error('Comparison runs must be a positive safe integer.');
  }
  return {
    sampleId,
    leftRevision,
    rightRevision,
    ...(runs === undefined ? {} : { runs }),
  };
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const catalog = await validateEvaluationCatalog(repositoryRoot);
  const sample = catalog.samples.find(({ id }) => id === parsed.sampleId);
  if (sample === undefined)
    throw new Error(`Evaluation sample "${parsed.sampleId}" was not found.`);
  const results = await loadEvaluationResults(join(sample.directory, 'benchmark'), sample.id);
  const comparison = compareEvaluationResultBatches({
    sampleId: sample.id,
    scenarioContractVersion: sample.contractVersion,
    runs: parsed.runs ?? sample.requiredRuns,
    leftRevision: parsed.leftRevision,
    rightRevision: parsed.rightRevision,
    results,
  });
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`E2E result comparison failed: ${message}\n`);
  process.exitCode = 1;
});
