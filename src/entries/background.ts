import { CodexAgentPlanner } from '../agent/codex-agent-planner';
import { TaskExecutor } from '../agent/task-executor';
import { AttachmentService } from '../attachments/attachment-service';
import { cropCapturedImage } from '../attachments/crop-captured-image';
import { BrowserToolExecutor } from '../browser/browser-tool-executor';
import { BrowserActionExecutor } from '../browser/actions/browser-action-executor';
import { ChromeDebuggerTransport } from '../browser/debugger/debugger-transport';
import { TargetSessionRegistry } from '../browser/debugger/target-session-registry';
import { ElementRefStore } from '../browser/observation/element-ref-store';
import { PageObserver } from '../browser/observation/page-observer';
import { NetworkCaptureRegistry } from '../browser/network/network-capture-registry';
import { TabService } from '../browser/tab-service';
import { IndexedDbAttachmentRepository } from '../persistence/attachment-repository';
import { IndexedDbConversationRepository } from '../persistence/conversation-repository';
import { ChromeCredentialStore } from '../persistence/credential-store';
import { openChatBrowserDatabase } from '../persistence/open-database';
import { ChromeSettingsStore } from '../persistence/settings-store';
import { ChromeLocalStorageArea } from '../persistence/storage-area';
import { IndexedDbTaskRepository } from '../persistence/task-repository';
import { ContentScriptInstaller } from '../platform/chrome/content-script-installer';
import { ChromePageObservationPort } from '../platform/chrome/page-observation-port';
import { ChromePointerPagePort } from '../platform/chrome/pointer-page-port';
import { captureVisibleTab } from '../platform/chrome/capture-visible-tab';
import { createMessageRouter, type MessageRouter } from '../platform/chrome/message-router';
import { ChromeScreenshotPagePort } from '../platform/chrome/screenshot-page-port';
import {
  registerBackground,
  type BackgroundChromeApi,
  type RecoveryTriggerPort,
} from '../platform/chrome/register-background';
import { CodexProvider } from '../providers/codex/codex-provider';
import { TavilyClient } from '../providers/tavily/tavily-client';
import { SandboxClient } from '../sandbox/sandbox-client';
import { SandboxToolExecutor } from '../sandbox/sandbox-tool-executor';
import { SkillCatalog } from '../sandbox/skill-catalog';
import type { IdGenerator, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import { RecoveryScanner } from '../tasks/recovery-scanner';
import { TaskCommandService } from '../tasks/task-command-service';
import { TaskCoordinator } from '../tasks/task-coordinator';
import { PanelService } from '../tasks/panel-service';
import { PanelChangeNotifier } from '../tasks/panel-change-notifier';
import { ScreenshotController } from '../tasks/screenshot-controller';

interface BackgroundServices {
  readonly router: MessageRouter;
  readonly recovery: RecoveryScanner;
}

const systemClock: Clock = {
  now: () => Date.now(),
};

const cryptoIds: IdGenerator = {
  create: (prefix) => `${prefix}_${crypto.randomUUID()}`,
};

/** Reports a detached task failure without exposing task, provider, page, or credential values. */
function reportTaskExecutionFailure(): void {
  console.error('ChatBrowserX task execution failed.');
}

/**
 * Composes the complete durable agent runtime once behind the synchronously registered MV3 boundary.
 */
async function createBackgroundServices(
  credentials: ChromeCredentialStore,
): Promise<BackgroundServices> {
  const database = await openChatBrowserDatabase();
  const panelChanges = new PanelChangeNotifier({
    clock: systemClock,
    publish: async (notification) => {
      await chrome.runtime.sendMessage(notification).catch(() => undefined);
    },
  });
  const repository = new IndexedDbTaskRepository(database, () => panelChanges.changed());
  await repository.pruneObsoleteCheckpoints();
  const conversations = new IndexedDbConversationRepository(database, () => panelChanges.changed());
  const attachments = new IndexedDbAttachmentRepository(database);
  const attachmentService = new AttachmentService(attachments, {
    clock: systemClock,
    ids: cryptoIds,
  });
  const settings = new ChromeSettingsStore();
  const commands = new TaskCommandService(repository, systemClock, cryptoIds, conversations);
  const installer = new ContentScriptInstaller();
  const screenshotPage = new ChromeScreenshotPagePort({
    installer,
    tabs: chrome.tabs,
    ids: cryptoIds,
  });
  const screenshots = new ScreenshotController({
    page: screenshotPage,
    capture: (tabId) => captureVisibleTab(tabId),
    crop: (blob, selection) => cropCapturedImage(blob, selection),
    persist: async (blob, source) => {
      const attachment = await attachmentService.addImageBlob(blob, source);
      return { id: attachment.id };
    },
  });
  const codex = new CodexProvider(credentials);
  const tavily = new TavilyClient(credentials);
  const sandboxClient = new SandboxClient(settings, credentials);
  const sandboxCatalog = new SkillCatalog(
    sandboxClient,
    settings,
    new ChromeLocalStorageArea(),
    systemClock,
  );
  const sandbox = new SandboxToolExecutor(sandboxClient);
  const debuggerTransport = new ChromeDebuggerTransport();
  const browserSessions = new TargetSessionRegistry(debuggerTransport);
  const browserRefs = new ElementRefStore(cryptoIds);
  const browserPage = new ChromePageObservationPort({
    installer,
    tabs: chrome.tabs,
    ids: cryptoIds,
  });
  const browserObserver = new PageObserver({
    sessions: browserSessions,
    transport: debuggerTransport,
    content: browserPage,
    refs: browserRefs,
    persistScreenshot: async (blob, source) => {
      const attachment = await attachmentService.addImageBlob(blob, source);
      return { id: attachment.id };
    },
  });
  const browserActions = new BrowserActionExecutor({
    sessions: browserSessions,
    transport: debuggerTransport,
    refs: browserRefs,
    pointer: new ChromePointerPagePort({ installer, tabs: chrome.tabs, ids: cryptoIds }),
    platform: { getOs: async () => (await chrome.runtime.getPlatformInfo()).os },
    page: browserPage,
    attachments,
  });
  const browserNetwork = new NetworkCaptureRegistry({
    sessions: browserSessions,
    transport: debuggerTransport,
    ids: cryptoIds,
    clock: systemClock,
  });
  const browser = new BrowserToolExecutor({
    tabs: new TabService(),
    observer: browserObserver,
    actions: browserActions,
    network: browserNetwork,
    sessions: browserSessions,
  });
  const planner = new CodexAgentPlanner({
    provider: codex,
    skillCatalog: sandboxCatalog,
    tavilyAvailability: {
      async isConfigured() {
        try {
          return Boolean((await credentials.getTavilyKey())?.trim());
        } catch {
          return false;
        }
      },
    },
    settings,
    conversations,
    tasks: repository,
    attachments,
    ids: cryptoIds,
    clock: systemClock,
  });
  const executor = new TaskExecutor({
    repository,
    conversations,
    planner,
    tavily,
    sandbox,
    browser,
    attachments: attachmentService,
    clock: systemClock,
    ids: cryptoIds,
  });
  const coordinator = new TaskCoordinator({
    executor,
    commands,
    onExecutionError: reportTaskExecutionFailure,
  });
  const scheduleTask = async (taskId: TaskId): Promise<void> => {
    void coordinator.start(taskId).catch(reportTaskExecutionFailure);
  };
  const panel = new PanelService({
    conversations,
    tasks: repository,
    attachments,
    settings,
    credentials,
    sandboxCatalog,
    commands,
    tabs: chrome.tabs,
    permissions: {
      contains: (permissions) => chrome.permissions.contains({ origins: [...permissions.origins] }),
    },
    imagePreview: {
      open: (tabId, preview) => screenshotPage.openImagePreview(tabId, preview),
    },
    clock: systemClock,
    ids: cryptoIds,
    scheduleTask,
    stateVersion: {
      get: () => panelChanges.getVersion(),
      changed: () => panelChanges.changed(),
    },
    cancelTask: (taskId) => coordinator.cancel(taskId),
  });
  const recovery = new RecoveryScanner({
    repository,
    clock: systemClock,
    startTask: scheduleTask,
  });
  const router = createMessageRouter({
    commands: {
      getSnapshot: (taskId) => commands.getSnapshot(taskId),
      pause: (taskId) => coordinator.pause(taskId),
      resume: (taskId) => coordinator.resume(taskId),
      retry: (taskId) => coordinator.retry(taskId),
      cancel: (taskId) => coordinator.cancel(taskId),
      clearContext: (taskId) => commands.clearContext(taskId),
    },
    panel,
    screenshots,
    sandboxConsole: sandboxClient,
    requestRecoveryScan: () => recovery.requestRecoveryScan(),
    scheduleTask,
    pageFeatures: {
      /** Installs only the isolated page feature bundle after optional origin access exists. */
      async ensure(tabId) {
        const tab = await chrome.tabs.get(tabId);
        return installer.ensureInstalled(tabId, tab.url ?? '');
      },
    },
  });
  return { router, recovery };
}

const credentialStore = new ChromeCredentialStore();
const services = createBackgroundServices(credentialStore);
const lazyRouter: MessageRouter = async (value) => (await services).router(value);
const lazyRecovery: RecoveryTriggerPort = {
  requestRecoveryScan: async () => (await services).recovery.requestRecoveryScan(),
  handleBrowserStartup: async () => (await services).recovery.handleBrowserStartup(),
};

const registration = registerBackground({
  api: chrome as unknown as BackgroundChromeApi,
  router: lazyRouter,
  recovery: lazyRecovery,
  credentialStore,
});

void registration.ready.catch(() => undefined);
