import { describe, expect, it, vi } from 'vitest';
import type { ParsedSandboxToolCall } from '../../src/agent/tools/sandbox-tool-schema';
import {
  SandboxClientError,
  type SandboxClientPort,
  type SandboxExecResponse,
} from '../../src/sandbox/sandbox-client';
import { SandboxToolExecutor } from '../../src/sandbox/sandbox-tool-executor';

const SIGNAL = new AbortController().signal;

function readCall(overrides: Partial<ParsedSandboxToolCall['arguments']> = {}) {
  const arguments_ = {
    path: '/home/test/.codex/skills/example/SKILL.md',
    startLine: 1,
    maxLines: 2,
    ...overrides,
  };
  return {
    family: 'sandbox',
    operation: 'read',
    replay: 'safe',
    callId: 'call_read',
    name: 'sandbox_read',
    argumentsJson: JSON.stringify(arguments_),
    arguments: arguments_,
  } as const satisfies ParsedSandboxToolCall;
}

function execCall(cwd: string | null = '/home/test/.codex/skills/example') {
  const arguments_ = { command: 'bash scripts/run.sh', cwd };
  return {
    family: 'sandbox',
    operation: 'exec',
    replay: 'mutation',
    callId: 'call_exec',
    name: 'sandbox_exec',
    argumentsJson: JSON.stringify(arguments_),
    arguments: arguments_,
  } as const satisfies ParsedSandboxToolCall;
}

function fixture(response: SandboxExecResponse) {
  const execute = vi.fn<SandboxClientPort['execute']>(async () => response);
  const client: SandboxClientPort = {
    isConfigured: vi.fn(async () => true),
    execute,
  };
  return { execute, executor: new SandboxToolExecutor(client) };
}

describe('SandboxToolExecutor sandbox_read', () => {
  it('uses one fixed command and passes read values only through internal environment', async () => {
    const first = fixture({ code: 0, stdout: 'line one\nline two\n', stderr: '' });

    const output = JSON.parse(await first.executor.execute(readCall(), SIGNAL));

    expect(output).toEqual({
      code: 0,
      path: '/home/test/.codex/skills/example/SKILL.md',
      startLine: 1,
      endLine: 2,
      truncated: false,
      content: 'line one\nline two\n',
    });
    const request = first.execute.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      command: expect.any(String),
      env: {
        CHATBROWSERX_READ_PATH: '/home/test/.codex/skills/example/SKILL.md',
        CHATBROWSERX_READ_START: '1',
        CHATBROWSERX_READ_LIMIT: '3',
      },
    });
    expect(request?.command).not.toContain('/home/test/.codex/skills/example/SKILL.md');

    const second = fixture({ code: 0, stdout: '', stderr: '' });
    await second.executor.execute(readCall({ path: '/different path/file.txt' }), SIGNAL);
    expect(second.execute.mock.calls[0]?.[0].command).toBe(request?.command);
  });

  it('detects an extra line and caps content at 64 KiB', async () => {
    const lineLimited = fixture({ code: 0, stdout: 'one\ntwo\nthree\n', stderr: '' });
    const byteLimited = fixture({ code: 0, stdout: `${'x'.repeat(70 * 1024)}\n`, stderr: '' });

    await expect(lineLimited.executor.execute(readCall(), SIGNAL)).resolves.toContain(
      '"truncated":true',
    );
    const lineResult = JSON.parse(await lineLimited.executor.execute(readCall(), SIGNAL));
    expect(lineResult).toMatchObject({ endLine: 2, content: 'one\ntwo\n', truncated: true });

    const byteResult = JSON.parse(
      await byteLimited.executor.execute(readCall({ maxLines: 10 }), SIGNAL),
    );
    expect(new TextEncoder().encode(byteResult.content).byteLength).toBe(64 * 1024);
    expect(byteResult.truncated).toBe(true);
  });

  it('returns bounded non-zero read diagnostics as a normal tool result', async () => {
    const current = fixture({ code: 3, stdout: '', stderr: 'e'.repeat(70 * 1024) });

    const output = JSON.parse(await current.executor.execute(readCall(), SIGNAL));

    expect(output).toMatchObject({
      code: 3,
      path: '/home/test/.codex/skills/example/SKILL.md',
      startLine: 1,
      endLine: 0,
      truncated: true,
      content: '',
    });
    expect(new TextEncoder().encode(output.error).byteLength).toBe(64 * 1024);
  });

  it('propagates sanitized client failures', async () => {
    const client: SandboxClientPort = {
      isConfigured: vi.fn(async () => true),
      execute: vi.fn(async () => {
        throw new SandboxClientError('AUTH', 'definitely_not_dispatched');
      }),
    };

    await expect(new SandboxToolExecutor(client).execute(readCall(), SIGNAL)).rejects.toMatchObject(
      { code: 'AUTH', dispatchState: 'definitely_not_dispatched' },
    );
  });
});

describe('SandboxToolExecutor sandbox_exec', () => {
  it('maps command and cwd directly without exposing an environment map', async () => {
    const current = fixture({ code: 7, stdout: 'partial', stderr: 'failed' });

    const output = JSON.parse(await current.executor.execute(execCall(), SIGNAL));

    expect(current.execute.mock.calls[0]?.[0]).toEqual({
      command: 'bash scripts/run.sh',
      cwd: '/home/test/.codex/skills/example',
    });
    expect(output).toEqual({
      code: 7,
      stdout: 'partial',
      stderr: 'failed',
      truncated: false,
    });
  });

  it('omits null cwd and independently caps stdout and stderr', async () => {
    const current = fixture({
      code: 0,
      stdout: 'o'.repeat(70 * 1024),
      stderr: 'e'.repeat(70 * 1024),
    });

    const output = JSON.parse(await current.executor.execute(execCall(null), SIGNAL));

    expect(current.execute.mock.calls[0]?.[0]).toEqual({ command: 'bash scripts/run.sh' });
    expect(new TextEncoder().encode(output.stdout).byteLength).toBe(64 * 1024);
    expect(new TextEncoder().encode(output.stderr).byteLength).toBe(64 * 1024);
    expect(output.truncated).toBe(true);
  });
});
