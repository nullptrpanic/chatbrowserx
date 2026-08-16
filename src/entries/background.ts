import { AgentRunLoop } from '../agent/agent-run-loop';
import { BrowserExecutor } from '../agent/browser-executor';
import { CodexAgentPlanner } from '../agent/codex-agent-planner';
import { AttachmentService } from '../attachments/attachment-service';
import { cropCapturedImage } from '../attachments/crop-captured-image';
import { CdpActionDriver } from '../browser/act/cdp-action-driver';
import { DomActionDriver } from '../browser/act/dom-action-driver';
import { BrowserController } from '../browser/browser-controller';
import { CdpObserver } from '../browser/observe/cdp-observer';
import { ChromeDriverOutcomeRepository } from '../browser/route/driver-outcomes';
import { DriverRouter } from '../browser/route/driver-router';
import { DomConditionWaiter } from '../browser/verify/dom-condition-waiter';
import { NavigationWaiter } from '../browser/verify/navigation-waiter';
import { VerificationEngine } from '../browser/verify/verification-engine';
import { IndexedDbAttachmentRepository } from '../persistence/attachment-repository';
import { IndexedDbConversationRepository } from '../persistence/conversation-repository';
import { ChromeCredentialStore } from '../persistence/credential-store';
import { openChatBrowserDatabase } from '../persistence/open-database';
import { ChromeSettingsStore } from '../persistence/settings-store';
import { IndexedDbTaskRepository } from '../persistence/task-repository';
import { ContentScriptInstaller } from '../platform/chrome/content-script-installer';
import { captureVisibleTab } from '../platform/chrome/capture-visible-tab';
import { ChromeActionFeedbackPort } from '../platform/chrome/action-feedback-port';
import { ChromeDebuggerTransport } from '../platform/chrome/debugger-transport';
import { createMessageRouter, type MessageRouter } from '../platform/chrome/message-router';
import { ChromePageObservationSource } from '../platform/chrome/page-observation-source';
import { ChromeScreenshotPagePort } from '../platform/chrome/screenshot-page-port';
import {
  registerBackground,
  type BackgroundChromeApi,
  type RecoveryTriggerPort,
} from '../platform/chrome/register-background';
import { ChromeTabTracker, type ChromeTabTrackerApi } from '../platform/chrome/tab-tracker';
import { CodexProvider } from '../providers/codex/codex-provider';
import { TavilyClient } from '../providers/tavily/tavily-client';
import type { IdGenerator, TaskId } from '../shared/ids';
import type { Clock } from '../shared/time';
import { RecoveryScanner } from '../tasks/recovery-scanner';
import { TaskCommandService } from '../tasks/task-command-service';
import { TaskCoordinator } from '../tasks/task-coordinator';
import { PanelService } from '../tasks/panel-service';
import { ScreenshotController } from '../tasks/screenshot-controller';
import { SelectionController } from '../tasks/selection-controller';
import { ViewportVisualCapture } from '../agent/visual-fallback';

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
  const debuggerTransport = new ChromeDebuggerTransport();
  const installer = new ContentScriptInstaller();
  const pageObservations = new ChromePageObservationSource({
    installer,
    messages: {
      sendMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
    },
    clock: systemClock,
    ids: cryptoIds,
  });
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
  const visuals = new ViewportVisualCapture({
    page: screenshotPage,
    capture: (tabId) => captureVisibleTab(tabId),
  });
  const cdpObservations = new CdpObserver(debuggerTransport);
  const outcomes = new ChromeDriverOutcomeRepository();
  const browserTabs = {
    /** Reads the bounded tab identity used by browser observations. */
    async get(tabId: number): Promise<{ readonly url: string; readonly title: string }> {
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url ?? '', title: tab.title ?? '' };
    },
  };
  const browserRuntime: { current: BrowserController | undefined } = { current: undefined };
  const verifier = new VerificationEngine({
    observations: {
      /** Captures a fresh merged observation under a short-lived debugger owner. */
      async observe(tabId: number) {
        const activeBrowser = browserRuntime.current;
        if (activeBrowser === undefined) throw new Error('Browser runtime is unavailable.');
        const ownerId = cryptoIds.create('verification');
        try {
          return await activeBrowser.observe({ tabId, ownerId });
        } finally {
          await activeBrowser.release(tabId, ownerId).catch(() => undefined);
        }
      },
    },
    tabs: {
      /** Reads the current URL without retaining the Chrome tab payload. */
      async getUrl(tabId: number): Promise<string> {
        return (await chrome.tabs.get(tabId)).url ?? '';
      },
      /** Lists only fields permitted to influence new-tab verification. */
      async list() {
        return (await chrome.tabs.query({})).flatMap((tab) =>
          tab.id === undefined
            ? []
            : [{ id: tab.id, openerTabId: tab.openerTabId ?? null, url: tab.url ?? '' }],
        );
      },
    },
    waiter: new DomConditionWaiter(),
    navigation: new NavigationWaiter(debuggerTransport, systemClock),
    clock: systemClock,
  });
  const browser = new BrowserController({
    tabs: browserTabs,
    domObserver: pageObservations,
    cdpObserver: cdpObservations,
    debugger: debuggerTransport,
    drivers: {
      dom: new DomActionDriver(),
      cdp: new CdpActionDriver(debuggerTransport, {
        clock: systemClock,
        feedback: new ChromeActionFeedbackPort(),
        tabs: {
          getUrl: async (tabId) => (await chrome.tabs.get(tabId)).url ?? '',
        },
      }),
    },
    router: new DriverRouter(outcomes),
    outcomes,
    verifier,
    clock: systemClock,
  });
  browserRuntime.current = browser;
  const tabs = new ChromeTabTracker(chrome.tabs as unknown as ChromeTabTrackerApi, systemClock);
  const codex = new CodexProvider(credentials);
  const planner = new AgentRunLoop(
    new CodexAgentPlanner({
      provider: codex,
      settings,
      conversations,
      attachments,
      ids: cryptoIds,
      clock: systemClock,
    }),
  );
  const executor = new BrowserExecutor({
    repository,
    planner,
    browser,
    tavily: new TavilyClient(credentials),
    tabs,
    visuals,
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
    debugger: debuggerTransport,
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
      resume: (taskId, tabId) => coordinator.resume(taskId, tabId),
      confirm: (taskId, actionDigest) => coordinator.confirm(taskId, actionDigest),
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
