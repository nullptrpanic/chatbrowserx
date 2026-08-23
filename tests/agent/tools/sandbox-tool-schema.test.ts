import { describe, expect, it } from 'vitest';
import {
  SANDBOX_TOOL_DEFINITIONS,
  parseSandboxToolCall,
} from '../../../src/agent/tools/sandbox-tool-schema';

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

describe('parseSandboxToolCall', () => {
  it('parses reads as replay-safe and execs as mutations', () => {
    expect(
      parseSandboxToolCall({
        callId: 'call_read',
        name: 'sandbox_read',
        argumentsJson: JSON.stringify(READ),
      }),
    ).toEqual({
      family: 'sandbox',
      operation: 'read',
      replay: 'safe',
      callId: 'call_read',
      name: 'sandbox_read',
      argumentsJson: JSON.stringify(READ),
      arguments: READ,
    });
    expect(
      parseSandboxToolCall({
        callId: 'call_exec',
        name: 'sandbox_exec',
        argumentsJson: JSON.stringify({ ...EXEC, cwd: null }),
      }),
    ).toEqual({
      family: 'sandbox',
      operation: 'exec',
      replay: 'mutation',
      callId: 'call_exec',
      name: 'sandbox_exec',
      argumentsJson: JSON.stringify({ ...EXEC, cwd: null }),
      arguments: { ...EXEC, cwd: null },
    });
  });

  it.each([
    { callId: '', name: 'sandbox_read', argumentsJson: JSON.stringify(READ) },
    { callId: 'c'.repeat(257), name: 'sandbox_read', argumentsJson: JSON.stringify(READ) },
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
  ])('redacts unsupported or malformed calls as provider failures', (input) => {
    let thrown: unknown;
    try {
      parseSandboxToolCall(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(String(thrown)).not.toContain('secret-value');
  });
});
