import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { strictFunctionTool } from '../../../src/tools/model-tool';
import { ToolDeclarationCatalog } from '../../../src/tools/register';
import { bindToolRuntime } from '../../../src/tools/registry';
import { createToolServiceToken, ToolServiceResolver } from '../../../src/tools/service-resolver';

describe('bindToolRuntime', () => {
  it('builds an immutable turn contract and rejects registered but unavailable calls', async () => {
    const catalog = new ToolDeclarationCatalog();
    const prepare = vi.fn(() => ({ context: { prepared: true } }));
    const sharedRuntime = { prepare };
    const execute = vi.fn(async ({ arguments: { value } }) => ({
      output: value,
    }));
    catalog.register(
      {
        name: 'visible_tool',
        definition: strictFunctionTool('visible_tool', 'visible', {
          value: { type: 'string' },
        }),
        schema: z.object({ value: z.string() }).strict(),
        order: 2,
        policy: { budgetGroup: 'visible', maxCalls: 1 },
        execute,
      },
      sharedRuntime,
    );
    catalog.register(
      {
        name: 'hidden_tool',
        definition: strictFunctionTool('hidden_tool', 'hidden', {}),
        schema: z.object({}).strict(),
        order: 1,
        policy: { budgetGroup: 'hidden', maxCalls: 1 },
        available: () => false,
        execute: vi.fn(async () => ({ output: '' })),
      },
      sharedRuntime,
    );
    const runtime = bindToolRuntime(catalog.seal(), new ToolServiceResolver());

    const contract = await runtime.contract({});

    expect(contract.definitions.map(({ name }) => name)).toEqual(['visible_tool']);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(contract.definitions)).toBe(true);
    expect(() =>
      contract.parse({
        callId: 'call_1',
        name: 'hidden_tool',
        argumentsJson: '{}',
      }),
    ).toThrow(/not available/i);
    expect(
      runtime.parseRecorded({
        callId: 'call_recorded',
        name: 'hidden_tool',
        argumentsJson: '{}',
      }),
    ).toMatchObject({ name: 'hidden_tool', arguments: {} });
    expect(runtime.policyFor('visible_tool')).toMatchObject({
      budgetGroup: 'visible',
      maxCalls: 1,
    });
    expect(runtime.canRecover('visible_tool')).toBe(false);
    const call = contract.parse({
      callId: 'call_2',
      name: 'visible_tool',
      argumentsJson: '{"value":"ok"}',
    });
    await expect(runtime.execute(call, {}, AbortSignal.timeout(1_000))).resolves.toEqual({
      output: 'ok',
    });
  });

  it('binds isolated service instances for separate Agent runtimes', async () => {
    const service = createToolServiceToken<{ readonly value: string }>('test-service');
    const catalog = new ToolDeclarationCatalog();
    catalog.register({
      name: 'service_tool',
      definition: strictFunctionTool('service_tool', 'service', {}),
      schema: z.object({}).strict(),
      policy: { budgetGroup: 'service', maxCalls: 1 },
      execute: vi.fn(async (_call, _context, services) => ({
        output: services.get(service).value,
      })),
    });
    const declarations = catalog.seal();
    const first = bindToolRuntime(
      declarations,
      new ToolServiceResolver([[service, { value: 'first' }]]),
    );
    const second = bindToolRuntime(
      declarations,
      new ToolServiceResolver([[service, { value: 'second' }]]),
    );
    const source = {
      callId: 'call_1',
      name: 'service_tool',
      argumentsJson: '{}',
    };

    await expect(
      first.execute((await first.contract({})).parse(source), {}, AbortSignal.timeout(1_000)),
    ).resolves.toEqual({ output: 'first' });
    await expect(
      second.execute((await second.contract({})).parse(source), {}, AbortSignal.timeout(1_000)),
    ).resolves.toEqual({ output: 'second' });
  });

  it('combines tool-owned system prompt contributions in registration order', async () => {
    const catalog = new ToolDeclarationCatalog();
    for (const [name, prompt] of [
      ['first_tool', 'First prompt.'],
      ['second_tool', 'Second prompt.'],
    ] as const) {
      catalog.register(
        {
          name,
          definition: strictFunctionTool(name, name, {}),
          schema: z.object({}).strict(),
          policy: { budgetGroup: name, maxCalls: 1 },
          execute: async () => ({ output: '' }),
        },
        { system_prompt: () => prompt },
      );
    }
    const runtime = bindToolRuntime(catalog.seal(), new ToolServiceResolver());

    await expect(runtime.contract({})).resolves.toMatchObject({
      systemPrompt: 'First prompt.\n\nSecond prompt.',
    });
  });

  it('keeps an unavailable prompt-only tool hidden while retaining its system prompt', async () => {
    const catalog = new ToolDeclarationCatalog();
    catalog.register(
      {
        name: 'hidden_prompt_tool',
        definition: strictFunctionTool('hidden_prompt_tool', 'hidden prompt tool', {}),
        schema: z.object({}).strict(),
        policy: { budgetGroup: 'hidden_prompt', maxCalls: 1 },
        available: () => false,
        execute: async () => ({ output: '' }),
      },
      { system_prompt: () => 'Hidden prompt.' },
    );
    const runtime = bindToolRuntime(catalog.seal(), new ToolServiceResolver());

    await expect(runtime.contract({})).resolves.toMatchObject({
      definitions: [],
      systemPrompt: 'Hidden prompt.',
    });
  });
});
