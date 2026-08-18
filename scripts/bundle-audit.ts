import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const APPROVED_PERMISSIONS = [
  'activeTab',
  'alarms',
  'debugger',
  'scripting',
  'sidePanel',
  'storage',
  'tabs',
] as const;
const APPROVED_REQUIRED_HOSTS = ['<all_urls>'] as const;
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs']);

export interface BundleAuditFinding {
  readonly code: string;
  readonly asset: string;
}

export interface BundleAuditResult {
  readonly passed: boolean;
  readonly assetCount: number;
  readonly findings: readonly BundleAuditFinding[];
}

interface ManifestShape {
  readonly permissions?: unknown;
  readonly optional_host_permissions?: unknown;
  readonly host_permissions?: unknown;
}

/** Lists every regular file under an exact build directory without following symlinks. */
async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Compares manifest arrays as exact order-independent sets of unique strings. */
function matchesSet(value: unknown, approved: readonly string[]): boolean {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return false;
  const actual = [...new Set(value as string[])].sort();
  return JSON.stringify(actual) === JSON.stringify([...approved].sort());
}

/** Audits one production build for permission drift, excluded features, and unsafe bundle residue. */
export async function auditProductionBundle(root: string): Promise<BundleAuditResult> {
  const files = await listFiles(root);
  const findings: BundleAuditFinding[] = [];
  const manifestPath = join(root, 'manifest.json');
  let manifest: ManifestShape;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ManifestShape;
  } catch {
    return {
      passed: false,
      assetCount: files.length,
      findings: [{ code: 'MANIFEST_MISSING_OR_INVALID', asset: 'manifest.json' }],
    };
  }

  if (!matchesSet(manifest.permissions, APPROVED_PERMISSIONS)) {
    findings.push({ code: 'REQUIRED_PERMISSION_DRIFT', asset: 'manifest.json' });
  }
  if (manifest.optional_host_permissions !== undefined) {
    findings.push({ code: 'OPTIONAL_HOST_DRIFT', asset: 'manifest.json' });
  }
  if (!matchesSet(manifest.host_permissions, APPROVED_REQUIRED_HOSTS)) {
    findings.push({ code: 'REQUIRED_HOST_DRIFT', asset: 'manifest.json' });
  }

  const markers: readonly { readonly code: string; readonly pattern: RegExp }[] = [
    {
      code: 'RAW_CDP_MODEL_TOOL_RESIDUE',
      pattern: /["'](?:browser|page)[._](?:cdp|debugger|execute_cdp|send_cdp|send_command)["']/i,
    },
    {
      code: 'RUNTIME_HOST_REQUEST_RESIDUE',
      pattern: /chrome\.permissions\.request\b/i,
    },
    {
      code: 'MODEL_CONTEXT_INJECTION_RESIDUE',
      pattern:
        /## (?:User goal|Current page|Risk and recovery policy|Checkpoint|Remaining budget)|Visual fallback for the current viewport|Referenced images from the recent/i,
    },
    {
      code: 'EXCLUDED_PROVIDER_OR_MEDIA_FEATURE',
      pattern:
        /openai[-_ ]?compatible|volcengine|chrome\.(?:tabCapture|offscreen|desktopCapture)|getUserMedia|MediaRecorder|webkitSpeechRecognition|window\.print\s*\(/i,
    },
    {
      code: 'CONCRETE_TOOL_RUNTIME_RESIDUE',
      pattern:
        /browser[._](?:observe|act)\b|page\.(?:observe|domAction)\b|browserActions(?:Used|Limit)|waiting_for_confirmation/i,
    },
    {
      code: 'E2E_CONTROL_RESIDUE',
      pattern: /CHATBROWSERX_E2E|test\.(?:fault|plan|storage|reset)/,
    },
    {
      code: 'DEVELOPMENT_FIXTURE_RESIDUE',
      pattern:
        /conversation_preview|task_preview|previewSnapshot|createDevPreviewProps|示例 · 活动报名表/,
    },
    { code: 'NODE_ENV_RESIDUE', pattern: /process\.env\.NODE_ENV|jsxDEV/ },
    { code: 'DYNAMIC_CODE_EVALUATION', pattern: /\beval\s*\(|new Function\s*\(/ },
    {
      code: 'EMBEDDED_CREDENTIAL_SHAPE',
      pattern: /Bearer\s+[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9_-]{20,}/,
    },
  ];

  for (const file of files) {
    const asset = relative(root, file);
    if (file.endsWith('.map')) {
      findings.push({ code: 'SOURCE_MAP_PRESENT', asset });
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extname(file))) continue;
    const text = await readFile(file, 'utf8');
    for (const marker of markers) {
      if (marker.pattern.test(text)) findings.push({ code: marker.code, asset });
    }
  }

  return { passed: findings.length === 0, assetCount: files.length, findings };
}
