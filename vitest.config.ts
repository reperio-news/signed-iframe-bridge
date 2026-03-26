import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environmentMatchGlobs: [
      // Only integration tests need jsdom for postMessage
      ['test/integration.test.ts', 'jsdom'],
    ],
  },
});
