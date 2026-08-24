import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, Socket, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseSandboxToolCall } from '../src/agent/tools/sandbox-tool-schema';
import { SandboxClient, type SandboxClientPort } from '../src/sandbox/sandbox-client';
import { SandboxToolExecutor } from '../src/sandbox/sandbox-tool-executor';
import { SkillCatalog } from '../src/sandbox/skill-catalog';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sandboxManifest = join(projectRoot, 'sandbox', 'Cargo.toml');
const sandboxBinary = join(
  projectRoot,
  'sandbox',
  'target',
  'debug',
  process.platform === 'win32' ? 'chatbrowserx-sandbox.exe' : 'chatbrowserx-sandbox',
);
let currentStage = 'initialize';

class MemoryStorage {
  readonly #values = new Map<string, unknown>();

  async get(keys?: string | readonly string[]): Promise<Record<string, unknown>> {
    const selected =
      keys === undefined ? [...this.#values.keys()] : typeof keys === 'string' ? [keys] : [...keys];
    return Object.fromEntries(
      selected.flatMap((key) =>
        this.#values.has(key) ? ([[key, this.#values.get(key)]] as const) : [],
      ),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.#values.set(key, value);
  }

  async remove(keys: string | readonly string[]): Promise<void> {
    for (const key of typeof keys === 'string' ? [keys] : keys) this.#values.delete(key);
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = new Socket();
      socket.setTimeout(200);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(false));
      socket.connect(port, '127.0.0.1');
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Sandbox server did not become ready.');
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function checkSandbox(): Promise<void> {
  currentStage = 'create fixture';
  const temporaryHome = await mkdtemp(join(tmpdir(), 'chatbrowserx-sandbox-check-'));
  let sandbox: ChildProcess | null = null;
  try {
    const skillDirectory = join(temporaryHome, '.codex', 'skills', 'fixture-skill');
    const scriptDirectory = join(skillDirectory, 'scripts');
    const skillPath = join(skillDirectory, 'SKILL.md');
    const scriptPath = join(scriptDirectory, 'run.sh');
    await mkdir(scriptDirectory, { recursive: true });
    await writeFile(
      skillPath,
      '---\nname: fixture-skill\ndescription: Verifies the Sandbox integration boundary.\n---\n\nRun `bash scripts/run.sh`.\n',
      { mode: 0o600 },
    );
    await writeFile(scriptPath, '#!/usr/bin/env bash\nset -euo pipefail\nprintf fixture-ok\n', {
      mode: 0o700,
    });
    await chmod(scriptPath, 0o700);

    const port = await availablePort();
    const configPath = join(temporaryHome, 'sandbox.json');
    await writeFile(
      configPath,
      JSON.stringify({
        host: '127.0.0.1',
        port,
        secret: randomBytes(32).toString('hex'),
        log_file: join(temporaryHome, 'sandbox.log'),
        timeout_seconds: 10,
      }),
      { mode: 0o600 },
    );

    currentStage = 'build sandbox';
    await execFileAsync('cargo', ['build', '--quiet', '--manifest-path', sandboxManifest]);
    currentStage = 'issue token';
    const issued = await execFileAsync(sandboxBinary, [
      'key',
      '-c',
      configPath,
      '-g',
      'integration',
      '-e',
      '1',
    ]);
    const token = issued.stdout.trim();
    assert.ok(token.length > 0);

    currentStage = 'start sandbox';
    sandbox = spawn(sandboxBinary, ['daemon', '-c', configPath], {
      env: { ...process.env, HOME: temporaryHome },
      stdio: 'ignore',
    });
    await waitForPort(port);

    const settings = {
      get: async () => ({
        model: 'gpt-5.6-terra',
        reasoningEffort: 'medium' as const,
        systemPrompt: '',
        language: 'en' as const,
        historyMessageLimit: 50,
        sandboxServer: `http://127.0.0.1:${String(port)}`,
      }),
    };
    const client = new SandboxClient(settings, { getSandboxToken: async () => token });
    let requestCount = 0;
    const countedClient: SandboxClientPort = {
      isConfigured: () => client.isConfigured(),
      execute: (request, signal) => {
        requestCount += 1;
        return client.execute(request, signal);
      },
    };
    const clock = { now: () => Date.now() };
    const catalog = new SkillCatalog(countedClient, settings, new MemoryStorage(), clock);
    const executor = new SandboxToolExecutor(countedClient);
    const signal = new AbortController().signal;

    currentStage = 'discover catalog';
    const firstCatalog = await catalog.get(signal);
    assert.equal(firstCatalog?.entries.length, 1);
    assert.equal(firstCatalog.entries[0]?.name, 'fixture-skill');
    assert.equal(firstCatalog.entries[0]?.path, skillPath);
    assert.equal(requestCount, 1);
    const cachedCatalog = await catalog.get(signal);
    assert.deepEqual(cachedCatalog, firstCatalog);
    assert.equal(requestCount, 1);

    currentStage = 'read Skill';
    const readResult = JSON.parse(
      await executor.execute(
        parseSandboxToolCall({
          callId: 'call_read',
          name: 'sandbox_read',
          argumentsJson: JSON.stringify({ path: skillPath, startLine: 1, maxLines: 400 }),
        }),
        signal,
      ),
    ) as Record<string, unknown>;
    currentStage = `read Skill response (code=${String(readResult.code)})`;
    assert.equal(readResult.code, 0);
    assert.equal(readResult.truncated, false);
    assert.equal(readResult.content, await readFile(skillPath, 'utf8'));

    currentStage = 'execute Skill';
    const execResult = JSON.parse(
      await executor.execute(
        parseSandboxToolCall({
          callId: 'call_exec',
          name: 'sandbox_exec',
          argumentsJson: JSON.stringify({ command: 'bash scripts/run.sh', cwd: skillDirectory }),
        }),
        signal,
      ),
    ) as Record<string, unknown>;
    assert.equal(execResult.code, 0);
    assert.equal(execResult.stdout, 'fixture-ok');
    assert.equal(execResult.stderr, '');
    assert.equal(execResult.truncated, false);
  } finally {
    await stopProcess(sandbox);
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

try {
  await checkSandbox();
  console.log('sandbox integration check passed');
} catch {
  console.error(`sandbox integration check failed: ${currentStage}`);
  process.exitCode = 1;
}
