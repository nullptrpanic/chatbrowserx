import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLoadedExtensionSession,
  type ExtensionSession,
} from '../../../scripts/live-e2e/extension-session';

export type { ExtensionSession } from '../../../scripts/live-e2e/extension-session';

/** Launches one fresh system-Chrome profile with only the production extension loaded. */
export async function createExtensionSession(): Promise<ExtensionSession> {
  const profilePath = await mkdtemp(join(tmpdir(), 'chatbrowserx-e2e-'));
  return createLoadedExtensionSession({
    profilePath,
    removeProfileOnClose: true,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    headless: false,
  });
}
