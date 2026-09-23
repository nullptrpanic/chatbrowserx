import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import browserConfig from '../../playwright.config';

const root = resolve(import.meta.dirname, '../../..');
const execFileAsync = promisify(execFile);

interface ListedSuite {
  readonly file?: string;
  readonly suites?: readonly ListedSuite[];
  readonly specs?: readonly {
    readonly title: string;
    readonly file: string;
    readonly tests: readonly { readonly projectName: string }[];
  }[];
}

function specs(suites: readonly ListedSuite[]): NonNullable<ListedSuite['specs']> {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...specs(suite.suites ?? [])]);
}

async function listTests(args: readonly string[] = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      resolve(root, 'node_modules/playwright/cli.js'),
      'test',
      '--config',
      'e2e/playwright.config.ts',
      '--list',
      '--reporter=json',
      ...args,
    ],
    { cwd: root, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as {
    readonly config: { readonly workers: number };
    readonly suites: readonly ListedSuite[];
  };
}

test('schedules every browser case once and isolates foreground tests from headless translation', async () => {
  const report = await listTests();
  expect(report.config.workers).toBeGreaterThan(1);
  const all = specs(report.suites);
  expect(all.length).toBeGreaterThan(0);
  for (const spec of all) {
    const translation = /(?:^|\/)(?:region-translation|translation-[^/]+)\.spec\.ts$/.test(
      spec.file,
    );
    expect(
      spec.tests.map((test) => test.projectName),
      spec.title,
    ).toEqual([translation ? 'translation' : 'foreground']);
  }
  // The JSON list reporter omits per-project scheduling/use options; check their config owner.
  const foreground = browserConfig.projects?.find((project) => project.name === 'foreground');
  const translation = browserConfig.projects?.find((project) => project.name === 'translation');
  expect(foreground?.workers).toBe(1);
  expect(translation?.dependencies).toEqual(['foreground']);
  expect(translation?.use?.extensionHeadless).toBe(true);
});

test('the quick lane selects only the eight representative contracts without foreground dependencies', async () => {
  const report = await listTests(['--project=translation', '--no-deps', '--grep=@smoke']);
  const selected = specs(report.suites);
  expect(selected.map((spec) => spec.title).sort()).toEqual(
    [
      'keeps navigation glyphs beside icons in a complete opaque structural copy',
      'keeps a read-only table coherent around invisible editor sentinels',
      'reuses structural text nodes during window/nested scroll, including sticky labels',
      'recovers from a nested transient provider error through one explicit refresh',
      'keeps changing text native until explicit refresh and leaves its static neighbor translated',
      'leaves video native without image translation or sharing while translating independent DOM text',
      'isolates a malformed model block, retries only that block and retains validated cache',
      'translates a read-only document island with context but never sends editable drafts',
    ].sort(),
  );
  expect(
    selected.every((spec) => spec.tests.every((test) => test.projectName === 'translation')),
  ).toBe(true);
});
