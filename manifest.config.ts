import { defineManifest } from '@crxjs/vite-plugin';

const icons = {
  16: 'icons/chatbrowserx-16.png',
  32: 'icons/chatbrowserx-32.png',
  48: 'icons/chatbrowserx-48.png',
  128: 'icons/chatbrowserx-128.png',
} as const;

export const manifest = {
  manifest_version: 3 as const,
  minimum_chrome_version: '125',
  name: 'ChatBrowserX',
  description: 'A durable Codex chat client in Chrome Side Panel.',
  version: '0.1.0',
  icons,
  permissions: ['activeTab', 'alarms', 'debugger', 'scripting', 'sidePanel', 'storage', 'tabs'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/entries/background.ts',
    type: 'module' as const,
  },
  side_panel: {
    default_path: 'src/entries/side-panel/index.html',
  },
  action: {
    default_title: 'Open ChatBrowserX',
    default_icon: icons,
  },
};

export default defineManifest(manifest);
