import { describe, expect, it } from 'vitest';
import { sanitizeReplayHeaders, summarizeReplaySseResponse } from '../../runner/provider-replay';

describe('provider request replay diagnostics', () => {
  it('removes HTTP/2 pseudo and transport headers without exposing their values', () => {
    expect(
      sanitizeReplayHeaders({
        ':authority': 'chatgpt.com',
        authorization: 'Bearer secret',
        'content-length': '123',
        'content-type': 'application/json',
      }),
    ).toEqual({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
    });
  });

  it('reports only structural SSE and bounded error labels', () => {
    const body = Buffer.from(
      [
        'event: response.failed',
        'data: ' +
          JSON.stringify({
            type: 'response.failed',
            response: {
              error: {
                code: 'server_error',
                type: 'upstream_failure',
                message: 'secret provider detail must not escape',
              },
            },
          }),
        '',
      ].join('\n'),
      'utf8',
    );

    const summary = summarizeReplaySseResponse(body, 200, 'text/event-stream');

    expect(summary).toMatchObject({
      status: 200,
      completed: false,
      failed: true,
      eventTypes: ['response.failed'],
      errorCodes: ['server_error'],
      errorTypes: ['upstream_failure'],
    });
    expect(JSON.stringify(summary)).not.toContain('secret provider detail');
  });

  it('does not expose unsafe free-form error labels', () => {
    const body = Buffer.from(
      `data: ${JSON.stringify({ type: 'error', error: { code: 'contains user data' } })}\n`,
      'utf8',
    );

    expect(summarizeReplaySseResponse(body, 200, 'text/event-stream')).toMatchObject({
      failed: true,
      errorCodes: [],
    });
  });
});
