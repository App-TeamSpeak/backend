import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/integration/**', 'src/**/*.test.ts', 'src/**/*.spec.ts', 'src/**/*.d.ts'],
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
    },
  },
});
