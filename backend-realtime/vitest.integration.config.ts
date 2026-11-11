import { defineConfig } from 'vitest/config';
export default defineConfig({
  envDir: false,
  test: {
    include: ['src/integration/firebase.integration.ts'], setupFiles: ['src/integration/setup.integration.ts'],
    fileParallelism: false, sequence: { shuffle: true, seed: 42 },
    testTimeout: 15000, hookTimeout: 15000, passWithNoTests: false,
  },
});
