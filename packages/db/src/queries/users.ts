import { eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../client';
import { type UserRow, users } from '../schema';

export interface BootstrapUserInput {
  privyDid: string;
  // Privy may not surface an email for every login method (SIWE etc.).
  // Stored when present; null otherwise. Not used as a join key — the
  // privy_did is the unique identifier.
  email: string | null;
}

// Lock-free upsert. Used by callers that already hold a session-scoped
// advisory lock (e.g., /api/me/bootstrap). Idempotent on privy_did.
// Updates last_seen_at on every call so a future quota / activity
// dashboard has fresh signal without needing a separate "touch" query.
export async function bootstrapUserCore(db: DbOrTx, input: BootstrapUserInput): Promise<UserRow> {
  const now = new Date();
  const [row] = await db
    .insert(users)
    .values({
      privyDid: input.privyDid,
      email: input.email,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: users.privyDid,
      set: {
        // Don't overwrite a stored email with null — we may have learned
        // the user's email from a prior login method but the current
        // session's claims happen to be email-less.
        ...(input.email ? { email: input.email } : {}),
        lastSeenAt: now,
      },
    })
    .returning();
  if (!row) throw new Error('bootstrapUserCore: upsert returned no row');
  return row;
}

// Top-level wrapper: takes a tx-scoped advisory lock on hashtext(privyDid)
// then delegates to bootstrapUserCore. Held only for the duration of THIS
// transaction (the user-row upsert), released the moment this function
// returns. The lock alone does NOT serialize a downstream "count
// memberships → provision Turnkey sub-org" decision against a duplicate-
// tab caller — that's why /api/me/bootstrap takes a session-scoped lock
// at the outer level and calls bootstrapUserCore directly to skip this
// inner lock (which would deadlock against the outer session lock if
// they sat on different connections).
export async function bootstrapUser(db: Db, input: BootstrapUserInput): Promise<UserRow> {
  return db.transaction(async (tx) => {
    // hashtext returns int4 — the int8 advisory lock takes one or two int4
    // keys. Single-key form is fine here; the namespace is unambiguous
    // (no other code path takes locks on hashtext(privyDid)).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.privyDid}))`);
    return bootstrapUserCore(tx, input);
  });
}

export async function getUserByPrivyDid(db: Db, privyDid: string): Promise<UserRow | null> {
  const row = await db.query.users.findFirst({ where: eq(users.privyDid, privyDid) });
  return row ?? null;
}

export async function getUserById(db: Db, id: string): Promise<UserRow | null> {
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  return row ?? null;
}
