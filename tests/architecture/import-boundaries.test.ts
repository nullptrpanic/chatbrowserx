import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(process.cwd(), 'src');

/** Recursively lists production TypeScript modules in stable repository-relative order. */
async function sourceFiles(directory = sourceRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return files.flat().sort();
}

/** Extracts static module specifiers without interpreting comments or executable code. */
function imports(source: string): string[] {
  return [
    ...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g),
  ]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function repositoryPath(path: string): string {
  return relative(process.cwd(), path).split(sep).join('/');
}

describe('production import boundaries', () => {
  it('keeps shared tool runtime modules at the tools root and one entrypoint per tool directory', async () => {
    const toolsRoot = join(sourceRoot, 'tools');
    const directories = (await readdir(toolsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const missingEntrypoints: string[] = [];
    for (const directory of directories) {
      const entries = await readdir(join(toolsRoot, directory));
      if (!entries.includes('tool.ts')) missingEntrypoints.push(`src/tools/${directory}`);
    }

    expect(directories.length).toBeGreaterThan(0);
    expect(missingEntrypoints).toEqual([]);
  });

  it('keeps concrete Codex composition inside the Agent package', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles()) {
      const path = repositoryPath(file);
      if (path.startsWith('src/providers/codex/')) continue;
      for (const specifier of imports(await readFile(file, 'utf8'))) {
        if (!specifier.includes('providers/codex/')) continue;
        if (path !== 'src/agent/create-agent.ts') violations.push(`${path} -> ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps concrete tool-category composition out of Agent core modules', async () => {
    const toolsRoot = join(sourceRoot, 'tools');
    const toolDirectories = new Set(
      (await readdir(toolsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name),
    );
    const violations: string[] = [];
    for (const file of (await sourceFiles()).filter((path) =>
      repositoryPath(path).startsWith('src/agent/'),
    )) {
      const path = repositoryPath(file);
      if (path === 'src/agent/create-agent.ts') continue;
      for (const specifier of imports(await readFile(file, 'utf8'))) {
        const match = /tools\/([^/]+)\//.exec(specifier);
        if (match?.[1] !== undefined && toolDirectories.has(match[1])) {
          violations.push(`${path} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('prevents Provider adapters from importing concrete tool implementations', async () => {
    const violations: string[] = [];
    for (const file of (await sourceFiles()).filter((path) =>
      repositoryPath(path).startsWith('src/providers/codex/'),
    )) {
      for (const specifier of imports(await readFile(file, 'utf8'))) {
        if (/agent\/tools|tools\//.test(specifier)) {
          violations.push(`${repositoryPath(file)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
