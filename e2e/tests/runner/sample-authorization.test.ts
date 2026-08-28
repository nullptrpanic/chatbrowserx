import { describe, expect, it } from 'vitest';
import {
  parseEvaluationSampleId,
  validateEvaluationSampleAuthorization,
} from '../../runner/sample-loader';
import { liveScenario } from './fixtures';

const readOnlyScenario = liveScenario({
  contractVersion: 1,
  description: 'Reads an example page.',
  taskText: 'Read the page.',
});

const mutationScenario = liveScenario({
  name: 'example-write',
  allowRemoteMutation: true,
});

describe('sample command authorization', () => {
  it('parses one path-safe sample ID with an optional npm separator', () => {
    expect(parseEvaluationSampleId(['example-read'])).toBe('example-read');
    expect(parseEvaluationSampleId(['--', 'example-read'])).toBe('example-read');
  });

  it('rejects absent, extra, or path-unsafe sample IDs', () => {
    expect(() => parseEvaluationSampleId([])).toThrow('Usage');
    expect(() => parseEvaluationSampleId(['one', 'two'])).toThrow('Usage');
    expect(() => parseEvaluationSampleId(['../example'])).toThrow('lowercase kebab-case');
  });

  it('allows read-only samples without an opt-in', () => {
    expect(() => validateEvaluationSampleAuthorization(readOnlyScenario, {})).not.toThrow();
  });

  it('requires an explicit process-local opt-in for mutation samples', () => {
    expect(() => validateEvaluationSampleAuthorization(mutationScenario, {})).toThrow(
      'CHATBROWSERX_LIVE_ALLOW_MUTATION=1',
    );
    expect(() =>
      validateEvaluationSampleAuthorization(mutationScenario, {
        CHATBROWSERX_LIVE_ALLOW_MUTATION: '1',
      }),
    ).not.toThrow();
  });
});
