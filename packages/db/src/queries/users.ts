import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../client';
import { type UserRow, auditLogs, users } from '../schema';

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

export class InvalidOnboardingStep extends Error {
  constructor(step: number) {
    super(`onboarding_step must be in 1..5, got ${step}`);
    this.name = 'InvalidOnboardingStep';
  }
}

// Idempotent UPDATE. Marks where the user paused so refresh / cross-tab
// resume lands at the right step. No-op once `onboarded_at` is set —
// onboarded users should never be bounced back into the wizard.
export async function markUserOnboardingStep(
  db: DbOrTx,
  userId: string,
  step: number,
): Promise<void> {
  if (!Number.isInteger(step) || step < 1 || step > 5) {
    throw new InvalidOnboardingStep(step);
  }
  await db
    .update(users)
    .set({ onboardingStep: step })
    .where(and(eq(users.id, userId), isNull(users.onboardedAt)));
}

// Marks the user fully onboarded. Sets onboarded_at = NOW(), clears
// onboarding_step so a future schema audit can't see stale data, and
// writes an audit_logs row so a future history page can surface "user
// finished onboarding". Idempotent on repeat calls (no-op when
// onboarded_at is already set).
export async function markUserOnboarded(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ onboardedAt: sql`NOW()`, onboardingStep: null })
      .where(and(eq(users.id, userId), isNull(users.onboardedAt)))
      .returning({ id: users.id, privyDid: users.privyDid });
    if (!updated) return; // Already onboarded — idempotent no-op.
    await tx.insert(auditLogs).values({
      kind: 'user_onboarded',
      // No treasuryId on this kind — onboarding is user-scoped, not
      // treasury-scoped. Schema allows null treasury_id on audit_logs.
      treasuryId: null,
      actor: updated.privyDid,
      payload: { userId: updated.id },
    });
  });
}
