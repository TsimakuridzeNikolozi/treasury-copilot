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
  if (!dbName) {
    // Don't include the URL itself — it carries `user:password@host` and
    // would leak credentials into stderr / CI logs.
    throw new Error(
      `TEST_DATABASE_URL is missing a database name (host: ${url.host || 'unknown'})`,
    );
  }

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
      // The TRUNCATE + structural flips below are one-shot setup, not
      // per-run cleanup. Once the flips have been applied (signal: the
      // legacy `policies.id` column is gone), a second package's
      // globalSetup running while the first package's tests are mid-run
      // would otherwise wipe rows the running tests depend on. Skip both
      // steps in that case — the flips are idempotent so re-running is
      // technically safe, but the TRUNCATE is the destructive part.
      const flipsAlreadyApplied = await policiesIdDropped(migrationClient);
      if (!flipsAlreadyApplied) {
        // Pre-existing M1 rows would block the NOT NULL flip on
        // proposed_actions.treasury_id since they were written before
        // the column existed. Tests don't care about historical M1 data
        // (every suite's beforeEach truncates anyway), so we wipe the
        // tables here to let the flips apply on a clean slate. Only
        // happens on the very first package to win the lock — once the
        // flips run, the column is gone and we skip this branch forever.
        await migrationClient`TRUNCATE TABLE audit_logs, approvals, proposed_actions, policies CASCADE`;
        // Migration B equivalent — see scripts/m2-structural-flips.ts.
        await applyM2StructuralFlips(db);
      }
    } finally {
      await migrationClient`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await migrationClient.end();
  }
}

// Sentinel for "M2 structural flips already ran": the legacy `policies.id`
// column is dropped by applyM2StructuralFlips and never re-added.
async function policiesIdDropped(client: postgres.Sql): Promise<boolean> {
  const rows = await client`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'policies' AND column_name = 'id'
  `;
  return rows.length === 0;
}

const MIGRATION_LOCK_KEY = 8527431902;
