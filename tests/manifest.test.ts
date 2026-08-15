// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { manifest } from '../manifest.config';

describe('extension manifest', () => {
  it('declares only the approved MV3 permissions and entries', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('125');
    expect(manifest.permissions).toEqual([
      'activeTab',
      'alarms',
      'debugger',
      'scripting',
      'sidePanel',
      'storage',
      'tabs',
    ]);
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
    expect(manifest.host_permissions).toEqual([
      'https://chatgpt.com/*',
      'https://api.tavily.com/*',
    ]);
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(JSON.stringify(manifest)).not.toMatch(/offscreen|tabCapture|audio|speech|pdf/i);
  });
});
