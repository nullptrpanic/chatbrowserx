import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../../src/persistence/settings-store';
import type { SandboxClientPort, SandboxExecResponse } from '../../src/sandbox/sandbox-client';
import {
  SkillCatalog,
  sandboxCatalogForCompletedTools,
  sandboxCatalogInstructions,
} from '../../src/sandbox/skill-catalog';
import type { Clock } from '../../src/shared/time';
import { MemoryStorageArea } from '../persistence/test-helpers';

const SIGNAL = new AbortController().signal;
const SERVER = 'https://sandbox.example.com';

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n# Full body must not be cached`;
}

function scan(
  records: readonly (readonly [path: string, head: string])[],
  truncated = false,
): string {
  return `${records.flatMap(([path, head]) => [path, head]).join('\0')}\0__CHATBROWSERX_SCAN_END__\0${truncated ? '1' : '0'}\0`;
}

function fixture(
  options: {
    readonly stdout?: string;
    readonly configured?: boolean;
    readonly server?: string;
    readonly now?: number;
  } = {},
) {
  let now = options.now ?? 1_000;
  let server = options.server ?? SERVER;
  const storage = new MemoryStorageArea();
  const execute = vi.fn<SandboxClientPort['execute']>(async (): Promise<SandboxExecResponse> => ({
    code: 0,
    stdout: options.stdout ?? scan([]),
    stderr: '',
  }));
  const client: SandboxClientPort = {
    isConfigured: vi.fn(async () => options.configured ?? true),
    execute,
    getExecution: vi.fn(),
  };
  const settings = {
    get: vi.fn(async () => ({ ...DEFAULT_APP_SETTINGS, sandboxServer: server })),
  };
  const clock: Clock = { now: () => now };
  const catalog = new SkillCatalog(client, settings, storage, clock);
  return {
    catalog,
    client,
    execute,
    settings,
    storage,
    setNow(value: number) {
      now = value;
    },
    setServer(value: string) {
      server = value;
    },
  };
}

describe('SkillCatalog discovery', () => {
  it('parses bounded frontmatter, applies codex precedence, and sorts entries', async () => {
    const source = scan([
      [
        '/home/test/.agents/skills/duplicate/SKILL.md',
        frontmatter('Duplicate', 'The lower-priority entry.'),
      ],
      [
        '/home/test/.codex/skills/zeta/SKILL.md',
        '---\nname: \'zeta\'\ndescription: "Line one\\nline two"\n---\nsecret body',
      ],
      [
        '/home/test/.codex/skills/duplicate/SKILL.md',
        frontmatter('duplicate', 'The preferred entry.'),
      ],
      ['/home/test/.codex/skills/broken/SKILL.md', 'name: missing-frontmatter'],
      ['/tmp/outside/SKILL.md', frontmatter('outside', 'Must be ignored.')],
      [
        '/home/test/.agents/skills/alpha/SKILL.md',
        frontmatter('alpha', '  A   compact   description.  '),
      ],
    ]);
    const { catalog, execute, storage } = fixture({ stdout: source });

    await expect(catalog.get(SIGNAL)).resolves.toEqual({
      entries: [
        {
          name: 'alpha',
          description: 'A compact description.',
          path: '/home/test/.agents/skills/alpha/SKILL.md',
        },
        {
          name: 'duplicate',
          description: 'The preferred entry.',
          path: '/home/test/.codex/skills/duplicate/SKILL.md',
        },
        {
          name: 'zeta',
          description: 'Line one line two',
          path: '/home/test/.codex/skills/zeta/SKILL.md',
        },
      ],
      refreshedAt: 1_000,
      truncated: false,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0]?.[0];
    expect(request).toEqual({ command: expect.any(String) });
    expect(request?.command).toContain('$HOME/.codex/skills');
    expect(request?.command).toContain('$HOME/.agents/skills');
    expect(request?.command).toContain('head -c 4096');
    expect(request?.command).toContain('count" -ge 512');
    expect(JSON.stringify(storage.values)).not.toContain('secret body');
  });

  it('enforces name, description, and retained-entry bounds', async () => {
    const records: [string, string][] = Array.from({ length: 257 }, (_, index) => [
      `/home/test/.codex/skills/skill-${String(index).padStart(3, '0')}/SKILL.md`,
      frontmatter(`skill-${String(index).padStart(3, '0')}`, 'd'.repeat(301)),
    ]);
    records.unshift([
      '/home/test/.codex/skills/too-long/SKILL.md',
      frontmatter('n'.repeat(81), 'ignored'),
    ]);
    const { catalog } = fixture({ stdout: scan(records) });

    const snapshot = await catalog.get(SIGNAL);

    expect(snapshot?.entries).toHaveLength(256);
    expect(snapshot?.entries[0]?.description).toHaveLength(300);
    expect(snapshot?.entries.some(({ name }) => name.length > 80)).toBe(false);
    expect(snapshot?.truncated).toBe(true);
  });

  it('preserves the scanner truncation marker', async () => {
    const { catalog } = fixture({ stdout: scan([], true) });

    await expect(catalog.get(SIGNAL)).resolves.toMatchObject({ truncated: true });
  });

  it('returns null and does not scan when Sandbox is not configured', async () => {
    const { catalog, execute, settings } = fixture({ configured: false });

    await expect(catalog.get(SIGNAL)).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(settings.get).not.toHaveBeenCalled();
  });
});

describe('SkillCatalog cache', () => {
  it('uses a fresh persisted cache and refreshes after ten minutes', async () => {
    const { catalog, execute, setNow } = fixture({
      stdout: scan([['/home/test/.codex/skills/a/SKILL.md', frontmatter('a', 'A skill.')]]),
    });

    await catalog.get(SIGNAL);
    setNow(600_999);
    await catalog.get(SIGNAL);
    expect(execute).toHaveBeenCalledTimes(1);

    setNow(601_000);
    await catalog.get(SIGNAL);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refreshes', async () => {
    let resolve!: (value: SandboxExecResponse) => void;
    const pending = new Promise<SandboxExecResponse>((done) => {
      resolve = done;
    });
    const current = fixture();
    current.execute.mockImplementation(async () => pending);

    const first = current.catalog.get(SIGNAL);
    const second = current.catalog.get(SIGNAL);
    resolve({ code: 0, stdout: scan([]), stderr: '' });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(current.execute).toHaveBeenCalledTimes(1);
  });

  it('falls back to stale metadata after a failed refresh', async () => {
    const current = fixture({
      stdout: scan([['/home/test/.codex/skills/a/SKILL.md', frontmatter('a', 'A skill.')]]),
    });
    const initial = await current.catalog.get(SIGNAL);
    current.setNow(700_000);
    current.execute.mockRejectedValueOnce(new Error('unsafe remote detail'));

    await expect(current.catalog.get(SIGNAL)).resolves.toEqual(initial);
  });

  it('returns an empty snapshot when refresh fails without stale metadata', async () => {
    const current = fixture();
    current.execute.mockRejectedValueOnce(new Error('unsafe remote detail'));

    await expect(current.catalog.get(SIGNAL)).resolves.toEqual({
      entries: [],
      refreshedAt: 1_000,
      truncated: false,
    });
  });

  it('invalidates persisted metadata and refreshes on server mismatch', async () => {
    const current = fixture();
    await current.catalog.get(SIGNAL);
    expect(current.storage.values['sandbox.skillCatalog.v1']).toBeDefined();

    await current.catalog.invalidate();
    expect(current.storage.values['sandbox.skillCatalog.v1']).toBeUndefined();
    await current.catalog.get(SIGNAL);
    expect(current.execute).toHaveBeenCalledTimes(2);

    current.setServer('https://sandbox-two.example.com');
    await current.catalog.get(SIGNAL);
    expect(current.execute).toHaveBeenCalledTimes(3);
  });
});

describe('sandboxCatalogInstructions', () => {
  it('is empty without entries and otherwise encodes precedence and the compact catalog', () => {
    expect(sandboxCatalogInstructions({ entries: [], refreshedAt: 1, truncated: false })).toBe('');

    const instructions = sandboxCatalogInstructions({
      entries: [{ name: 'a', description: 'A skill.', path: '/skills/a/SKILL.md' }],
      refreshedAt: 1,
      truncated: true,
    });

    expect(instructions).toContain('Built-in ChatBrowserX tools take priority');
    expect(instructions).toContain('read its SKILL.md completely');
    expect(instructions).toContain('catalog is truncated');
    expect(instructions).toContain(JSON.stringify([['a', 'A skill.', '/skills/a/SKILL.md']]));
  });

  it('keeps only the selected Skill after its SKILL.md was read successfully', () => {
    const snapshot = {
      entries: [
        { name: 'a', description: 'A skill.', path: '/skills/a/SKILL.md' },
        { name: 'b', description: 'B skill.', path: '/skills/b/SKILL.md' },
      ],
      refreshedAt: 1,
      truncated: false,
    };

    expect(
      sandboxCatalogForCompletedTools(snapshot, [
        {
          callId: 'call_read',
          toolName: 'sandbox_read',
          argumentsJson: JSON.stringify({
            path: '/skills/b/SKILL.md',
            startLine: 1,
            maxLines: 400,
          }),
          output: JSON.stringify({ code: 0, path: '/skills/b/SKILL.md', content: '---' }),
          resultRef: 'result_read',
        },
      ]),
    ).toEqual({
      entries: [{ name: 'b', description: 'B skill.', path: '/skills/b/SKILL.md' }],
      refreshedAt: 1,
      truncated: false,
    });
  });
});
