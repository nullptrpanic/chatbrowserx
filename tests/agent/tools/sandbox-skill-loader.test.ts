import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxExecutionPort } from '../../../src/sandbox/sandbox-tool-executor';
import { ToolServiceResolver } from '../../../src/tools/service-resolver';
import { loadSandboxSkillPrompt } from '../../../src/tools/sandbox/skill-loader';
import { createSandboxToolService, sandboxService } from '../../../src/tools/sandbox/service';

const execFileAsync = promisify(execFile);

function localSandbox(home: string): SandboxExecutionPort {
  return {
    async execute(call, signal) {
      if (call.operation !== 'exec') throw new Error('Expected a Sandbox command.');
      const result = await execFileAsync('/bin/bash', ['-c', call.arguments.command], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        maxBuffer: 128 * 1024,
        signal,
      });
      return JSON.stringify({
        code: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: false,
      });
    },
    async recover() {
      return { status: 'not_found' };
    },
  };
}

async function withSandboxHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'chatbrowserx-skill-loader-'));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writeSkill(
  home: string,
  name: string,
  frontmatter: string,
  body = '',
): Promise<void> {
  const directory = join(home, '.codex', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`, 'utf8');
}

async function loadPrompt(home: string): Promise<string | null> {
  const services = new ToolServiceResolver();
  services.bind(sandboxService, createSandboxToolService(localSandbox(home)));
  return loadSandboxSkillPrompt(services, new AbortController().signal);
}

describe('Sandbox Skill loader', () => {
  it('uses one bounded shell scan without per-file head or wc subprocesses', async () => {
    const execute = vi.fn<SandboxExecutionPort['execute']>(async () =>
      JSON.stringify({
        code: 0,
        stdout: '__CHATBROWSERX_SCAN_END__\0\0',
        stderr: '',
        truncated: false,
      }),
    );
    const services = new ToolServiceResolver();
    services.bind(
      sandboxService,
      createSandboxToolService({
        execute,
        recover: async () => ({ status: 'not_found' as const }),
      }),
    );

    await loadSandboxSkillPrompt(services, new AbortController().signal);

    const firstCall = execute.mock.calls[0]?.[0];
    if (firstCall?.operation !== 'exec') throw new Error('Expected one Sandbox scan command.');
    const command = firstCall.arguments.command;
    expect(command).toContain('find -L');
    expect(command).not.toContain('head -c');
    expect(command).not.toContain('wc -c');
  });

  it('budgets compact metadata instead of long SKILL.md bodies', async () => {
    await withSandboxHome(async (home) => {
      await Promise.all(
        Array.from({ length: 24 }, async (_, index) => {
          const name = `skill-${String(index).padStart(2, '0')}`;
          await writeSkill(
            home,
            name,
            `name: ${name}\ndescription: Handles workflow ${index}.`,
            `# Instructions\n${'body content '.repeat(500)}`,
          );
        }),
      );

      const prompt = await loadPrompt(home);

      expect(prompt).toContain('skill-00');
      expect(prompt).toContain('skill-23');
      expect(prompt).not.toContain('The Skill list is truncated');
    });
  });

  it('retains a standard 1024-character description', async () => {
    await withSandboxHome(async (home) => {
      const description = 'd'.repeat(1_024);
      await writeSkill(
        home,
        'long-description',
        `name: long-description\ndescription: ${description}`,
      );

      const prompt = await loadPrompt(home);

      expect(prompt).toContain(description);
    });
  });

  it('loads a standard folded YAML description', async () => {
    await withSandboxHome(async (home) => {
      await writeSkill(
        home,
        'folded-description',
        [
          'name: folded-description',
          'description: >-',
          '  Handles standard',
          '  folded descriptions.',
        ].join('\n'),
      );

      const prompt = await loadPrompt(home);

      expect(prompt).toContain('Handles standard folded descriptions.');
    });
  });

  it('parses standard YAML frontmatter instead of a shell scalar subset', async () => {
    await withSandboxHome(async (home) => {
      await writeSkill(
        home,
        'yaml-frontmatter',
        [
          'name: yaml-frontmatter # skill identifier',
          'description: "Handles YAML: comments and quoted colons." # discovery hint',
          'metadata:',
          '  owner: test',
        ].join('\n'),
      );

      const prompt = await loadPrompt(home);

      expect(prompt).toContain('yaml-frontmatter');
      expect(prompt).toContain('Handles YAML: comments and quoted colons.');
    });
  });

  it('loads only standard names that match the Skill directory', async () => {
    await withSandboxHome(async (home) => {
      await writeSkill(home, 'valid-skill', 'name: valid-skill\ndescription: valid-description');
      await writeSkill(home, 'Uppercase', 'name: Uppercase\ndescription: uppercase-description');
      await writeSkill(
        home,
        'wrong-directory',
        'name: different-name\ndescription: mismatched-description',
      );
      const overlongName = 'a'.repeat(65);
      await writeSkill(
        home,
        overlongName,
        `name: ${overlongName}\ndescription: overlong-name-description`,
      );

      const prompt = await loadPrompt(home);

      expect(prompt).toContain('valid-description');
      expect(prompt).not.toContain('uppercase-description');
      expect(prompt).not.toContain('mismatched-description');
      expect(prompt).not.toContain('overlong-name-description');
    });
  });

  it('rejects descriptions longer than the standard 1024-character limit', async () => {
    await withSandboxHome(async (home) => {
      const overlongDescription = 'x'.repeat(1_025);
      await writeSkill(
        home,
        'overlong-description',
        `name: overlong-description\ndescription: ${overlongDescription}`,
      );

      expect(await loadPrompt(home)).toBe('');
    });
  });

  it('retains the 60 KB aggregate metadata budget', async () => {
    await withSandboxHome(async (home) => {
      await Promise.all(
        Array.from({ length: 60 }, async (_, index) => {
          const name = `large-metadata-${String(index).padStart(2, '0')}`;
          await writeSkill(
            home,
            name,
            `name: ${name}\ndescription: ${String(index).padStart(2, '0')}-${'m'.repeat(998)}`,
          );
        }),
      );

      const prompt = await loadPrompt(home);

      expect(prompt).toContain('The Skill list is truncated');
    });
  }, 15_000);

  it('treats missing Skill roots as an empty available Skill set', async () => {
    await withSandboxHome(async (home) => {
      expect(await loadPrompt(home)).toBe('');
    });
  });

  it('reuses a snapshot for five minutes and refreshes it on the next load after expiry', async () => {
    await withSandboxHome(async (home) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
      const services = new ToolServiceResolver();
      services.bind(sandboxService, createSandboxToolService(localSandbox(home)));
      try {
        await writeSkill(
          home,
          'cached-skill',
          'name: cached-skill\ndescription: first-description',
        );
        expect(await loadSandboxSkillPrompt(services, new AbortController().signal)).toContain(
          'first-description',
        );

        await writeSkill(
          home,
          'cached-skill',
          'name: cached-skill\ndescription: refreshed-description',
        );
        now.mockReturnValue(309_999);
        const cached = await loadSandboxSkillPrompt(services, new AbortController().signal);
        expect(cached).toContain('first-description');
        expect(cached).not.toContain('refreshed-description');

        now.mockReturnValue(310_000);
        const stale = await loadSandboxSkillPrompt(services, new AbortController().signal);
        expect(stale).toContain('first-description');
        await vi.waitFor(async () => {
          const refreshed = await loadSandboxSkillPrompt(services, new AbortController().signal);
          expect(refreshed).toContain('refreshed-description');
          expect(refreshed).not.toContain('first-description');
        });
      } finally {
        now.mockRestore();
      }
    });
  });

  it('coalesces concurrent cold catalog loads for one Sandbox configuration', async () => {
    let resolveExecution: ((output: string) => void) | undefined;
    const pendingExecution = new Promise<string>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(() => pendingExecution);
    const services = new ToolServiceResolver();
    services.bind(
      sandboxService,
      createSandboxToolService({
        execute,
        recover: async () => ({ status: 'not_found' as const }),
      }),
    );

    const first = loadSandboxSkillPrompt(services, new AbortController().signal);
    const second = loadSandboxSkillPrompt(services, new AbortController().signal);
    expect(execute).toHaveBeenCalledOnce();
    resolveExecution?.(
      JSON.stringify({
        code: 0,
        stdout: '__CHATBROWSERX_SCAN_END__\0\0',
        stderr: '',
        truncated: false,
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual(['', '']);
  });
});
