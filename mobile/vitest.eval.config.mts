import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['evals/**/*.eval.ts'],
    testTimeout: 900000,
    hookTimeout: 300000,
    fileParallelism: false,
  },
});
