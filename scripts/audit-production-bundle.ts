import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { auditProductionBundle } from './bundle-audit';

const buildPath = resolve('dist');
const artifactDirectory = resolve('artifacts/release');
const artifactPath = resolve(artifactDirectory, 'bundle-audit.json');

const result = await auditProductionBundle(buildPath);
await mkdir(artifactDirectory, { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

if (result.passed) {
  console.log(`Production bundle audit passed (${String(result.assetCount)} assets).`);
} else {
  for (const finding of result.findings) {
    console.error(`${finding.code}: ${finding.asset}`);
  }
  process.exitCode = 1;
}
