import { isProviderError } from '../src/providers/provider-error';
import { CodexProvider } from '../src/providers/codex/provider';
import { CODEX_MODEL } from '../src/providers/codex/codex-constants';

const accessToken = process.env.CHATBROWSERX_CODEX_ACCESS_TOKEN;

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
    const backend = new CodexProvider({ getAccessToken: async () => accessToken });
    const model = await backend.getModel({ model: CODEX_MODEL, reasoningEffort: 'low' });
    for await (const event of model.getStreamedResponse({
      systemInstructions: 'Follow the user instruction exactly.',
      input: [{ role: 'user', content: 'Reply with exactly OK.' }],
      tools: [],
      handoffs: [],
      outputType: 'text',
      tracing: false,
      modelSettings: { store: false },
      signal: AbortSignal.timeout(90_000),
    })) {
      if (event.type === 'response_done') {
        responseId = event.response.id ?? '';
        text = event.response.output
          .flatMap((item) =>
            item.type === 'message'
              ? item.content.flatMap((part) => (part.type === 'output_text' ? [part.text] : []))
              : [],
          )
          .join('');
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
