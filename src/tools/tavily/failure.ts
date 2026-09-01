import type { ToolFailureAction } from '../types';
import { isTavilyError } from './error';

/** Maps Tavily failures to durable task behavior without exposing the client to Agent core. */
export function tavilyFailure(error: unknown): ToolFailureAction | null {
  if (!isTavilyError(error) || error.code === 'ABORTED') return null;
  switch (error.code) {
    case 'AUTH':
      return {
        type: 'auth',
        reason: 'tavily_authentication_required',
        userMessage: 'Tavily authentication is required. Update the Tavily API Key in Settings.',
      };
    case 'RATE_LIMIT':
      return {
        type: 'pause',
        reason: 'tavily_retry_required',
        code: 'RateLimitError',
        recoveryAction: 'resume_later',
        userMessage: 'The Tavily rate limit was reached.',
      };
    case 'TRANSIENT':
      return {
        type: 'pause',
        reason: 'tavily_retry_required',
        userMessage: 'Tavily is temporarily unavailable.',
      };
    case 'INVALID_RESPONSE':
      return {
        type: 'fail',
        reason: 'invalid_tavily_response',
        code: 'InvalidProviderResponse',
        recoveryAction: 'review_provider_status',
        userMessage: 'Tavily returned an invalid response.',
      };
  }
}
