import { z } from 'zod';
import type { CredentialStore } from '../persistence/credential-store';
import type { SettingsStore } from '../persistence/settings-store';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type SandboxFetchPort = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type SandboxClientErrorCode = 'AUTH' | 'UNAVAILABLE' | 'INVALID_RESPONSE' | 'ABORTED';
export type SandboxDispatchState = 'definitely_not_dispatched' | 'may_have_dispatched';

export interface SandboxExecRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly executionId?: string;
}

export interface SandboxExecResponse {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SandboxExecutionReceipt =
  | { readonly status: 'not_found'; readonly executionId: string }
  | { readonly status: 'running'; readonly executionId: string }
  | {
      readonly status: 'finished';
      readonly executionId: string;
      readonly outcome: 'interrupted' | 'succeeded' | 'failed' | 'timed_out' | 'output_limit';
      readonly exitCode: number | null;
      readonly stdout: string;
      readonly stderr: string;
      readonly stdoutTruncated: boolean;
      readonly stderrTruncated: boolean;
    };

export interface SandboxClientPort {
  isConfigured(): Promise<boolean>;
  execute(request: SandboxExecRequest, signal: AbortSignal): Promise<SandboxExecResponse>;
  getExecution(executionId: string, signal: AbortSignal): Promise<SandboxExecutionReceipt>;
}

export interface SandboxConsoleClientPort {
  getConsoleUrl(signal: AbortSignal): Promise<string>;
}

const responseSchema = z
  .object({
    code: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  })
  .strict();

const executionReceiptSchema = z.discriminatedUnion('status', [
  z
    .object({
      code: z.literal(0),
      execution_id: z.string().min(1).max(256),
      status: z.literal('not_found'),
    })
    .strict(),
  z
    .object({
      code: z.literal(0),
      execution_id: z.string().min(1).max(256),
      status: z.literal('running'),
    })
    .strict(),
  z
    .object({
      code: z.literal(0),
      execution_id: z.string().min(1).max(256),
      status: z.literal('finished'),
      outcome: z.enum(['interrupted', 'succeeded', 'failed', 'timed_out', 'output_limit']),
      exit_code: z.number().int().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      stdout_truncated: z.boolean(),
      stderr_truncated: z.boolean(),
    })
    .strict(),
]);

const consoleResponseSchema = z
  .object({
    code: z.literal(0),
    url: z
      .string()
      .min(1)
      .max(2_048)
      .refine((value) => {
        try {
          const protocol = new URL(value).protocol;
          return protocol === 'http:' || protocol === 'https:';
        } catch {
          return false;
        }
      }),
  })
  .strict();

const ERROR_MESSAGES: Readonly<Record<SandboxClientErrorCode, string>> = {
  AUTH: 'Sandbox authentication is required.',
  UNAVAILABLE: 'Sandbox is unavailable.',
  INVALID_RESPONSE: 'Sandbox returned an invalid response.',
  ABORTED: 'Sandbox request was aborted.',
};
const validExecutionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export class SandboxClientError extends Error {
  readonly code: SandboxClientErrorCode;
  readonly dispatchState: SandboxDispatchState;

  constructor(code: SandboxClientErrorCode, dispatchState: SandboxDispatchState) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SandboxClientError';
    this.code = code;
    this.dispatchState = dispatchState;
  }
}

function clientError(
  code: SandboxClientErrorCode,
  dispatchState: SandboxDispatchState,
): SandboxClientError {
  return new SandboxClientError(code, dispatchState);
}

function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedJson(
  response: Response,
  signal: AbortSignal,
  dispatchState: SandboxDispatchState,
): Promise<unknown> {
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') || response.body === null) {
    await discardResponse(response);
    throw clientError('INVALID_RESPONSE', dispatchState);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      if (signal.aborted) throw clientError('ABORTED', dispatchState);
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw clientError('INVALID_RESPONSE', dispatchState);
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof SandboxClientError) throw error;
    if (signal.aborted || isAbortFailure(error)) {
      throw clientError('ABORTED', dispatchState);
    }
    throw clientError('UNAVAILABLE', dispatchState);
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw clientError('INVALID_RESPONSE', dispatchState);
  }
}

export class SandboxClient implements SandboxClientPort, SandboxConsoleClientPort {
  readonly #settings: Pick<SettingsStore, 'get'>;
  readonly #credentials: Pick<CredentialStore, 'getSandboxToken'>;
  readonly #fetch: SandboxFetchPort;

  constructor(
    settings: Pick<SettingsStore, 'get'>,
    credentials: Pick<CredentialStore, 'getSandboxToken'>,
    fetchPort: SandboxFetchPort = globalThis.fetch,
  ) {
    this.#settings = settings;
    this.#credentials = credentials;
    this.#fetch = (input, init) => fetchPort(input, init);
  }

  async isConfigured(): Promise<boolean> {
    try {
      const [settings, token] = await Promise.all([
        this.#settings.get(),
        this.#credentials.getSandboxToken(),
      ]);
      return (settings.sandboxServer?.length ?? 0) > 0 && Boolean(token?.trim());
    } catch {
      return false;
    }
  }

  async getConsoleUrl(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw clientError('ABORTED', 'definitely_not_dispatched');
    const { server, token } = await this.#getConnection();

    let response: Response;
    try {
      response = await this.#fetch(`${server.replace(/\/+$/, '')}/console`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) {
        throw clientError('ABORTED', 'definitely_not_dispatched');
      }
      throw clientError('UNAVAILABLE', 'definitely_not_dispatched');
    }

    if (!response.ok) {
      await discardResponse(response);
      if (response.status === 401 || response.status === 403) {
        throw clientError('AUTH', 'definitely_not_dispatched');
      }
      if (response.status >= 400 && response.status < 429) {
        throw clientError('INVALID_RESPONSE', 'definitely_not_dispatched');
      }
      throw clientError('UNAVAILABLE', 'definitely_not_dispatched');
    }

    const parsed = consoleResponseSchema.safeParse(
      await readBoundedJson(response, signal, 'definitely_not_dispatched'),
    );
    if (!parsed.success) {
      throw clientError('INVALID_RESPONSE', 'definitely_not_dispatched');
    }
    return parsed.data.url;
  }

  async execute(request: SandboxExecRequest, signal: AbortSignal): Promise<SandboxExecResponse> {
    if (signal.aborted) throw clientError('ABORTED', 'definitely_not_dispatched');
    const { server, token } = await this.#getConnection();

    let response: Response;
    try {
      response = await this.#fetch(`${server.replace(/\/+$/, '')}/exec`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          command: request.command,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.env === undefined ? {} : { env: request.env }),
          ...(request.executionId === undefined ? {} : { execution_id: request.executionId }),
        }),
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) {
        throw clientError('ABORTED', 'may_have_dispatched');
      }
      throw clientError('UNAVAILABLE', 'may_have_dispatched');
    }

    if (!response.ok) {
      await discardResponse(response);
      if (response.status === 401 || response.status === 403) {
        throw clientError('AUTH', 'definitely_not_dispatched');
      }
      if (response.status >= 400 && response.status < 429) {
        throw clientError('INVALID_RESPONSE', 'definitely_not_dispatched');
      }
      throw clientError('UNAVAILABLE', 'may_have_dispatched');
    }
    if (signal.aborted) {
      await discardResponse(response);
      throw clientError('ABORTED', 'may_have_dispatched');
    }

    const parsed = responseSchema.safeParse(
      await readBoundedJson(response, signal, 'may_have_dispatched'),
    );
    if (!parsed.success) throw clientError('INVALID_RESPONSE', 'may_have_dispatched');
    return parsed.data;
  }

  async getExecution(executionId: string, signal: AbortSignal): Promise<SandboxExecutionReceipt> {
    if (signal.aborted) throw clientError('ABORTED', 'definitely_not_dispatched');
    if (!validExecutionIdPattern.test(executionId)) {
      throw clientError('INVALID_RESPONSE', 'definitely_not_dispatched');
    }
    const { server, token } = await this.#getConnection();

    let response: Response;
    try {
      response = await this.#fetch(
        `${server.replace(/\/+$/, '')}/exec/${encodeURIComponent(executionId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          cache: 'no-store',
          signal,
        },
      );
    } catch (error) {
      if (signal.aborted || isAbortFailure(error)) {
        throw clientError('ABORTED', 'definitely_not_dispatched');
      }
      throw clientError('UNAVAILABLE', 'definitely_not_dispatched');
    }

    if (!response.ok) {
      await discardResponse(response);
      if (response.status === 401 || response.status === 403) {
        throw clientError('AUTH', 'definitely_not_dispatched');
      }
      if (response.status >= 400 && response.status < 429) {
        throw clientError('INVALID_RESPONSE', 'definitely_not_dispatched');
      }
      throw clientError('UNAVAILABLE', 'definitely_not_dispatched');
    }

    const parsed = executionReceiptSchema.safeParse(
      await readBoundedJson(response, signal, 'definitely_not_dispatched'),
    );
    if (!parsed.success || parsed.data.execution_id !== executionId) {
      throw clientError('INVALID_RESPONSE', 'definitely_not_dispatched');
    }
    if (parsed.data.status !== 'finished') {
      return { status: parsed.data.status, executionId: parsed.data.execution_id };
    }
    return {
      status: 'finished',
      executionId: parsed.data.execution_id,
      outcome: parsed.data.outcome,
      exitCode: parsed.data.exit_code,
      stdout: parsed.data.stdout,
      stderr: parsed.data.stderr,
      stdoutTruncated: parsed.data.stdout_truncated,
      stderrTruncated: parsed.data.stderr_truncated,
    };
  }

  async #getConnection(): Promise<{ readonly server: string; readonly token: string }> {
    let server: string;
    try {
      server = (await this.#settings.get()).sandboxServer ?? '';
    } catch {
      throw clientError('UNAVAILABLE', 'definitely_not_dispatched');
    }
    if (server.length === 0) throw clientError('UNAVAILABLE', 'definitely_not_dispatched');

    let token: string | undefined;
    try {
      token = await this.#credentials.getSandboxToken();
    } catch {
      throw clientError('AUTH', 'definitely_not_dispatched');
    }
    const normalizedToken = token?.trim();
    if (!normalizedToken) throw clientError('AUTH', 'definitely_not_dispatched');
    return { server, token: normalizedToken };
  }
}
