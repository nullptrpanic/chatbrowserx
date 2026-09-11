import { test as base } from '@playwright/test';
import { createExtensionSession, type ExtensionSession } from './extension-context';

export const extensionTest = base.extend<{
  readonly extensionSession: ExtensionSession;
  readonly extensionHeadless: boolean;
}>({
  extensionHeadless: [false, { option: true }],
  extensionSession: async ({ extensionHeadless }, use) => {
    const session = await createExtensionSession(extensionHeadless);
    try {
      await use(session);
    } finally {
      await session.close();
    }
  },
});

export { expect } from '@playwright/test';
