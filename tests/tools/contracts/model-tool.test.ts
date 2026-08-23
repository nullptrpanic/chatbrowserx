import { describe, expect, it } from 'vitest';
import { strictFunctionTool } from '../../../src/tools/contracts/model-tool';

describe('strictFunctionTool', () => {
  it('derives the closed required object contract from its properties', () => {
    expect(
      strictFunctionTool('lookup', 'Look up one value.', {
        key: { type: 'string' },
        limit: { type: 'integer' },
      }),
    ).toEqual({
      type: 'function',
      name: 'lookup',
      description: 'Look up one value.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['key', 'limit'],
        additionalProperties: false,
      },
      strict: true,
    });
  });
});
