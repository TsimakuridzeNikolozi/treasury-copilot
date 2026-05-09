import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Web tests run with mocked Privy / turnkey-admin / etc. The route tests
// hit a real Postgres test DB via @tc/db's globalSetup so the
// session-scoped advisory locks in /api/me/bootstrap actually fire.
//
// Set SKIP_ENV_VALIDATION before any module load so apps/web/src/env.ts
// doesn't try to parse a populated .env.local. With it set, the env
// helper passes process.env through unchanged.
process.env.SKIP_ENV_VALIDATION = '1';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    // The bootstrap concurrency test exercises real pg_advisory_lock
    // contention against the shared treasury_test database; running
    // multiple test files in parallel against the same DB would race on
    // table state. Match the pattern in @tc/agent-tools.
    fileParallelism: false,
    globalSetup: ['@tc/db/test/global-setup'],
    setupFiles: ['@tc/db/test/setup'],
  },
});
