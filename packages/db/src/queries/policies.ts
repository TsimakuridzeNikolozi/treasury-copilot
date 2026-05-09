import { DEFAULT_POLICY, type Policy } from '@tc/policy';
import type { Venue } from '@tc/types';
import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { auditLogs, policies } from '../schema';

// Defense-in-depth: M1 only ships builders for kamino + save. The PATCH
// validator enforces this on writes, but a stray DB row (manual SQL, a
// migration mishap, an attacker with raw DB access) could plant 'drift'
// or 'marginfi' here. If we forwarded those to evaluate(), the policy
// engine would happily allow a 'drift' proposal and the worker would
// crash at execution time because no builder exists.
//
// Tighter than the type's enum: VenueSchema (in @tc/types) keeps all four
// for forward compatibility — we re-narrow at this DB boundary. M2 widens
// this back when the drift/marginfi builders land.
const ALLOWED_VENUES: readonly Venue[] = ['kamino', 'save'];

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

// The singleton policy row's primary key. M2 drops the singleton CHECK and
// switches the PK to `treasury_id`.
const POLICY_ID = 'default';

// Reads the singleton policy row. Falls back to the in-source DEFAULT_POLICY
// when the row is missing — fresh DBs and forgotten seeds both work without
// throwing. The first PATCH /api/policy creates the row.
export async function getPolicy(db: Db): Promise<Policy> {
  const row = await db.query.policies.findFirst({ where: eq(policies.id, POLICY_ID) });
  if (!row) return DEFAULT_POLICY;
  return {
    requireApprovalAboveUsdc: row.requireApprovalAboveUsdc,
    maxSingleActionUsdc: row.maxSingleActionUsdc,
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
// when the row is missing (fresh DB) so the UI can render "never edited".
export async function getPolicyMeta(db: Db): Promise<PolicyMeta> {
  const row = await db.query.policies.findFirst({ where: eq(policies.id, POLICY_ID) });
  if (!row) return { updatedAt: null, updatedBy: null };
  return { updatedAt: row.updatedAt ?? null, updatedBy: row.updatedBy ?? null };
}

export interface UpsertPolicyInput {
  policy: Policy;
  updatedBy: string;
}

// Atomic update + audit. If the audit insert fails (constraint, disk),
// the policy row write rolls back — operators always see a coherent
// audit_logs trail next to their policy state.
export async function upsertPolicy(db: Db, input: UpsertPolicyInput): Promise<void> {
  // One timestamp for the whole operation — the insert path and the
  // onConflictDoUpdate path are mutually exclusive at runtime, but reusing
  // a single `now` makes intent explicit (this is a single edit, not two)
  // and keeps the value consistent if more fields ever take a timestamp.
  const now = new Date();
  await db.transaction(async (tx) => {
    const before = await tx.query.policies.findFirst({ where: eq(policies.id, POLICY_ID) });

    await tx
      .insert(policies)
      .values({
        id: POLICY_ID,
        requireApprovalAboveUsdc: input.policy.requireApprovalAboveUsdc,
        maxSingleActionUsdc: input.policy.maxSingleActionUsdc,
        maxAutoApprovedUsdcPer24h: input.policy.maxAutoApprovedUsdcPer24h,
        allowedVenues: input.policy.allowedVenues as Venue[],
        updatedBy: input.updatedBy,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: policies.id,
        set: {
          requireApprovalAboveUsdc: input.policy.requireApprovalAboveUsdc,
          maxSingleActionUsdc: input.policy.maxSingleActionUsdc,
          maxAutoApprovedUsdcPer24h: input.policy.maxAutoApprovedUsdcPer24h,
          allowedVenues: input.policy.allowedVenues as Venue[],
          updatedBy: input.updatedBy,
          updatedAt: now,
        },
      });

    await tx.insert(auditLogs).values({
      kind: 'policy_updated',
      actor: input.updatedBy,
      payload: {
        before: before
          ? {
              requireApprovalAboveUsdc: before.requireApprovalAboveUsdc,
              maxSingleActionUsdc: before.maxSingleActionUsdc,
              maxAutoApprovedUsdcPer24h: before.maxAutoApprovedUsdcPer24h,
              allowedVenues: before.allowedVenues,
            }
          : null,
        after: input.policy,
      },
    });
  });
}
