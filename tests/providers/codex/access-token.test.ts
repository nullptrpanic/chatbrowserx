import { describe, expect, it } from 'vitest';
import { extractChatGptAccountId } from '../../../src/providers/codex/access-token';

/** Builds an unsigned synthetic JWT that cannot be used as a real credential. */
function jwt(payload: Readonly<Record<string, unknown>>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

describe('extractChatGptAccountId', () => {
  it('reads the current nested ChatGPT account claim', () => {
    expect(
      extractChatGptAccountId(
        jwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_nested',
            chatgpt_plan_type: 'plus',
          },
        }),
      ),
    ).toBe('acct_nested');
  });

  it('supports the top-level compatibility claim', () => {
    expect(extractChatGptAccountId(jwt({ chatgpt_account_id: 'acct_top_level' }))).toBe(
      'acct_top_level',
    );
  });

  it.each([
    'not-a-jwt',
    'a.invalid-json.c',
    jwt({}),
    jwt({ chatgpt_account_id: '   ' }),
    jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 42 } }),
  ])('rejects malformed or incomplete tokens without echoing them', (token) => {
    let thrown: unknown;
    try {
      extractChatGptAccountId(token);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: 'ProviderError', code: 'AUTH' });
    expect(String(thrown)).not.toContain(token);
  });
});
