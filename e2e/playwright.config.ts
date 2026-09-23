import { defineConfig } from '@playwright/test';

const translationSpecs = ['**/translation-*.spec.ts', '**/region-translation.spec.ts'];

export default defineConfig<{ extensionHeadless: boolean }>({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 2,
  projects: [
    // Headed tests share the desktop's foreground window; never overlap them.
    { name: 'foreground', testIgnore: translationSpecs, workers: 1 },
    {
      name: 'translation',
      testMatch: translationSpecs,
      dependencies: ['foreground'],
      use: { extensionHeadless: true },
    },
  ],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: '.runtime/playwright/report', open: 'never' }]],
  outputDir: '.runtime/playwright/results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
