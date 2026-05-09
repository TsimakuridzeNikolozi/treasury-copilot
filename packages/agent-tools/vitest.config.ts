import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ['@tc/db/test/global-setup'],
    setupFiles: ['@tc/db/test/setup'],
  },
});
