import { defineManifest } from '@crxjs/vite-plugin';

export const manifest = {
  manifest_version: 3 as const,
  minimum_chrome_version: '125',
  name: 'ChatBrowserX',
  description: 'A durable Codex chat client in Chrome Side Panel.',
  version: '0.1.0',
  permissions: ['activeTab', 'alarms', 'scripting', 'sidePanel', 'storage', 'tabs'],
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
  },
};

export default defineManifest(manifest);
