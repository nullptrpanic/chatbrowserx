import { test as base } from '@playwright/test';
import { createExtensionSession, type ExtensionSession } from './extension-context';

export const extensionTest = base.extend<{
  readonly extensionSession: ExtensionSession;
  readonly extensionHeadless: boolean;
  readonly extensionBrowserArgs: readonly string[];
}>({
  extensionHeadless: [false, { option: true }],
  extensionBrowserArgs: [[], { option: true }],
  extensionSession: async ({ extensionHeadless, extensionBrowserArgs }, use) => {
    const session = await createExtensionSession(extensionHeadless, extensionBrowserArgs);
    try {
      await use(session);
    } finally {
      await session.close();
    }
  },
});

export { expect } from '@playwright/test';
