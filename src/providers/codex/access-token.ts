import { z } from 'zod';
import { providerErrorFromCode } from '../../agent/model/model-provider-error';

const tokenPayloadSchema = z
  .object({
    'https://api.openai.com/auth': z
      .object({ chatgpt_account_id: z.string().optional() })
      .passthrough()
      .optional(),
    chatgpt_account_id: z.string().optional(),
  })
  .passthrough();

/** Decodes one base64url JWT section without relying on Node-only APIs. */
function decodeBase64Url(section: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(section) || section.length % 4 === 1) {
    throw providerErrorFromCode('AUTH');
  }

  const base64 = section.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw providerErrorFromCode('AUTH');
  }
}

/** Extracts the ChatGPT account ID from a syntactically valid Codex access token. */
export function extractChatGptAccountId(token: string): string {
  try {
    const sections = token.trim().split('.');
    if (sections.length !== 3 || !sections[1]) {
      throw providerErrorFromCode('AUTH');
    }

    const payload = tokenPayloadSchema.parse(JSON.parse(decodeBase64Url(sections[1])) as unknown);
    const accountId =
      payload['https://api.openai.com/auth']?.chatgpt_account_id ?? payload.chatgpt_account_id;
    if (accountId === undefined || accountId.trim().length === 0) {
      throw providerErrorFromCode('AUTH');
    }
    return accountId.trim();
  } catch {
    throw providerErrorFromCode('AUTH');
  }
}
