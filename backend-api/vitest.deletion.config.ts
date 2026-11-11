import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    include: ['src/integration/deletion.integration.ts'],
    setupFiles: ['src/integration/setup.integration.ts', 'src/integration/setup-deletion.integration.ts'],
    fileParallelism: false,
    sequence: { shuffle: true, seed: 42 },
    testTimeout: 60000, hookTimeout: 30000, passWithNoTests: false,
  },
});
