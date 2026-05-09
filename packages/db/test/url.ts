// Single source of truth for the test database URL. Imported by global-setup,
// setup, and the test files themselves so the dev-DB fallback can never sneak
// back in.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://copilot:copilot@localhost:5432/treasury_test';
