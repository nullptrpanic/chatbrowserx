import type { Translator } from '../../shared/i18n/i18n';
import type { MessageKey } from '../../shared/i18n/messages.zh-CN';

const reviewedToolKeys: Readonly<Record<string, MessageKey>> = {
  tavily_search: 'tavilyToolSearch',
  tavily_extract: 'tavilyToolExtract',
  tavily_crawl: 'tavilyToolCrawl',
  browser_get_current_tab: 'browserToolGetCurrentTab',
  browser_list_tabs: 'browserToolListTabs',
  browser_open_tab: 'browserToolOpenTab',
  browser_switch_tab: 'browserToolSwitchTab',
  browser_close_tab: 'browserToolCloseTab',
  browser_navigate: 'browserToolNavigate',
  browser_reload: 'browserToolReload',
  browser_inspect: 'browserToolInspect',
  browser_click: 'browserToolClick',
  browser_set_checked: 'browserToolSetChecked',
  browser_type: 'browserToolType',
  browser_keypress: 'browserToolKeypress',
  browser_scroll: 'browserToolScroll',
  browser_hover: 'browserToolHover',
  browser_select: 'browserToolSelect',
  browser_drag: 'browserToolDrag',
  browser_wait: 'browserToolWait',
  browser_click_point: 'browserToolClickPoint',
  browser_drag_point: 'browserToolDragPoint',
  browser_network_start: 'browserToolNetworkStart',
  browser_network_list: 'browserToolNetworkList',
  browser_network_get: 'browserToolNetworkGet',
  browser_network_stop: 'browserToolNetworkStop',
  commit_context: 'contextCommitTool',
};

/** Maps reviewed tool wire names to compact localized UI labels. */
export function toolDisplayName(toolName: string, t: Translator): string {
  const key = reviewedToolKeys[toolName];
  return key === undefined ? toolName : t(key);
}

/** Creates one localized completion label for every persisted tool result. */
export function toolResultEventLabel(toolName: string, t: Translator): string {
  if (toolName === 'commit_context') return t('contextCommitResultRecorded');
  return t('browserToolResultRecorded', { tool: toolDisplayName(toolName, t) });
}
