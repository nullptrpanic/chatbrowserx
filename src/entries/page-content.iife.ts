import { handlePageCommand } from '../page/browser-command-handler';
import { mountSelectionFeature } from '../page/selection/mount-selection-feature';

interface PageContentGlobal {
  __chatBrowserXPageCommandsV1__?: boolean;
}

const pageGlobal = globalThis as PageContentGlobal;

if (pageGlobal.__chatBrowserXPageCommandsV1__ !== true) {
  pageGlobal.__chatBrowserXPageCommandsV1__ = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    void handlePageCommand(message).then(sendResponse);
    return true;
  });
  mountSelectionFeature();
}
