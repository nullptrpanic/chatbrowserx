import { handlePageCommand } from '../page/browser-command-handler';

interface PageContentGlobal {
  __chatBrowserXPageCommandsV1__?:
    | boolean
    | {
        readonly listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
        /** Removes listeners installed by builds that included selected-text actions. */
        readonly disposeSelection?: (() => void) | undefined;
      };
}

const pageGlobal = globalThis as PageContentGlobal;
const previous = pageGlobal.__chatBrowserXPageCommandsV1__;

if (typeof previous === 'object') {
  try {
    chrome.runtime.onMessage.removeListener(previous.listener);
  } catch {
    // A listener from the previous extension context may already be detached.
  }
  try {
    previous.disposeSelection?.();
  } catch {
    // Reinstallation must continue even if the previous context can no longer clean itself up.
  }
}

// Remove a host left by an older injected build, including the legacy boolean-guard build.
for (const overlay of document.querySelectorAll('[data-chatbrowserx-overlay="selection"]')) {
  overlay.remove();
}

const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
  message,
  _sender,
  sendResponse,
) => {
  void handlePageCommand(message).then(sendResponse);
  return true;
};
chrome.runtime.onMessage.addListener(listener);
pageGlobal.__chatBrowserXPageCommandsV1__ = {
  listener,
};
