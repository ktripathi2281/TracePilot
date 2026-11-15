import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'eval/src/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    environment: 'node',
    // Simulator validity tests run full 15-minute scenarios several times.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
