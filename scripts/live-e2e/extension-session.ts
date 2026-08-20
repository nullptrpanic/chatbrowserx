import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ExtensionSession {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly serviceWorker: Worker;
  readonly sidePanelPage: Page;
  close(): Promise<void>;
}

export interface LoadedExtensionSessionOptions {
  readonly profilePath: string;
  readonly removeProfileOnClose: boolean;
  readonly channel: string;
  readonly headless: boolean;
}

interface BuiltManifest {
  readonly side_panel?: { readonly default_path?: string };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function waitForExtensionWorker(context: BrowserContext): Promise<Worker> {
  const current = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith('chrome-extension://'));
  if (current !== undefined) return current;
  return context.waitForEvent('serviceworker', {
    timeout: 15_000,
    predicate: (worker) => worker.url().startsWith('chrome-extension://'),
  });
}

async function clearExtensionExecutionCaches(profilePath: string): Promise<void> {
  await Promise.all(
    [
      join(profilePath, 'Default', 'Service Worker'),
      join(profilePath, 'Default', 'Code Cache', 'js'),
    ].map((path) => rm(path, { recursive: true, force: true })),
  );
}

/** Launches the built extension in a caller-owned persistent Chrome profile. */
export async function createLoadedExtensionSession(
  options: LoadedExtensionSessionOptions,
): Promise<ExtensionSession> {
  const extensionPath = join(repositoryRoot, 'dist');
  const manifestPath = join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BuiltManifest;
  const sidePanelPath = manifest.side_panel?.default_path;
  if (typeof sidePanelPath !== 'string' || sidePanelPath.length === 0) {
    throw new Error('Built extension has no Side Panel path.');
  }
  await clearExtensionExecutionCaches(options.profilePath);

  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(options.profilePath, {
      channel: options.channel,
      headless: options.headless,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    const serviceWorker = await waitForExtensionWorker(context);
    const extensionId = new URL(serviceWorker.url()).host;
    if (extensionId.length === 0) throw new Error('Extension ID could not be discovered.');
    const sidePanelPage = await context.newPage();
    await sidePanelPage.goto(`chrome-extension://${extensionId}/${sidePanelPath}`);

    let closed = false;
    return {
      context,
      extensionId,
      serviceWorker,
      sidePanelPage,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await context?.close();
        } finally {
          if (options.removeProfileOnClose) {
            await rm(options.profilePath, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => undefined);
    if (options.removeProfileOnClose) {
      await rm(options.profilePath, { recursive: true, force: true });
    }
    throw error;
  }
}
