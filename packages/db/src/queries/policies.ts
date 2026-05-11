import { DEFAULT_POLICY, type Policy } from '@tc/policy';
import type { Venue } from '@tc/types';
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLogs, policies } from '../schema';

// Defense-in-depth: only the venues with real deposit/withdraw builders
// in @tc/protocols are accepted. The PATCH validator enforces this on
// writes, but a stray DB row (manual SQL, a migration mishap, an attacker
// with raw DB access) could plant 'drift' or 'marginfi' here. If we
// forwarded those to evaluate(), the policy engine would happily allow a
// 'drift' proposal and the worker would crash at execution time because
// no builder exists.
//
// Tighter than the type's enum: VenueSchema (in @tc/types) keeps all
// venues for forward compatibility — we re-narrow at this DB boundary.
const ALLOWED_VENUES: readonly Venue[] = ['kamino', 'save', 'jupiter'];

// Runtime narrow row strings → Venue[]. We don't `as Venue[]` because a
// stray DB row containing 'drift' (etc.) must not silently slip past the
// type system into evaluate(). If a foreign value sneaks in, drop it from
// the result and log loud — better to under-allow venues than to lie
// about the type.
function narrowVenues(raw: readonly string[]): Venue[] {
  const out: Venue[] = [];
  for (const v of raw) {
    if (ALLOWED_VENUES.includes(v as Venue)) {
      out.push(v as Venue);
    } else {
      console.warn(`[policies] dropping unrecognised venue '${v}' from DB row`);
    }
  }
  return out;
}

// Reads the policy for a treasury. Falls back to the in-source DEFAULT_POLICY
// when the row is missing — fresh treasuries (just provisioned) and unedited
// ones both work without throwing. The first PATCH /api/policy creates the
// row.
//
// M2 keys per-treasury. M1 took no arg and read the singleton id='default'
// row; the schema migration drops that column, so all callers must pass a
// treasury id now. PR 1 callers thread `SEED_TREASURY_ID` from env until
// PR 2 ships membership-aware lookup; PR 2+ callers pass the active
// treasury id from getActiveTreasuryAndRole.
export async function getPolicy(db: Db, treasuryId: string): Promise<Policy> {
  const row = await db.query.policies.findFirst({ where: eq(policies.treasuryId, treasuryId) });
  if (!row) return DEFAULT_POLICY;
  return {
    requireApprovalAboveUsdc: row.requireApprovalAboveUsdc,
    maxSingleActionUsdc: row.maxSingleActionUsdc,
    maxSingleTransferUsdc: row.maxSingleTransferUsdc,
    maxAutoApprovedUsdcPer24h: row.maxAutoApprovedUsdcPer24h,
    allowedVenues: narrowVenues(row.allowedVenues),
  };
}

export interface PolicyMeta {
  updatedAt: Date | null;
  updatedBy: string | null;
}

// Companion read for surfacing "last updated by/at" in the editor UI without
// changing the Policy contract that policy.evaluate() consumes. Returns nulls
// when the row is missing (fresh treasury) so the UI can render "never edited".
export async function getPolicyMeta(db: Db, treasuryId: string): Promise<PolicyMeta> {
  const row = await db.query.policies.findFirst({ where: eq(policies.treasuryId, treasuryId) });
  if (!row) return { updatedAt: null, updatedBy: null };
  return { updatedAt: row.updatedAt ?? null, updatedBy: row.updatedBy ?? null };
}

export interface UpsertPolicyInput {
  treasuryId: string;
  policy: Policy;
  // Privy DID of the editor — written to audit_logs.actor.
  updatedBy: string;
}

// Atomic update + audit. If the audit insert fails (constraint, disk),
// the policy row write rolls back — operators always see a coherent
// audit_logs trail next to their policy state.
//
// The audit row carries treasury_id directly so the M3 history page can
// scope rows per-treasury without joining through proposed_actions.
export async function upsertPolicy(db: Db, input: UpsertPolicyInput): Promise<void> {
  // One timestamp for the whole operation — the insert path and the
  // onConflictDoUpdate path are mutually exclusive at runtime, but reusing
  // a single `now` makes intent explicit (this is a single edit, not two)
  // and keeps the value consistent if more fields ever take a timestamp.
  const now = new Date();
  await db.transaction(async (tx) => {
    const before = await tx.query.policies.findFirst({
      where: eq(policies.treasuryId, input.treasuryId),
    });

    await tx
      .insert(policies)
      .values({
        treasuryId: input.treasuryId,
        requireApprovalAboveUsdc: input.policy.requireApprovalAboveUsdc,
        maxSingleActionUsdc: input.policy.maxSingleActionUsdc,
        maxSingleTransferUsdc: input.policy.maxSingleTransferUsdc,
        maxAutoApprovedUsdcPer24h: input.policy.maxAutoApprovedUsdcPer24h,
        allowedVenues: input.policy.allowedVenues as Venue[],
        updatedBy: input.updatedBy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: policies.treasuryId,
        set: {
          requireApprovalAboveUsdc: input.policy.requireApprovalAboveUsdc,
          maxSingleActionUsdc: input.policy.maxSingleActionUsdc,
          maxSingleTransferUsdc: input.policy.maxSingleTransferUsdc,
          maxAutoApprovedUsdcPer24h: input.policy.maxAutoApprovedUsdcPer24h,
          allowedVenues: input.policy.allowedVenues as Venue[],
          updatedBy: input.updatedBy,
          updatedAt: now,
        },
      });

    await tx.insert(auditLogs).values({
      kind: 'policy_updated',
      treasuryId: input.treasuryId,
      actor: input.updatedBy,
      payload: {
        before: before
          ? {
              requireApprovalAboveUsdc: before.requireApprovalAboveUsdc,
              maxSingleActionUsdc: before.maxSingleActionUsdc,
              maxSingleTransferUsdc: before.maxSingleTransferUsdc,
              maxAutoApprovedUsdcPer24h: before.maxAutoApprovedUsdcPer24h,
              allowedVenues: before.allowedVenues,
            }
          : null,
        after: input.policy,
      },
    });
  });
}
