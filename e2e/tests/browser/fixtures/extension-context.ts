import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLoadedExtensionSession,
  type ExtensionSession,
} from '../../../runner/extension-session';

export type { ExtensionSession } from '../../../runner/extension-session';

/** Launches one fresh system-Chrome profile with only the production extension loaded. */
export async function createExtensionSession(
  headless = false,
  browserArgs: readonly string[] = [],
): Promise<ExtensionSession> {
  const profilePath = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-'));
  const session = await createLoadedExtensionSession({
    profilePath,
    removeProfileOnClose: true,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    headless,
    browserArgs,
  });
  await session.context.route('https://chatgpt.com/backend-api/codex/models**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        models: ['gpt-5.6-terra', 'custom/model:latest'].map((slug) => ({
          slug,
          display_name: slug,
          default_reasoning_level: 'medium',
          context_window: 272000,
          supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(
            (effort) => ({ effort }),
          ),
        })),
      }),
    }),
  );
  return session;
}
