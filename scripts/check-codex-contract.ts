import type { CredentialStore } from '../src/persistence/credential-store';
import { isProviderError } from '../src/providers/provider-errors';
import { CodexProvider } from '../src/providers/codex/codex-provider';
import { CODEX_MODEL } from '../src/providers/codex/codex-constants';

const accessToken = process.env.CHATBROWSERX_CODEX_ACCESS_TOKEN;

/** Exposes one process-scoped token through the same trusted Provider boundary. */
function environmentCredentialStore(token: string): CredentialStore {
  return {
    initialize: async () => undefined,
    getCodexAccessToken: async () => token,
    setCodexAccessToken: async () => undefined,
    getTavilyKey: async () => undefined,
    setTavilyKey: async () => undefined,
    getSandboxToken: async () => undefined,
    setSandboxToken: async () => undefined,
  };
}

/** Runs the opt-in live contract check without printing credentials or response bodies. */
async function main(): Promise<void> {
  if (!accessToken) {
    console.error('CHATBROWSERX_CODEX_ACCESS_TOKEN is required');
    process.exitCode = 2;
    return;
  }

  const startedAt = performance.now();
  let text = '';
  let responseId = '';
  try {
    const provider = new CodexProvider(environmentCredentialStore(accessToken));
    for await (const event of provider.stream(
      {
        model: CODEX_MODEL,
        reasoningEffort: 'low',
        systemPrompt: 'Follow the user instruction exactly.',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply with exactly OK.' }],
          },
        ],
        tools: [],
      },
      new AbortController().signal,
    )) {
      if (event.type === 'text.delta') {
        text += event.delta;
      } else if (event.type === 'response.started') {
        responseId = event.responseId;
      }
    }
  } catch (error) {
    console.error(`contract check failed: ${isProviderError(error) ? error.code : 'UNKNOWN'}`);
    process.exitCode = 1;
    return;
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  if (text.trim() !== 'OK') {
    console.error(`contract check failed: OUTPUT elapsed=${elapsedMs}ms`);
    process.exitCode = 1;
    return;
  }
  console.log(`contract check passed: response=${responseId.slice(0, 12)} elapsed=${elapsedMs}ms`);
}

await main();
