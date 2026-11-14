import { z } from 'zod';
import { createToolServiceToken } from '../../../src/tools/service-resolver';
import { strictFunctionTool } from '../../../src/tools/model-tool';
import type { RegisteredTool, ToolFailureAction } from '../../../src/tools/types';

/** Synthetic services keep host checkpoint tests independent of a retired search provider. */
export interface FixtureExecutionPort {
  isConfigured(): Promise<boolean>;
  search(input: unknown, signal: AbortSignal): Promise<unknown>;
  extract(input: unknown, signal: AbortSignal): Promise<unknown>;
  crawl(input: unknown, signal: AbortSignal): Promise<unknown>;
}
export const fixtureService = createToolServiceToken<FixtureExecutionPort>('fixture');
type FailureCode = 'AUTH' | 'RATE_LIMIT' | 'TRANSIENT' | 'INVALID_RESPONSE' | 'ABORTED';
export function fixtureError(code: FailureCode): Error & { code: FailureCode } {
  return Object.assign(new Error('Fixture failure.'), {
    code,
    name: code === 'ABORTED' ? 'AbortError' : 'FixtureError',
  });
}
function failure(error: unknown): ToolFailureAction | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  switch (error.code) {
    case 'AUTH':
      return {
        type: 'auth',
        reason: 'fixture_authentication_required',
        userMessage: 'Fixture authentication is required.',
      };
    case 'RATE_LIMIT':
      return {
        type: 'pause',
        reason: 'fixture_retry_required',
        code: 'RateLimitError',
        recoveryAction: 'resume_later',
        userMessage: 'Fixture rate limit.',
      };
    case 'TRANSIENT':
      return {
        type: 'pause',
        reason: 'fixture_retry_required',
        userMessage: 'Fixture is unavailable.',
      };
    case 'INVALID_RESPONSE':
      return {
        type: 'fail',
        reason: 'invalid_fixture_response',
        code: 'InvalidProviderResponse',
        recoveryAction: 'review_provider_status',
        userMessage: 'Fixture response is invalid.',
      };
    default:
      return null;
  }
}
export const fixtureTools: readonly RegisteredTool[] = (['search', 'extract'] as const).map(
  (operation) => ({
    declaration: {
      name: `fixture_${operation}`,
      definition: strictFunctionTool(`fixture_${operation}`, 'Test fixture.', {}),
      schema: z.record(z.string(), z.unknown()),
      policy: {
        budgetGroup: 'fixture',
        budgetLabel: 'Fixture',
        maxCalls: 8,
        errorSource: 'fixture',
      },
      execute: async (call, _context, services, signal) => ({
        output: JSON.stringify({
          ok: true,
          ...((await services.get(fixtureService)[operation](call.arguments, signal)) as object),
        }),
      }),
      failure,
    },
  }),
);
