// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { manifest } from '../manifest.config';

describe('extension manifest', () => {
  it('declares only the approved DOM-only MV3 permissions and entries', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.minimum_chrome_version).toBe('125');
    expect(manifest.permissions).toEqual([
      'activeTab',
      'alarms',
      'scripting',
      'sidePanel',
      'storage',
      'tabs',
    ]);
    expect(manifest).not.toHaveProperty('optional_host_permissions');
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(JSON.stringify(manifest)).not.toMatch(/debugger|offscreen|tabCapture|audio|speech|pdf/i);
  });
});
