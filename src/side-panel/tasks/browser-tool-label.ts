import type { Translator } from '../../shared/i18n/i18n';
import type { MessageKey } from '../../shared/i18n/messages.zh-CN';

const browserToolKeys: Readonly<Record<string, MessageKey>> = {
  browser_list_tabs: 'browserToolListTabs',
  browser_open_tab: 'browserToolOpenTab',
  browser_switch_tab: 'browserToolSwitchTab',
  browser_close_tab: 'browserToolCloseTab',
  browser_navigate: 'browserToolNavigate',
  browser_reload: 'browserToolReload',
  browser_inspect: 'browserToolInspect',
  browser_click: 'browserToolClick',
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
};

/** Maps reviewed browser tool wire names to compact localized UI labels. */
export function toolDisplayName(toolName: string, t: Translator): string {
  const key = browserToolKeys[toolName];
  return key === undefined ? toolName : t(key);
}

/** Keeps Tavily's existing search wording while making browser result events action-specific. */
export function toolResultEventLabel(toolName: string, t: Translator): string {
  return toolName.startsWith('browser_')
    ? t('browserToolResultRecorded', { tool: toolDisplayName(toolName, t) })
    : t('taskToolResultRecorded');
}
