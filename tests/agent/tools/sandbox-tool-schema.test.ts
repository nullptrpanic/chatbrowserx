import { describe, expect, it, vi } from 'vitest';
import { sandboxExecDefinition, sandboxReadDefinition } from '../../../src/tools/sandbox/contract';
import { sandboxExecTool, sandboxReadTool, sandboxRuntime } from '../../../src/tools/sandbox/tool';
import { ToolDeclarationCatalog } from '../../../src/tools/register';
import { bindToolRuntime } from '../../../src/tools/registry';
import { ToolServiceResolver } from '../../../src/tools/service-resolver';
import { createSandboxToolService, sandboxService } from '../../../src/tools/sandbox/service';
import { SandboxClient } from '../../../src/sandbox/sandbox-client';
import { SandboxToolExecutor } from '../../../src/sandbox/sandbox-tool-executor';
import { DEFAULT_APP_SETTINGS } from '../../../src/persistence/settings-store';

const SANDBOX_TOOL_DEFINITIONS = [sandboxReadDefinition, sandboxExecDefinition];
const catalog = new ToolDeclarationCatalog();
catalog.register(sandboxReadTool, sandboxRuntime);
catalog.register(sandboxExecTool, sandboxRuntime);
const services = new ToolServiceResolver();
services.bind(
  sandboxService,
  createSandboxToolService({
    async configurationKey() {
      return this;
    },
    execute: async () =>
      JSON.stringify({
        code: 0,
        stdout: '__CHATBROWSERX_SCAN_END__\0' + '0\0',
        stderr: '',
        truncated: false,
      }),
    recover: async () => ({ status: 'not_found' }),
  }),
);
const runtime = bindToolRuntime(catalog.seal(), services);

const READ = {
  path: '/home/test/.codex/skills/example/SKILL.md',
  startLine: 1,
  maxLines: 400,
} as const;
const EXEC = {
  command: 'bash scripts/run.sh',
  cwd: '/home/test/.codex/skills/example',
} as const;
describe('SANDBOX_TOOL_DEFINITIONS', () => {
  it('exposes exactly two strict fixed contracts with every property required', () => {
    expect(SANDBOX_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'sandbox_read',
      'sandbox_exec',
    ]);
    for (const definition of SANDBOX_TOOL_DEFINITIONS) {
      expect(definition.strict).toBe(true);
      expect(definition.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      const parameters = definition.parameters as {
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required: readonly string[];
      };
      expect(parameters.required).toEqual(Object.keys(parameters.properties));
    }
  });

  it('does not expose environment variables or unsupported schema keywords', () => {
    const serialized = JSON.stringify(SANDBOX_TOOL_DEFINITIONS);

    expect(serialized).not.toContain('"env"');
    expect(serialized).not.toContain('"uniqueItems"');
    expect(SANDBOX_TOOL_DEFINITIONS[1]?.parameters).toMatchObject({
      properties: {
        command: { type: 'string', maxLength: 20_000 },
        cwd: { type: ['string', 'null'], maxLength: 4_096 },
      },
      required: ['command', 'cwd'],
    });
  });
});

describe('registered Sandbox tool parsing', () => {
  it('omits unconfigured tools and invalidates Skills when the endpoint or token changes', async () => {
    let server = '';
    let token = 'token-a';
    let reachable = true;
    const fetch = vi.fn(async () => {
      if (!reachable) throw new Error('temporarily unavailable');
      return new Response(
        JSON.stringify({
          code: 0,
          stdout: [
            '/home/test/.codex/skills/example/SKILL.md',
            `name: example\ndescription: Catalog ${server} ${token}`,
            '__CHATBROWSERX_SCAN_END__',
            '0',
            '',
          ].join('\0'),
          stderr: '',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new SandboxClient(
      { get: async () => ({ ...DEFAULT_APP_SETTINGS, sandboxServer: server }) },
      { getSandboxToken: async () => token },
      fetch,
    );
    const connectedServices = new ToolServiceResolver();
    connectedServices.bind(
      sandboxService,
      createSandboxToolService(new SandboxToolExecutor(client)),
    );
    const connected = bindToolRuntime(catalog.seal(), connectedServices);
    expect((await connected.contract({})).definitions).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    server = 'https://server-a.invalid';
    expect((await connected.contract({})).systemPrompt).toContain(
      'Catalog https://server-a.invalid token-a',
    );
    server = 'https://server-b.invalid';
    expect((await connected.contract({})).systemPrompt).toContain(
      'Catalog https://server-b.invalid token-a',
    );
    token = 'token-b';
    expect((await connected.contract({})).systemPrompt).toContain(
      'Catalog https://server-b.invalid token-b',
    );
    reachable = false;
    expect((await connected.contract({})).definitions.map(({ name }) => name)).toEqual([
      'sandbox_read',
      'sandbox_exec',
    ]);
    token = '';
    const disabled = await connected.contract({ sandboxSkillPrompt: 'stale catalog' });
    expect(disabled.definitions).toEqual([]);
    expect(disabled.systemPrompt).not.toContain('stale catalog');
  });
  it('parses reads as replay-safe and execs as mutations', async () => {
    expect(runtime.policyFor('sandbox_read')?.mutation ?? false).toBe(false);
    expect(runtime.policyFor('sandbox_exec')?.mutation).toBe(true);
    const contract = await runtime.contract({ sandboxAvailable: true });
    expect(
      contract.parse({
        callId: 'call_read',
        name: 'sandbox_read',
        argumentsJson: JSON.stringify(READ),
      }),
    ).toEqual({
      operation: 'read',
      callId: 'call_read',
      name: 'sandbox_read',
      argumentsJson: JSON.stringify(READ),
      arguments: READ,
    });
    expect(
      contract.parse({
        callId: 'call_exec',
        name: 'sandbox_exec',
        argumentsJson: JSON.stringify({ ...EXEC, cwd: null }),
      }),
    ).toEqual({
      operation: 'exec',
      callId: 'call_exec',
      name: 'sandbox_exec',
      argumentsJson: JSON.stringify({ ...EXEC, cwd: null }),
      arguments: { ...EXEC, cwd: null },
    });
  });

  it.each([
    { callId: '', name: 'sandbox_read', argumentsJson: JSON.stringify(READ) },
    {
      callId: 'c'.repeat(257),
      name: 'sandbox_read',
      argumentsJson: JSON.stringify(READ),
    },
    { callId: 'call_1', name: 'sandbox_unknown', argumentsJson: '{}' },
    { callId: 'call_1', name: 'sandbox_read', argumentsJson: '{secret-value' },
    {
      callId: 'call_1',
      name: 'sandbox_read',
      argumentsJson: `${' '.repeat(32 * 1_024)}${JSON.stringify(READ)}`,
    },
    {
      callId: 'call_1',
      name: 'sandbox_read',
      argumentsJson: JSON.stringify({ ...READ, path: 'relative/SKILL.md' }),
    },
    {
      callId: 'call_1',
      name: 'sandbox_read',
      argumentsJson: JSON.stringify({ ...READ, path: `/${'p'.repeat(4_096)}` }),
    },
    {
      callId: 'call_1',
      name: 'sandbox_read',
      argumentsJson: JSON.stringify({ ...READ, startLine: 0 }),
    },
    {
      callId: 'call_1',
      name: 'sandbox_read',
      argumentsJson: JSON.stringify({ ...READ, maxLines: 401 }),
    },
    {
      callId: 'call_1',
      name: 'sandbox_read',
      argumentsJson: JSON.stringify({ ...READ, extra: true }),
    },
    {
      callId: 'call_1',
      name: 'sandbox_exec',
      argumentsJson: JSON.stringify({ ...EXEC, command: ' '.repeat(20_001) }),
    },
    {
      callId: 'call_1',
      name: 'sandbox_exec',
      argumentsJson: JSON.stringify({ ...EXEC, cwd: `/${'c'.repeat(4_096)}` }),
    },
    {
      callId: 'call_1',
      name: 'sandbox_exec',
      argumentsJson: JSON.stringify({ ...EXEC, env: { SECRET: 'value' } }),
    },
  ])('rejects unsupported or malformed calls', async (input) => {
    const contract = await runtime.contract({ sandboxAvailable: true });
    expect(() => contract.parse(input)).toThrow();
  });

  it('loads every Sandbox Skill into the prompt without exposing a loader or search tool', async () => {
    const services = new ToolServiceResolver();
    services.bind(
      sandboxService,
      createSandboxToolService({
        async configurationKey() {
          return this;
        },
        execute: async () =>
          JSON.stringify({
            code: 0,
            stdout: [
              '/home/test/.codex/skills/example/SKILL.md',
              'name: example\ndescription: Run the example workflow.',
              '/home/test/.agents/skills/other/SKILL.md',
              'name: other\ndescription: Run another workflow.',
              '__CHATBROWSERX_SCAN_END__',
              '0',
              '',
            ].join('\0'),
            stderr: '',
            truncated: false,
          }),
        recover: async () => ({ status: 'not_found' }),
      }),
    );
    const availableRuntime = bindToolRuntime(catalog.seal(), services);

    const contract = await availableRuntime.contract({ sandboxAvailable: false });

    expect(contract.definitions.map(({ name }) => name)).toEqual(['sandbox_read', 'sandbox_exec']);
    expect(contract.systemPrompt).toContain('Run the example workflow.');
    expect(contract.systemPrompt).toContain('/home/test/.codex/skills/example/SKILL.md');
    expect(contract.systemPrompt).toContain('Run another workflow.');
    expect(contract.systemPrompt).not.toContain('skill_search');
    expect(contract.definitions.map(({ name }) => name)).not.toContain('skill_loader');
  });

  it('keeps Sandbox tools and the last catalog when an expired snapshot cannot refresh', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const execute = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          code: 0,
          stdout: [
            '/home/test/.codex/skills/example/SKILL.md',
            'name: example\ndescription: Run the example workflow.',
            '__CHATBROWSERX_SCAN_END__',
            '0',
            '',
          ].join('\0'),
          stderr: '',
          truncated: false,
        }),
      )
      .mockRejectedValueOnce(new Error('Sandbox unavailable'));
    const changingServices = new ToolServiceResolver();
    changingServices.bind(
      sandboxService,
      createSandboxToolService({
        async configurationKey() {
          return this;
        },
        execute,
        recover: async () => ({ status: 'not_found' }),
      }),
    );
    const changingRuntime = bindToolRuntime(catalog.seal(), changingServices);

    try {
      const available = await changingRuntime.contract({});
      now.mockReturnValue(310_000);
      const stale = await changingRuntime.contract({});

      expect(available.definitions.map(({ name }) => name)).toEqual([
        'sandbox_read',
        'sandbox_exec',
      ]);
      expect(available.systemPrompt).toContain('Run the example workflow.');
      expect(stale.definitions.map(({ name }) => name)).toEqual(['sandbox_read', 'sandbox_exec']);
      expect(stale.systemPrompt).toContain('Run the example workflow.');
      expect(execute).toHaveBeenCalledTimes(2);
      now.mockReturnValue(910_000);
      execute.mockRejectedValue(new Error('Still unavailable'));
      const expired = await changingRuntime.contract({});
      expect(expired.definitions.map(({ name }) => name)).toEqual(['sandbox_read', 'sandbox_exec']);
      expect(expired.systemPrompt).not.toContain('Run the example workflow.');
    } finally {
      now.mockRestore();
    }
  });
});
