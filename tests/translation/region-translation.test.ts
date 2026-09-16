import { expect, it } from 'vitest';
import { translationTextsSchema } from '../../src/translation/region-translation';

it('accepts optional bounded context on text requests', () => {
  const input = { sessionId: 's', texts: [{ id: 'p', text: 'Save' }] };
  expect(translationTextsSchema.safeParse(input).success).toBe(true);
  expect(translationTextsSchema.safeParse({ ...input, context: '' }).success).toBe(true);
  expect(translationTextsSchema.safeParse({ ...input, context: 'a'.repeat(6000) }).success).toBe(
    true,
  );
  expect(translationTextsSchema.safeParse({ ...input, context: 'a'.repeat(6001) }).success).toBe(
    false,
  );
});
