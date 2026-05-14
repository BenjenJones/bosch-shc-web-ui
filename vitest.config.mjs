import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{js,mjs}'],
    globalSetup: ['./test/setup.mjs'],
    testTimeout: 15000,
    hookTimeout: 30000,
    // Sequential — Prism is a single process bound to port 4010, parallel
    // tests would race on its single shared state.
    fileParallelism: false,
  },
});
