import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/entries/page-content.iife.ts?script', () => ({
  default: 'assets/page-content.js',
}));

import {
  ContentScriptInstaller,
  type ContentScriptInstallerDependencies,
} from '../../../src/platform/chrome/content-script-installer';

/**
 * Builds inspectable Chrome ports for dynamic content-script installation tests.
 */
function buildDependencies(): ContentScriptInstallerDependencies {
  return {
    permissions: {
      contains: vi.fn(async () => true),
    },
    tabs: {
      sendMessage: vi.fn(async (_tabId, message) => ({
        version: 1,
        requestId: message.requestId,
        ok: true,
        data: { installed: true },
      })),
    },
    scripting: {
      executeScript: vi.fn(async () => undefined),
    },
    scriptFile: 'assets/page-content.js',
  };
}

describe('ContentScriptInstaller', () => {
  it('returns permission_required without pinging or injecting an origin', async () => {
    const dependencies = buildDependencies();
    vi.mocked(dependencies.permissions.contains).mockResolvedValue(false);
    const installer = new ContentScriptInstaller(dependencies);

    await expect(installer.ensureInstalled(7, 'https://example.test')).resolves.toEqual({
      status: 'permission_required',
      originPattern: 'https://example.test/*',
    });
    expect(dependencies.tabs.sendMessage).not.toHaveBeenCalled();
    expect(dependencies.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('reuses a responsive page bundle without injecting a duplicate', async () => {
    const dependencies = buildDependencies();
    const installer = new ContentScriptInstaller(dependencies);

    await expect(installer.ensureInstalled(7, 'https://example.test/path')).resolves.toEqual({
      status: 'already_installed',
      originPattern: 'https://example.test/*',
    });
    expect(dependencies.permissions.contains).toHaveBeenCalledWith({
      origins: ['https://example.test/*'],
    });
    expect(dependencies.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('injects the standalone bundle into all frames after an unanswered ping', async () => {
    const dependencies = buildDependencies();
    vi.mocked(dependencies.tabs.sendMessage).mockRejectedValue(new Error('No receiver'));
    const installer = new ContentScriptInstaller(dependencies);

    await expect(installer.ensureInstalled(7, 'https://example.test')).resolves.toEqual({
      status: 'installed',
      originPattern: 'https://example.test/*',
    });
    expect(dependencies.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, allFrames: true },
      files: ['assets/page-content.js'],
    });
  });

  it('rejects unsupported browser origins without checking permissions', async () => {
    const dependencies = buildDependencies();
    const installer = new ContentScriptInstaller(dependencies);

    await expect(installer.ensureInstalled(7, 'chrome://settings')).resolves.toEqual({
      status: 'unsupported_origin',
      originPattern: null,
    });
    expect(dependencies.permissions.contains).not.toHaveBeenCalled();
  });
});
