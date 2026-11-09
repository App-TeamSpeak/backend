import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    include: ['src/integration/users.integration.ts'],
    setupFiles: ['src/integration/setup.integration.ts'],
    fileParallelism: false,
    sequence: { shuffle: true, seed: 42 },
    testTimeout: 60000,
    hookTimeout: 30000,
    passWithNoTests: false,
  },
});
