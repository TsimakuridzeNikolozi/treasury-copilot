import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { applyM2StructuralFlips } from '../scripts/m2-structural-flips';
import { TEST_DATABASE_URL } from './url';

// No teardown is registered: keeping treasury_test around between runs makes
// re-runs fast (the migrator is idempotent and a no-op on subsequent runs).
// Drop the database manually with `dropdb treasury_test` if you ever need a
// clean slate.
export default async function globalSetup() {
  if (process.env.SKIP_DB_TESTS === '1') return;

  const url = new URL(TEST_DATABASE_URL);
  const dbName = url.pathname.slice(1);
  if (!dbName)
    throw new Error(`TEST_DATABASE_URL is missing a database name: ${TEST_DATABASE_URL}`);

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    // Race-safe: when turbo runs multiple test packages in parallel, both hit
    // this codepath against the same server. We skip a "SELECT then CREATE"
    // (not atomic) and rely on Postgres for the loser:
    //   - 42P04 (duplicate_database) when the DB already fully exists.
    //   - 23505 (unique_violation on pg_database_datname_index) when two
    //     CREATEs collide mid-catalog-insert.
    // dbName is parsed from our own URL — safe to interpolate.
    try {
      await admin.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== '42P04' && code !== '23505') throw err;
    }
  } finally {
    await admin.end();
  }

  const migrationClient = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    // Serialize concurrent migrators (turbo running multiple test packages
    // in parallel against the same DB). Drizzle's migrator does
    // `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"` which
    // races on pg_type — `IF NOT EXISTS` does not protect against this.
    // Advisory locks are per-database; arbitrary key chosen to be unique
    // to this codebase.
    await migrationClient`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const db = drizzle(migrationClient);
      await migrate(db, {
        migrationsFolder: resolve(here, '../drizzle'),
      });
      // Test DB cleanup before the structural flips: any pre-existing
      // M1 rows would block the NOT NULL flip on
      // proposed_actions.treasury_id since they were written before the
      // column existed. Tests don't care about historical M1 data
      // (every suite's beforeEach truncates anyway), so we wipe the
      // tables here to let the flips apply on a clean slate.
      // Idempotent: TRUNCATE on already-empty tables is fine.
      await migrationClient`TRUNCATE TABLE audit_logs, approvals, proposed_actions, policies CASCADE`;
      // Migration B equivalent — see comment in scripts/m2-structural-flips.ts.
      // Idempotent so re-runs are safe.
      await applyM2StructuralFlips(db);
    } finally {
      await migrationClient`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await migrationClient.end();
  }
}

const MIGRATION_LOCK_KEY = 8527431902;
