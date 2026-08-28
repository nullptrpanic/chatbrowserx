import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionSession } from './extension-session';
import { createLoadedExtensionSession } from './extension-session';
import { acquireLiveProfileLock, resolveLiveProfilePath } from './live-profile';
import { resolveLiveProductTarget, resolveProductRevision } from './product-revision';
import { settingsTransferPayload } from './settings-transfer';
import type { ExtensionMessage, ExtensionResponse } from '../../src/shared/protocol/message-types';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function send(session: ExtensionSession, message: ExtensionMessage): Promise<unknown> {
  const response: unknown = await session.sidePanelPage.evaluate(
    async (request) => chrome.runtime.sendMessage(request),
    message,
  );
  if (typeof response !== 'object' || response === null) {
    throw new Error(`${message.type} returned an invalid extension response.`);
  }
  const envelope = response as ExtensionResponse<unknown>;
  if (envelope.version !== 1 || envelope.requestId !== message.requestId) {
    throw new Error(`${message.type} returned an invalid extension response.`);
  }
  if (!envelope.ok) {
    throw new Error(
      `${message.type} failed with ${envelope.error.code}: ${envelope.error.message}`,
    );
  }
  return envelope.data;
}

async function loadSession(profilePath: string, extensionPath: string): Promise<ExtensionSession> {
  return createLoadedExtensionSession({
    profilePath,
    removeProfileOnClose: false,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
    headless: false,
    extensionPath,
  });
}

async function main(): Promise<void> {
  const workspaceRevision = await resolveProductRevision(repositoryRoot).catch(() => 'unknown');
  const productTarget = resolveLiveProductTarget({
    environment: process.env,
    repositoryRoot,
    workspaceRevision,
  });
  const sourceExtensionPath = resolve(repositoryRoot, 'dist');
  if (productTarget.extensionPath === sourceExtensionPath) {
    throw new Error('The settings target must be an isolated external extension build.');
  }

  const profilePath = resolveLiveProfilePath(process.env, repositoryRoot);
  const lock = await acquireLiveProfileLock(profilePath);
  let session: ExtensionSession | null = null;
  try {
    session = await loadSession(profilePath, sourceExtensionPath);
    const sourceSettings = await send(session, {
      version: 1,
      requestId: randomUUID(),
      type: 'settings.get',
      payload: {},
    });
    const transfer = settingsTransferPayload(sourceSettings);
    await session.close();
    session = null;

    session = await loadSession(profilePath, productTarget.extensionPath);
    await send(session, {
      version: 1,
      requestId: randomUUID(),
      type: 'settings.save',
      payload: transfer,
    });
    const targetSettings = settingsTransferPayload(
      await send(session, {
        version: 1,
        requestId: randomUUID(),
        type: 'settings.get',
        payload: {},
      }),
    );
    if (JSON.stringify(targetSettings) !== JSON.stringify(transfer)) {
      throw new Error('The isolated extension did not retain the transferred settings.');
    }
    process.stdout.write(
      `Seeded isolated live E2E settings for ${productTarget.productRevision}; no credential values were logged.\n`,
    );
  } finally {
    await session?.close().catch(() => undefined);
    await lock.release();
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Live E2E settings transfer failed: ${message}\n`);
  process.exitCode = 1;
});
