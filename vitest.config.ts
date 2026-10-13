import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Several suites dynamically import large module graphs; a timed-out test
    // keeps running and corrupts its neighbours, so the 5s default is too tight.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: ['src/**/*.test.ts'],
  },
});
