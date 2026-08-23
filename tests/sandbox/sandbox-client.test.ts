import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../../src/persistence/settings-store';
import { SandboxClient, type SandboxFetchPort } from '../../src/sandbox/sandbox-client';

const SIGNAL = new AbortController().signal;

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function createClient(
  fetch: SandboxFetchPort,
  server = 'https://sandbox.example.com/root',
  token: string | null = 'sandbox-token',
): SandboxClient {
  return new SandboxClient(
    { get: vi.fn(async () => ({ ...DEFAULT_APP_SETTINGS, sandboxServer: server })) },
    { getSandboxToken: vi.fn(async () => token ?? undefined) },
    fetch,
  );
}

describe('SandboxClient configuration', () => {
  it.each([
    ['', 'sandbox-token'],
    ['https://sandbox.example.com', null],
    ['https://sandbox.example.com', '   '],
  ])('is disabled unless both server and token exist', async (server, token) => {
    const client = createClient(vi.fn(), server, token);

    await expect(client.isConfigured()).resolves.toBe(false);
  });

  it('is enabled when both server and token exist', async () => {
    await expect(createClient(vi.fn()).isConfigured()).resolves.toBe(true);
  });
});

describe('SandboxClient execution', () => {
  it('reads fresh configuration and posts the generic exec contract', async () => {
    const settings = {
      get: vi
        .fn()
        .mockResolvedValueOnce({ ...DEFAULT_APP_SETTINGS, sandboxServer: 'https://old.invalid' })
        .mockResolvedValueOnce({
          ...DEFAULT_APP_SETTINGS,
          sandboxServer: 'https://sandbox.example.com/root',
        }),
    };
    const credentials = {
      getSandboxToken: vi
        .fn()
        .mockResolvedValueOnce('old-token')
        .mockResolvedValueOnce('fresh-token'),
    };
    const fetch = vi.fn<SandboxFetchPort>(async () =>
      jsonResponse({ code: 0, stdout: 'done\n', stderr: '' }),
    );
    const client = new SandboxClient(settings, credentials, fetch);

    await expect(client.isConfigured()).resolves.toBe(true);
    await expect(
      client.execute(
        {
          command: 'printf done',
          cwd: '/workspace',
          env: { INTERNAL_VALUE: 'allowed-for-direct-callers' },
        },
        SIGNAL,
      ),
    ).resolves.toEqual({ code: 0, stdout: 'done\n', stderr: '' });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://sandbox.example.com/root/exec');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer fresh-token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: SIGNAL,
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      command: 'printf done',
      cwd: '/workspace',
      env: { INTERNAL_VALUE: 'allowed-for-direct-callers' },
    });
    expect(String(init?.body)).not.toContain('fresh-token');
  });

  it('omits optional request fields instead of inventing defaults', async () => {
    const fetch = vi.fn<SandboxFetchPort>(async () =>
      jsonResponse({ code: 7, stdout: '', stderr: 'failed' }),
    );
    const client = createClient(fetch);

    await expect(client.execute({ command: 'exit 7' }, SIGNAL)).resolves.toEqual({
      code: 7,
      stdout: '',
      stderr: 'failed',
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ command: 'exit 7' });
  });

  it.each([
    [new Response('not json', { headers: { 'Content-Type': 'text/plain' } })],
    [new Response('{broken', { headers: { 'Content-Type': 'application/json' } })],
    [jsonResponse({ code: '0', stdout: '', stderr: '' })],
    [
      new Response('x'.repeat(8 * 1024 * 1024 + 1), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ],
  ])('rejects malformed or oversized success responses', async (response) => {
    const client = createClient(vi.fn(async () => response));

    await expect(client.execute({ command: 'true' }, SIGNAL)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      dispatchState: 'may_have_dispatched',
    });
  });

  it.each([
    [401, 'AUTH', 'definitely_not_dispatched'],
    [403, 'AUTH', 'definitely_not_dispatched'],
    [400, 'INVALID_RESPONSE', 'definitely_not_dispatched'],
    [429, 'UNAVAILABLE', 'may_have_dispatched'],
    [500, 'UNAVAILABLE', 'may_have_dispatched'],
    [504, 'UNAVAILABLE', 'may_have_dispatched'],
  ] as const)(
    'maps HTTP %s without exposing response bodies',
    async (status, code, dispatchState) => {
      const secret = 'unsafe-response-secret';
      const client = createClient(vi.fn(async () => jsonResponse({ message: secret }, { status })));

      try {
        await client.execute({ command: 'true' }, SIGNAL);
        throw new Error('Expected Sandbox request to fail.');
      } catch (error) {
        expect(error).toMatchObject({ code, dispatchState });
        expect(String(error)).not.toContain(secret);
      }
    },
  );

  it('does not dispatch when configuration is missing', async () => {
    const fetch = vi.fn<SandboxFetchPort>();
    const client = createClient(fetch, '', null);

    await expect(client.execute({ command: 'true' }, SIGNAL)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      dispatchState: 'definitely_not_dispatched',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts transport errors and treats them as ambiguous dispatch', async () => {
    const secret = 'unsafe-transport-secret';
    const client = createClient(
      vi.fn(async () => {
        throw new Error(secret);
      }),
    );

    try {
      await client.execute({ command: 'true' }, SIGNAL);
      throw new Error('Expected Sandbox request to fail.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'UNAVAILABLE',
        dispatchState: 'may_have_dispatched',
      });
      expect(String(error)).not.toContain(secret);
    }
  });

  it('does not dispatch an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn<SandboxFetchPort>();
    const client = createClient(fetch);

    await expect(client.execute({ command: 'true' }, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
      dispatchState: 'definitely_not_dispatched',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
