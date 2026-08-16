import { CodexAgentPlanner } from '../agent/codex-agent-planner';
import { TaskExecutor } from '../agent/task-executor';
import { AttachmentService } from '../attachments/attachment-service';
import { cropCapturedImage } from '../attachments/crop-captured-image';
import { IndexedDbAttachmentRepository } from '../persistence/attachment-repository';
import { IndexedDbConversationRepository } from '../persistence/conversation-repository';
import { ChromeCredentialStore } from '../persistence/credential-store';
import { openChatBrowserDatabase } from '../persistence/open-database';
import { ChromeSettingsStore } from '../persistence/settings-store';
import { IndexedDbTaskRepository } from '../persistence/task-repository';
import { ContentScriptInstaller } from '../platform/chrome/content-script-installer';
import { captureVisibleTab } from '../platform/chrome/capture-visible-tab';
import { createMessageRouter, type MessageRouter } from '../platform/chrome/message-router';
import { ChromeScreenshotPagePort } from '../platform/chrome/screenshot-page-port';
import {
  registerBackground,
  type BackgroundChromeApi,
  type RecoveryTriggerPort,
} from '../platform/chrome/register-background';
import { CodexProvider } from '../providers/codex/codex-provider';
import type { IdGenerator, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import { RecoveryScanner } from '../tasks/recovery-scanner';
import { TaskCommandService } from '../tasks/task-command-service';
import { TaskCoordinator } from '../tasks/task-coordinator';
import { PanelService } from '../tasks/panel-service';
import { ScreenshotController } from '../tasks/screenshot-controller';
import { SelectionController } from '../tasks/selection-controller';

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
  const repository = new IndexedDbTaskRepository(database);
  const conversations = new IndexedDbConversationRepository(database);
  const attachments = new IndexedDbAttachmentRepository(database);
  const attachmentService = new AttachmentService(attachments, {
    clock: systemClock,
    ids: cryptoIds,
  });
  const settings = new ChromeSettingsStore();
  const commands = new TaskCommandService(repository, systemClock, cryptoIds);
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
  const planner = new CodexAgentPlanner({
    provider: codex,
    settings,
    conversations,
    attachments,
    ids: cryptoIds,
    clock: systemClock,
  });
  const executor = new TaskExecutor({
    repository,
    planner,
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
    commands,
    tabs: chrome.tabs,
    permissions: {
      contains: (permissions) => chrome.permissions.contains({ origins: [...permissions.origins] }),
    },
    clock: systemClock,
    ids: cryptoIds,
    scheduleTask,
  });
  const recovery = new RecoveryScanner({
    repository,
    clock: systemClock,
    startTask: scheduleTask,
  });
  const selection = new SelectionController({
    provider: codex,
    settings,
    panel,
    sidePanel: chrome.sidePanel,
  });
  const router = createMessageRouter({
    commands: {
      create: (input) => commands.create(input),
      getSnapshot: (taskId) => commands.getSnapshot(taskId),
      pause: (taskId) => coordinator.pause(taskId),
      resume: (taskId) => coordinator.resume(taskId),
      cancel: (taskId) => coordinator.cancel(taskId),
    },
    panel,
    screenshots,
    requestRecoveryScan: () => recovery.requestRecoveryScan(),
    scheduleTask,
    pageFeatures: {
      /** Installs only the isolated page feature bundle after optional origin access exists. */
      async ensure(tabId) {
        const tab = await chrome.tabs.get(tabId);
        return installer.ensureInstalled(tabId, tab.url ?? '');
      },
    },
    selection,
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
