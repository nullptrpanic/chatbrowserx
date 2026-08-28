import { test as base } from '@playwright/test';
import { createExtensionSession, type ExtensionSession } from './extension-context';

export const extensionTest = base.extend<{
  readonly extensionSession: ExtensionSession;
}>({
  extensionSession: async ({ browserName }, use) => {
    void browserName;
    const session = await createExtensionSession();
    try {
      await use(session);
    } finally {
      await session.close();
    }
  },
});

export { expect } from '@playwright/test';
