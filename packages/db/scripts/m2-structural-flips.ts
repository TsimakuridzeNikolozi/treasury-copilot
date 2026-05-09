// Migration B equivalent — extracted into a helper so the seed script
// (db:seed-m2) and the test global-setup can both invoke the same
// idempotent flip sequence after Migration A applies.
//
// Why this isn't a regular drizzle migration: drizzle-orm's migrator
// wraps all pending migrations in a single transaction, so a NOT NULL
// flip on `proposed_actions.treasury_id` would roll back Migration A
// in the same atomic unit if any pre-M2 row still has NULL treasury_id.
// Running this AFTER backfill (or on an empty DB) sidesteps that and
// keeps the operator flow recoverable: migrate → seed/backfill → flips.
//
// Idempotent end-to-end: every step guards on "already applied" state.
//
// Fragility: the policies-PK swap below uses `DROP CONSTRAINT IF EXISTS
// policies_pkey` followed by `ADD CONSTRAINT policies_pkey PRIMARY KEY
// (treasury_id)`. If a future migration adds a different PK to policies
// before every operator has run db:seed-m2, the IF EXISTS would silently
// drop that PK and reinstate the legacy shape.
// TODO(2-PR4): once every deployment has run db:seed-m2 and the
// post-flip schema is universal, retire this helper, drop the
// idempotency guards, and capture the final shape in a regular Drizzle
// migration that runs against the post-seed schema. The seed script's
// step 7 should then become a no-op assertion.

import { sql } from 'drizzle-orm';

// biome-ignore lint/suspicious/noExplicitAny: takes a drizzle Db or tx
export async function applyM2StructuralFlips(db: any): Promise<void> {
  await db.transaction(async (tx: any) => {
    // policies: drop singleton CHECK, drop id PK, promote treasury_id PK,
    // drop legacy id column.
    await tx.execute(sql`ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_singleton`);
    await tx.execute(sql`ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_pkey`);

    if (await columnExists(tx, 'policies', 'treasury_id')) {
      await tx.execute(sql`ALTER TABLE policies ALTER COLUMN treasury_id SET NOT NULL`);
    }

    // ADD PRIMARY KEY only if no PK exists (we just dropped it).
    if (!(await primaryKeyExists(tx, 'policies'))) {
      await tx.execute(
        sql`ALTER TABLE policies ADD CONSTRAINT policies_pkey PRIMARY KEY (treasury_id)`,
      );
    }

    if (await columnExists(tx, 'policies', 'id')) {
      await tx.execute(sql`ALTER TABLE policies DROP COLUMN id`);
    }

    // proposed_actions / approvals: NOT NULL flips. SET NOT NULL is a
    // no-op if already NOT NULL.
    await tx.execute(sql`ALTER TABLE proposed_actions ALTER COLUMN treasury_id SET NOT NULL`);
    await tx.execute(sql`ALTER TABLE approvals ALTER COLUMN treasury_id SET NOT NULL`);
  });
}

// biome-ignore lint/suspicious/noExplicitAny: takes a drizzle Db or tx
async function columnExists(db: any, table: string, column: string): Promise<boolean> {
  const rows = await db.execute(
    sql`SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`,
  );
  return rows.length > 0;
}

// biome-ignore lint/suspicious/noExplicitAny: takes a drizzle Db or tx
async function primaryKeyExists(db: any, table: string): Promise<boolean> {
  const rows = await db.execute(
    sql`SELECT 1 FROM information_schema.table_constraints
        WHERE table_schema = 'public' AND table_name = ${table} AND constraint_type = 'PRIMARY KEY'`,
  );
  return rows.length > 0;
}
