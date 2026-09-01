import { describe, expect, it } from 'vitest';
import { discoverToolDeclarations } from '../../../src/tools/discover';

describe('built-in tool discovery', () => {
  it('discovers registered tools in stable order', async () => {
    const declarations = await discoverToolDeclarations();

    expect(declarations.map(({ name }) => name)).toEqual([
      'browser_get_current_tab',
      'browser_list_tabs',
      'browser_open_tab',
      'browser_switch_tab',
      'browser_close_tab',
      'browser_navigate',
      'browser_reload',
      'browser_inspect',
      'browser_capture_screenshot',
      'browser_paste_image',
      'browser_click',
      'browser_set_checked',
      'browser_set_checked_many',
      'browser_type',
      'browser_keypress',
      'browser_scroll',
      'browser_hover',
      'browser_select',
      'browser_drag',
      'browser_wait',
      'browser_click_point',
      'browser_drag_point',
      'browser_network_start',
      'browser_network_list',
      'browser_network_get',
      'browser_network_stop',
      'commit_context',
      'tavily_search',
      'tavily_extract',
      'tavily_crawl',
      'skill_loader',
      'sandbox_read',
      'sandbox_exec',
      'history_read',
      'history_detail_read',
      'result_read',
    ]);
    for (const { name, definition } of declarations) {
      expect(definition.name).toBe(name);
      expect(definition.strict).toBe(true);
    }
  });
});
