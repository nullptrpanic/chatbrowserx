import { expect, it, vi } from 'vitest';
import { registerSelectionTranslationMenu } from '../../../src/platform/chrome/selection-translation-menu';

it('registers a selection-only Chrome menu and opens the selected text in its frame', async () => {
  const create = vi.fn<typeof chrome.contextMenus.create>();
  const onInstalled = { addListener: vi.fn<(listener: () => void) => void>() };
  const onClicked = {
    addListener:
      vi.fn<
        (listener: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void) => void
      >(),
  };
  const open = vi.fn(async () => {});
  registerSelectionTranslationMenu({
    contextMenus: { create, onClicked },
    runtime: { onInstalled },
    language: 'zh-CN',
    open,
  });
  const install = onInstalled.addListener.mock.calls[0]?.[0];
  const click = onClicked.addListener.mock.calls[0]?.[0];
  if (!install || !click) throw new Error('Missing Chrome listeners');
  install();
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'translate-selection',
      title: '翻译选中文本',
      contexts: ['selection'],
    }),
    expect.any(Function),
  );
  const tab = { id: 7, active: true, url: 'https://example.test/' } as chrome.tabs.Tab;
  const event = {
    menuItemId: 'translate-selection',
    editable: false,
    frameId: 3,
    frameUrl: 'https://frame.test/',
    pageUrl: 'https://example.test/',
    selectionText: 'Selected sentence.',
  } satisfies chrome.contextMenus.OnClickData;
  click({ ...event, menuItemId: 'another-item' }, tab);
  click({ ...event, selectionText: '  ' }, tab);
  expect(open).not.toHaveBeenCalled();
  click(event, tab);
  expect(open).toHaveBeenCalledExactlyOnceWith(7, 3, {
    url: 'https://frame.test/',
    text: 'Selected sentence.',
  });
});
