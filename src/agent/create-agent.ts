import type { BrowserExecutionPort } from '../browser/browser-execution-types';
import type { AttachmentRepository } from '../persistence/attachment-repository';
import type { ConversationRepository } from '../persistence/conversation-repository';
import type { CredentialStore } from '../persistence/credential-store';
import type { SettingsStore } from '../persistence/settings-store';
import type { TaskRepository } from '../persistence/task-repository';
import { createProviders } from '../providers/discover';
import { ChromeLocalStorageArea, type StorageAreaPort } from '../persistence/storage-area';
import { SandboxClient } from '../sandbox/sandbox-client';
import type { SandboxExecutionPort } from '../sandbox/sandbox-tool-executor';
import type { IdGenerator } from '../shared/ids';
import type { Clock } from '../shared/time';
import { RecoveryScanner } from '../tasks/recovery-scanner';
import { TaskCommandService } from '../tasks/task-command-service';
import { TaskCoordinator } from '../tasks/task-coordinator';
import type { TaskHistoryReaderPort } from '../tasks/task-history-reader';
import { discoverTools } from '../tools/discover';
import { bindToolRuntime } from '../tools/registry';
import { ToolServiceResolver } from '../tools/service-resolver';
import { browserService } from '../tools/browser/service';
import { historyService } from '../tools/history/service';
import { createSandboxToolService, sandboxService } from '../tools/sandbox/service';
import { AgentFacade, type Agent } from './agent';
import { AgentRuntime } from './agent-runtime';
import { TaskExecutor } from './task-executor';

/** Host-owned services needed to bind one isolated Agent runtime. */
export interface AgentHost {
  readonly tasks: TaskRepository;
  readonly conversations: ConversationRepository;
  readonly attachments: Pick<AttachmentRepository, 'get'>;
  readonly credentials: CredentialStore;
  readonly storage?: StorageAreaPort;
  readonly settings: Pick<SettingsStore, 'get'>;
  readonly browser: BrowserExecutionPort;
  readonly sandbox?: SandboxExecutionPort;
  readonly history?: TaskHistoryReaderPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly onExecutionError?: (taskId: string, error: unknown) => void;
}

/** Composes the backend, framework runtime, durable executor, scheduler, and recovery behind one Agent. */
export async function createAgent(host: AgentHost): Promise<Agent> {
  const services = new ToolServiceResolver();
  services.bind(browserService, host.browser);
  if (host.history !== undefined) services.bind(historyService, host.history);
  if (host.sandbox !== undefined) {
    services.bind(sandboxService, createSandboxToolService(host.sandbox));
  }
  const tools = bindToolRuntime(discoverTools(), services);
  const commands = new TaskCommandService(host.tasks, host.clock, host.ids, host.conversations);
  const providers = await createProviders({
    credentials: host.credentials,
    settings: host.settings,
    sandbox: new SandboxClient(host.settings, host.credentials),
    storage: host.storage ?? new ChromeLocalStorageArea(),
  });
  const runtime = new AgentRuntime({
    providers,
    tools,
    conversations: host.conversations,
    tasks: host.tasks,
    attachments: host.attachments,
    ids: host.ids,
    clock: host.clock,
  });
  const executor = new TaskExecutor({
    repository: host.tasks,
    conversations: host.conversations,
    runtime,
    tools,
    clock: host.clock,
    ids: host.ids,
  });
  const coordinator = new TaskCoordinator({
    executor,
    commands,
    ...(host.onExecutionError === undefined ? {} : { onExecutionError: host.onExecutionError }),
  });
  const recovery = new RecoveryScanner({
    repository: host.tasks,
    clock: host.clock,
    startTask: async (taskId, runId) => coordinator.schedule(taskId, runId),
  });
  return new AgentFacade({
    generation: runtime,
    providers,
    submissions: commands,
    commands,
    coordinator,
    recovery,
  });
}
