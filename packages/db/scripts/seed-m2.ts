// M2 seed-and-backfill script. Runs ONCE after Migration A (creates the
// new tables + nullable treasury_id columns) and is responsible for:
//   1) Inserting the seed treasuries row from env.
//   2) Backfilling every existing row's treasury_id (proposed_actions,
//      approvals, audit_logs, policies + the legacy jsonb payloads).
//   3) Applying the destructive structural flips (drop policies CHECK +
//      id PK, promote treasury_id PK, NOT NULL flips on
//      proposed_actions.treasury_id and approvals.treasury_id) — what
//      would have been Migration B in a normal Drizzle flow.
//
// Why this script does the structural flips instead of a Migration B:
// drizzle-orm/postgres-js/migrator wraps ALL pending migrations in a
// single transaction. If we shipped a Migration B that NOT NULL-flips
// treasury_id, the first `pnpm db:migrate` would fail (existing rows are
// still NULL) AND roll back Migration A in the same atomic unit — the
// operator would never have a working seed. Inlining the flips here
// runs them in their own transaction, after the backfill, and is fully
// idempotent (DROP CONSTRAINT IF EXISTS, conditional NOT NULL).
//
// Operator flow on M1 → M2 upgrade:
//   1) pnpm db:migrate     (applies 0006 — tables + nullable cols)
//   2) pnpm db:seed-m2     (this script — seed + backfill + structural flips)
//
// For fresh installs (no M1 data), step 2 is still required: the
// structural flips need to run, the seed treasury still has to exist
// for local-mode bootstrap to attach new dev users to it, and the
// script's backfills are no-ops (zero rows touched).
//
// Idempotent end-to-end: re-running the script is safe — every step
// guards on "already applied" state.
//
// Reads env vars directly (NOT through @tc/env's Zod schemas) so the
// script runs as a one-off without needing the full app's env wired up.
//
// Prints the seed treasury's wallet address at the end — operators
// fund that address. PR 4 dropped the SEED_TREASURY_ID env back-reference
// in favor of a runtime lookup on `signer_backend = 'local'` in the
// bootstrap path, so no copy-paste is required after seeding.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/schema';
import { applyM2StructuralFlips } from './m2-structural-flips';

// Auto-load env files so the operator doesn't have to remember which
// shell to source. Reads `apps/web/.env.local` first (where
// TREASURY_PUBKEY_BASE58 lives in this repo) then `apps/worker/.env`
// (where SIGNER_BACKEND, TURNKEY_*, TELEGRAM_* live). Already-set vars
// in the parent shell win — explicit overrides during testing still
// work.
function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined && value.length > 0) {
      process.env[key] = value;
    }
  }
}
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
loadEnvFile(resolve(repoRoot, 'apps/web/.env.local'));
loadEnvFile(resolve(repoRoot, 'apps/worker/.env'));

interface SeedEnv {
  databaseUrl: string;
  treasuryPubkey: string;
  turnkeyOrgId: string | null;
  signerBackend: 'local' | 'turnkey';
  telegramChatId: string | null;
  telegramApproverIds: string[];
  ownerPrivyDid: string | null;
}

function readEnv(): SeedEnv {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgresql://copilot:copilot@localhost:5432/treasury';
  const treasuryPubkey = process.env.TREASURY_PUBKEY_BASE58;
  if (!treasuryPubkey) {
    throw new Error('seed-m2: TREASURY_PUBKEY_BASE58 must be set');
  }
  const signerBackend = (process.env.SIGNER_BACKEND ?? 'local') as 'local' | 'turnkey';
  if (signerBackend !== 'local' && signerBackend !== 'turnkey') {
    throw new Error(`seed-m2: SIGNER_BACKEND must be 'local' or 'turnkey', got '${signerBackend}'`);
  }
  return {
    databaseUrl,
    treasuryPubkey,
    turnkeyOrgId: process.env.TURNKEY_ORGANIZATION_ID ?? null,
    signerBackend,
    telegramChatId: process.env.TELEGRAM_APPROVAL_CHAT_ID ?? null,
    telegramApproverIds: (process.env.APPROVER_TELEGRAM_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ownerPrivyDid: process.env.OWNER_PRIVY_DID ?? null,
  };
}

async function main() {
  const env = readEnv();
  const client = postgres(env.databaseUrl, { max: 2 });
  const db = drizzle(client, { schema });

  try {
    // 1. Insert (or fetch) the seed treasury. Wallet address is unique;
    //    that's the idempotency key.
    const existing = await db.query.treasuries.findFirst({
      where: (t, { eq }) => eq(t.walletAddress, env.treasuryPubkey),
    });

    let seedTreasuryId: string;
    if (existing) {
      seedTreasuryId = existing.id;
      console.log(`[seed-m2] Seed treasury already exists: ${seedTreasuryId}`);
    } else {
      const [row] = await db
        .insert(schema.treasuries)
        .values({
          name: 'Seed',
          walletAddress: env.treasuryPubkey,
          // For local-backend dev there's no Turnkey sub-org. Store a
          // sentinel so the column stays NOT NULL but the worker's local
          // path won't try to read it.
          turnkeySubOrgId: env.turnkeyOrgId ?? 'local-seed',
          // Nullable; the seed wallet's Turnkey internal UUID isn't in
          // env. PR 4's @tc/turnkey-admin will look it up if needed.
          turnkeyWalletId: null,
          signerBackend: env.signerBackend,
          telegramChatId: env.telegramChatId,
          telegramApproverIds: env.telegramApproverIds,
          createdBy: null,
        })
        .returning();
      if (!row) throw new Error('seed-m2: insert returned no row');
      seedTreasuryId = row.id;
      console.log(`[seed-m2] Created seed treasury: ${seedTreasuryId}`);
    }

    // 2. Optional: attach the M1 owner to the seed treasury as a member.
    //    Useful for dev so the UI immediately picks the seed in PR 2's
    //    switcher. The OWNER_PRIVY_DID env points at an existing user
    //    row; if absent we skip and the operator can attach manually.
    if (env.ownerPrivyDid) {
      await db.transaction(async (tx) => {
        const now = new Date();
        const [user] = await tx
          .insert(schema.users)
          .values({ privyDid: env.ownerPrivyDid as string, lastSeenAt: now })
          .onConflictDoUpdate({
            target: schema.users.privyDid,
            set: { lastSeenAt: now },
          })
          .returning();
        if (!user) throw new Error('seed-m2: user upsert returned no row');
        await tx
          .insert(schema.treasuryMemberships)
          .values({ treasuryId: seedTreasuryId, userId: user.id, role: 'owner' })
          .onConflictDoNothing({
            target: [schema.treasuryMemberships.treasuryId, schema.treasuryMemberships.userId],
          });
        console.log(`[seed-m2] Attached owner ${env.ownerPrivyDid} to seed treasury`);
      });
    }

    // 3. Backfill policies.treasury_id from the singleton id='default' row,
    //    if the legacy `id` column still exists (i.e., the structural
    //    flips below haven't run yet on a previous invocation). Otherwise
    //    we're already past M2 and there's nothing to backfill here.
    const idColumnExists = await columnExists(db, 'policies', 'id');
    if (idColumnExists) {
      await db.execute(
        sql`UPDATE policies
            SET treasury_id = ${seedTreasuryId}
            WHERE id = 'default' AND treasury_id IS NULL`,
      );
      console.log('[seed-m2] Backfilled policies.treasury_id from id=default');
    }

    // 4. Backfill proposed_actions.treasury_id (column + jsonb payload).
    await db.execute(
      sql`UPDATE proposed_actions
          SET treasury_id = ${seedTreasuryId}
          WHERE treasury_id IS NULL`,
    );
    console.log('[seed-m2] Backfilled proposed_actions.treasury_id');

    // jsonb_set the nested treasuryId into legacy payloads. Necessary so
    // ProposedActionSchema.parse() accepts the row going forward (the
    // executor and any future re-validation path will).
    await db.execute(
      sql`UPDATE proposed_actions
          SET payload = jsonb_set(payload, '{treasuryId}', to_jsonb(${seedTreasuryId}::text), true)
          WHERE NOT (payload ? 'treasuryId')`,
    );
    console.log('[seed-m2] Backfilled proposed_actions.payload.treasuryId for legacy rows');

    // policy_decision.action.treasuryId for allow decisions, same reason.
    // The decision is the signer's permission slip — its action must
    // round-trip through the schema cleanly.
    await db.execute(
      sql`UPDATE proposed_actions
          SET policy_decision = jsonb_set(
            policy_decision,
            '{action,treasuryId}',
            to_jsonb(${seedTreasuryId}::text),
            true
          )
          WHERE policy_decision IS NOT NULL
            AND policy_decision ->> 'kind' = 'allow'
            AND NOT (policy_decision -> 'action' ? 'treasuryId')`,
    );
    console.log('[seed-m2] Backfilled proposed_actions.policy_decision.action.treasuryId');

    // 5. Backfill approvals.treasury_id from the action's row.
    await db.execute(
      sql`UPDATE approvals
          SET treasury_id = pa.treasury_id
          FROM proposed_actions pa
          WHERE approvals.action_id = pa.id AND approvals.treasury_id IS NULL`,
    );
    console.log('[seed-m2] Backfilled approvals.treasury_id');

    // 6. Backfill audit_logs.treasury_id from the action's row. Action-less
    //    rows (e.g., system events) stay NULL — that's expected.
    await db.execute(
      sql`UPDATE audit_logs
          SET treasury_id = pa.treasury_id
          FROM proposed_actions pa
          WHERE audit_logs.action_id = pa.id
            AND audit_logs.treasury_id IS NULL`,
    );
    console.log('[seed-m2] Backfilled audit_logs.treasury_id');

    // 7. Apply the structural flips (Migration B equivalent). Idempotent
    //    and runs in its own transaction inside the helper.
    await applyM2StructuralFlips(db);
    console.log('[seed-m2] Applied structural flips (policies PK swap, NOT NULL flips)');

    // 8. Print the seed treasury wallet so the operator knows which
    //    address to fund. The treasury id is no longer needed by env
    //    (PR 4 swapped to runtime lookup on signer_backend='local').
    console.log('');
    console.log('========================================');
    console.log(`Seed treasury created: id=${seedTreasuryId}`);
    console.log(`Wallet (fund this address): ${env.treasuryPubkey}`);
    console.log('========================================');
  } finally {
    await client.end();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: takes a drizzle Db or tx
async function columnExists(db: any, table: string, column: string): Promise<boolean> {
  const rows = await db.execute(
    sql`SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}`,
  );
  return rows.length > 0;
}

main().catch((err) => {
  console.error('[seed-m2] failed:', err);
  process.exit(1);
});
