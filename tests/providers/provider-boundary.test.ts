// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : /\.tsx?$/.test(child) ? [child] : [];
  });
}

describe('concrete provider boundary', () => {
  it('keeps concrete model imports and credential contracts out of the application', () => {
    const leaks = files('src')
      .filter((path) => !path.startsWith('src/providers/codex/'))
      .flatMap((path) => {
        const text = readFileSync(path, 'utf8');
        return /providers\/codex|(?:get|set|has)Codex(?:Access)?Token|codex(?:AccessToken|CredentialSource|AuthPath)|new Codex/.test(
          text,
        )
          ? [relative('.', path)]
          : [];
      });
    expect(leaks).toEqual([]);
  });
});
