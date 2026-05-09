import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { type UserRow, users } from '../schema';

export interface BootstrapUserInput {
  privyDid: string;
  // Privy may not surface an email for every login method (SIWE etc.).
  // Stored when present; null otherwise. Not used as a join key — the
  // privy_did is the unique identifier.
  email: string | null;
}

// Idempotent upsert keyed on privy_did. Updates last_seen_at on every call
// so a future quota / activity dashboard has fresh signal without needing
// a separate "touch" query.
//
// Scope of the advisory lock: held only for the duration of THIS
// transaction (the user-row upsert). It is released the moment this
// function returns. The lock alone does NOT serialize the route
// handler's downstream "count memberships → provision Turnkey sub-org"
// decision against another bootstrap from the same DID — that step
// runs in a separate tx and would race a duplicate-tab caller.
//
// PR 2's bootstrap route must therefore either (a) take the lock in
// its outer transaction and pass `tx` into bootstrapUser instead of
// calling this top-level helper, or (b) accept the duplicate-Turnkey
// risk and rely on application-level idempotency (re-read membership
// count after Turnkey returns; if > 0, discard the new sub-org). (a)
// is preferred. This helper exists for callers that only need the
// user upsert (e.g., the strict-verify path before any membership
// branching).
export async function bootstrapUser(db: Db, input: BootstrapUserInput): Promise<UserRow> {
  return db.transaction(async (tx) => {
    // hashtext returns int4 — the int8 advisory lock takes one or two int4
    // keys. Single-key form is fine here; the namespace is unambiguous
    // (no other code path takes locks on hashtext(privyDid)).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.privyDid}))`);

    const now = new Date();
    const [row] = await tx
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
    if (!row) throw new Error('bootstrapUser: upsert returned no row');
    return row;
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
