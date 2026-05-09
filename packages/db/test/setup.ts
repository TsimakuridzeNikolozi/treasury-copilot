import { TEST_DATABASE_URL } from './url';

// Forces every test worker to talk to the dedicated test DB instead of the
// dev DB the apps run against. Runs in each worker before test files load,
// so the top-level `postgres(process.env.DATABASE_URL)` calls in the test
// suites pick this up.
if (process.env.SKIP_DB_TESTS !== '1') {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}
