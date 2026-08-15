import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    restoreMocks: true,
    maxWorkers: 4,
    testTimeout: 10_000,
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
});
