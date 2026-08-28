import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoadedExtensionSession } from './extension-session';
import { evaluateEnvironmentDoctor, type EnvironmentDoctorFacts } from './environment-doctor';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface PackageManifest {
  readonly engines?: { readonly node?: string };
}

interface ExtensionManifest {
  readonly manifest_version?: number;
  readonly side_panel?: { readonly default_path?: string };
}

async function pathIsDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((entry) => entry.isDirectory())
    .catch(() => false);
}

async function extensionBuildIsValid(): Promise<boolean> {
  try {
    const buildPath = join(repositoryRoot, 'dist');
    const manifest = JSON.parse(
      await readFile(join(buildPath, 'manifest.json'), 'utf8'),
    ) as ExtensionManifest;
    const sidePanelPath = manifest.side_panel?.default_path;
    if (
      manifest.manifest_version !== 3 ||
      typeof sidePanelPath !== 'string' ||
      sidePanelPath.length === 0
    ) {
      return false;
    }
    return stat(join(buildPath, sidePanelPath))
      .then((entry) => entry.isFile())
      .catch(() => false);
  } catch {
    return false;
  }
}

async function configuredBrowserLaunches(): Promise<boolean> {
  const browser = await chromium
    .launch({
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
      headless: true,
    })
    .catch(() => null);
  if (browser === null) return false;
  await browser.close().catch(() => undefined);
  return true;
}

async function extensionRuntimeIsReady(): Promise<boolean> {
  const runtimePath = join(repositoryRoot, 'e2e/.runtime');
  await mkdir(runtimePath, { recursive: true });
  const profilePath = await mkdtemp(join(runtimePath, 'doctor-profile-'));
  try {
    const session = await createLoadedExtensionSession({
      profilePath,
      removeProfileOnClose: true,
      channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chromium',
      headless: true,
    });
    await session.close();
    return true;
  } catch {
    await rm(profilePath, { recursive: true, force: true });
    return false;
  }
}

async function runtimeDirectoryIsWritable(): Promise<boolean> {
  const runtimePath = join(repositoryRoot, 'e2e/.runtime');
  let probePath: string | null = null;
  try {
    await mkdir(runtimePath, { recursive: true });
    probePath = await mkdtemp(join(runtimePath, 'doctor-'));
    return true;
  } catch {
    return false;
  } finally {
    if (probePath !== null) await rm(probePath, { recursive: true, force: true });
  }
}

async function collectFacts(): Promise<EnvironmentDoctorFacts> {
  const packageManifest = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;
  const declaredNodeRange = packageManifest.engines?.node;
  if (typeof declaredNodeRange !== 'string' || declaredNodeRange.length === 0) {
    throw new Error('package.json does not declare engines.node.');
  }
  const [
    dependencyTreePresent,
    extensionBuildValid,
    extensionRuntimeReady,
    browserLaunchable,
    runtimeWritable,
  ] = await Promise.all([
    pathIsDirectory(join(repositoryRoot, 'node_modules')),
    extensionBuildIsValid(),
    extensionRuntimeIsReady(),
    configuredBrowserLaunches(),
    runtimeDirectoryIsWritable(),
  ]);
  return {
    nodeVersion: process.versions.node,
    declaredNodeRange,
    dependencyTreePresent,
    extensionBuildValid,
    extensionRuntimeReady,
    browserLaunchable,
    runtimeWritable,
  };
}

async function main(): Promise<void> {
  const report = evaluateEnvironmentDoctor(await collectFacts());
  for (const check of report.checks) {
    process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}\n`);
  }
  if (!report.passed) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`E2E environment doctor failed: ${message}\n`);
  process.exitCode = 1;
});
