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
      optional_host_permissions: ['http://*/*', 'https://*/*'],
      host_permissions: ['https://chatgpt.com/*', 'https://api.tavily.com/*'],
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
    ['DYNAMIC_CODE_EVALUATION', 'eval("1 + 1");'],
    ['EMBEDDED_CREDENTIAL_SHAPE', 'const key = "Bearer abcdefghijklmnopqrstuvwxyz";'],
  ])('rejects %s', async (code, script) => {
    const result = await auditProductionBundle(await bundleFixture(script));
    expect(result.findings).toContainEqual({ code, asset: 'assets/app.js' });
  });

  it('rejects permission drift and source maps', async () => {
    const root = await bundleFixture();
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ permissions: ['<all_urls>'] }));
    await writeFile(join(root, 'assets', 'app.js.map'), '{}');
    const result = await auditProductionBundle(root);
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'REQUIRED_PERMISSION_DRIFT',
        'OPTIONAL_HOST_DRIFT',
        'REQUIRED_HOST_DRIFT',
        'SOURCE_MAP_PRESENT',
      ]),
    );
  });
});
