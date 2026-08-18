import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditProductionBundle } from '../../scripts/bundle-audit';

const temporaryDirectories: string[] = [];

/** Creates one minimal auditable bundle fixture with the approved production manifest. */
async function bundleFixture(script = 'const ready = true;'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chatbrowserx-audit-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      permissions: ['activeTab', 'alarms', 'debugger', 'scripting', 'sidePanel', 'storage', 'tabs'],
      host_permissions: ['<all_urls>'],
    }),
  );
  await writeFile(join(root, 'assets', 'app.js'), script);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('production bundle audit', () => {
  it('accepts exactly the approved permission and host boundary', async () => {
    await expect(auditProductionBundle(await bundleFixture())).resolves.toMatchObject({
      passed: true,
      findings: [],
    });
  });

  it.each([
    ['NODE_ENV_RESIDUE', 'if (process.env.NODE_ENV) {}'],
    ['E2E_CONTROL_RESIDUE', 'const command = "test.fault";'],
    ['EXCLUDED_PROVIDER_OR_MEDIA_FEATURE', 'chrome.tabCapture.capture();'],
    ['CONCRETE_TOOL_RUNTIME_RESIDUE', 'const tool = "browser.observe";'],
    ['RAW_CDP_MODEL_TOOL_RESIDUE', 'const tool = "browser_cdp";'],
    ['RUNTIME_HOST_REQUEST_RESIDUE', 'chrome.permissions.request({ origins: ["https://x/*"] });'],
    ['MODEL_CONTEXT_INJECTION_RESIDUE', 'const prompt = "## Current page";'],
    ['DEVELOPMENT_FIXTURE_RESIDUE', 'const taskId = "task_preview";'],
    ['DYNAMIC_CODE_EVALUATION', 'eval("1 + 1");'],
    ['EMBEDDED_CREDENTIAL_SHAPE', 'const key = "Bearer abcdefghijklmnopqrstuvwxyz";'],
  ])('rejects %s', async (code, script) => {
    const result = await auditProductionBundle(await bundleFixture(script));
    expect(result.findings).toContainEqual({ code, asset: 'assets/app.js' });
  });

  it('accepts the approved fixed-endpoint Tavily runtime surface', async () => {
    const script = [
      'const tools = ["tavily_search", "tavily_extract", "tavily_crawl"];',
      'const endpoints = ["https://api.tavily.com/search", "https://api.tavily.com/extract", "https://api.tavily.com/crawl"];',
    ].join('\n');

    await expect(auditProductionBundle(await bundleFixture(script))).resolves.toMatchObject({
      passed: true,
      findings: [],
    });
  });

  it('accepts the approved debugger transport runtime surface', async () => {
    const script = [
      'chrome.debugger.attach({ tabId: 7 }, "1.3");',
      'chrome.debugger.sendCommand({ tabId: 7, sessionId: "child" }, "DOM.getDocument");',
    ].join('\n');

    await expect(auditProductionBundle(await bundleFixture(script))).resolves.toMatchObject({
      passed: true,
      findings: [],
    });
  });

  it('rejects permission drift and source maps', async () => {
    const root = await bundleFixture();
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ permissions: ['<all_urls>'] }));
    await writeFile(join(root, 'assets', 'app.js.map'), '{}');
    const result = await auditProductionBundle(root);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'REQUIRED_PERMISSION_DRIFT',
        'REQUIRED_HOST_DRIFT',
        'SOURCE_MAP_PRESENT',
      ]),
    );
  });

  it('rejects optional per-origin host permissions', async () => {
    const root = await bundleFixture();
    await writeFile(
      join(root, 'manifest.json'),
      JSON.stringify({
        permissions: [
          'activeTab',
          'alarms',
          'debugger',
          'scripting',
          'sidePanel',
          'storage',
          'tabs',
        ],
        optional_host_permissions: ['http://*/*', 'https://*/*'],
        host_permissions: ['<all_urls>'],
      }),
    );

    const result = await auditProductionBundle(root);

    expect(result.findings).toContainEqual({
      code: 'OPTIONAL_HOST_DRIFT',
      asset: 'manifest.json',
    });
  });
});
