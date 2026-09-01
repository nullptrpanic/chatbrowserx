import type { SandboxToolCall } from '../tools/sandbox/contract';
import type { SandboxClientPort } from './sandbox-client';

const MAX_STREAM_BYTES = 64 * 1024;
const OMITTED_OUTPUT_MARKER = '\n[... middle output omitted; tail follows ...]\n';

const READ_COMMAND = `set -euo pipefail
path="\${CHATBROWSERX_READ_PATH:?}"
start="\${CHATBROWSERX_READ_START:?}"
limit="\${CHATBROWSERX_READ_LIMIT:?}"
case "$start" in ''|*[!0-9]*) printf 'invalid start line\\n' >&2; exit 2;; esac
case "$limit" in ''|*[!0-9]*) printf 'invalid line limit\\n' >&2; exit 2;; esac
[ -f "$path" ] || { printf 'file does not exist or is not regular\\n' >&2; exit 3; }
[ -r "$path" ] || { printf 'file is not readable\\n' >&2; exit 4; }
if [ -s "$path" ] && ! LC_ALL=C grep -Iq '' -- "$path"; then
  printf 'binary files are not supported\\n' >&2
  exit 5
fi
LC_ALL=C awk -v start="$start" -v limit="$limit" 'NR >= start && NR < start + limit { print }' "$path"`;

export interface SandboxExecutionPort {
  execute(
    call: SandboxToolCall,
    signal: AbortSignal,
    context?: { readonly executionId?: string },
  ): Promise<string>;
  recover(executionId: string, signal: AbortSignal): Promise<SandboxExecutionRecovery>;
}

export type SandboxExecutionRecovery =
  | { readonly status: 'not_found' }
  | { readonly status: 'running' }
  | { readonly status: 'finished'; readonly output: string };

interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

function boundUtf8(value: string): BoundedText {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= MAX_STREAM_BYTES) return { text: value, truncated: false };

  let end = MAX_STREAM_BYTES;
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return {
    text: new TextDecoder().decode(encoded.slice(0, end)),
    truncated: true,
  };
}

function boundUtf8HeadTail(value: string): BoundedText {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= MAX_STREAM_BYTES) return { text: value, truncated: false };

  const marker = new TextEncoder().encode(OMITTED_OUTPUT_MARKER);
  const retainedBytes = MAX_STREAM_BYTES - marker.byteLength;
  let headEnd = Math.floor((retainedBytes * 7) / 8);
  while (headEnd > 0 && ((encoded[headEnd] ?? 0) & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = encoded.byteLength - (retainedBytes - headEnd);
  while (tailStart < encoded.byteLength && ((encoded[tailStart] ?? 0) & 0xc0) === 0x80) {
    tailStart += 1;
  }
  const decoder = new TextDecoder();
  return {
    text: `${decoder.decode(encoded.slice(0, headEnd))}${OMITTED_OUTPUT_MARKER}${decoder.decode(
      encoded.slice(tailStart),
    )}`,
    truncated: true,
  };
}

function commandOutput(
  code: number,
  rawStdout: string,
  rawStderr: string,
  transportTruncated: boolean,
  executionStatus: Readonly<Record<string, string>> = {},
): string {
  const stdout = boundUtf8HeadTail(rawStdout);
  const stderr = boundUtf8HeadTail(rawStderr);
  const truncated = transportTruncated || stdout.truncated || stderr.truncated;
  return JSON.stringify({
    code,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated,
    ...executionStatus,
  });
}

export class SandboxToolExecutor implements SandboxExecutionPort {
  readonly #client: SandboxClientPort;

  constructor(client: SandboxClientPort) {
    this.#client = client;
  }

  async execute(
    call: SandboxToolCall,
    signal: AbortSignal,
    context: { readonly executionId?: string } = {},
  ): Promise<string> {
    if (call.operation === 'exec') {
      return this.#executeCommand(call, signal, context.executionId);
    }
    return this.#readFile(call, signal);
  }

  async recover(executionId: string, signal: AbortSignal): Promise<SandboxExecutionRecovery> {
    const receipt = await this.#client.getExecution(executionId, signal);
    if (receipt.status !== 'finished') return { status: receipt.status };

    const executionStatus =
      receipt.exitCode === null || !['succeeded', 'failed'].includes(receipt.outcome)
        ? { executionStatus: receipt.outcome }
        : {};
    return {
      status: 'finished',
      output: commandOutput(
        receipt.exitCode ?? 1,
        receipt.stdout,
        receipt.stderr,
        receipt.stdoutTruncated || receipt.stderrTruncated,
        executionStatus,
      ),
    };
  }

  async #readFile(
    call: Extract<SandboxToolCall, { readonly operation: 'read' }>,
    signal: AbortSignal,
  ): Promise<string> {
    const { path, startLine, maxLines } = call.arguments;
    const result = await this.#client.execute(
      {
        command: READ_COMMAND,
        env: {
          CHATBROWSERX_READ_PATH: path,
          CHATBROWSERX_READ_START: String(startLine),
          CHATBROWSERX_READ_LIMIT: String(maxLines + 1),
        },
      },
      signal,
    );

    if (result.code !== 0) {
      const error = boundUtf8(result.stderr);
      return JSON.stringify({
        code: result.code,
        path,
        startLine,
        endLine: startLine - 1,
        truncated: error.truncated,
        content: '',
        error: error.text,
      });
    }

    const lines = result.stdout.length === 0 ? [] : result.stdout.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const selected = lines.slice(0, maxLines);
    const content = selected.length === 0 ? '' : `${selected.join('\n')}\n`;
    const bounded = boundUtf8(content);
    return JSON.stringify({
      code: 0,
      path,
      startLine,
      endLine: selected.length === 0 ? startLine - 1 : startLine + selected.length - 1,
      truncated: lines.length > maxLines || bounded.truncated,
      content: bounded.text,
    });
  }

  async #executeCommand(
    call: Extract<SandboxToolCall, { readonly operation: 'exec' }>,
    signal: AbortSignal,
    executionId: string | undefined,
  ): Promise<string> {
    const result = await this.#client.execute(
      {
        command: call.arguments.command,
        ...(call.arguments.cwd === null ? {} : { cwd: call.arguments.cwd }),
        ...(executionId === undefined ? {} : { executionId }),
      },
      signal,
    );
    return commandOutput(result.code, result.stdout, result.stderr, false);
  }
}
