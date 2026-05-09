import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import {
  type TreasuryMembershipRow,
  type TreasuryRow,
  type UserRow,
  treasuries,
  treasuryMemberships,
  users,
} from '../schema';

export type Role = 'owner';

export interface AddMembershipInput {
  treasuryId: string;
  userId: string;
  role: Role;
}

export async function addMembership(
  db: Db,
  input: AddMembershipInput,
): Promise<TreasuryMembershipRow> {
  const [row] = await db
    .insert(treasuryMemberships)
    .values({
      treasuryId: input.treasuryId,
      userId: input.userId,
      role: input.role,
    })
    // Idempotent: re-attaching an already-member to the same treasury is a
    // no-op. The composite (treasury_id, user_id) PK enforces uniqueness;
    // ON CONFLICT DO NOTHING + a follow-up SELECT keeps the API single-call.
    .onConflictDoNothing({ target: [treasuryMemberships.treasuryId, treasuryMemberships.userId] })
    .returning();
  if (row) return row;

  const existing = await db.query.treasuryMemberships.findFirst({
    where: and(
      eq(treasuryMemberships.treasuryId, input.treasuryId),
      eq(treasuryMemberships.userId, input.userId),
    ),
  });
  if (!existing) throw new Error('addMembership: insert returned no row and no existing match');
  return existing;
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

// Strict membership check. Throws ForbiddenError when the user is not a
// member of the requested treasury — caller maps to a 403. Returns the
// role on success so callers can branch on owner-vs-other once M3 lifts
// the role CHECK and adds approver/viewer.
export async function requireMembership(
  db: Db,
  userId: string,
  treasuryId: string,
): Promise<{ role: Role }> {
  const [row] = await db
    .select({ role: treasuryMemberships.role })
    .from(treasuryMemberships)
    .where(
      and(eq(treasuryMemberships.userId, userId), eq(treasuryMemberships.treasuryId, treasuryId)),
    )
    .limit(1);
  if (!row) {
    throw new ForbiddenError(`user ${userId} is not a member of treasury ${treasuryId}`);
  }
  return { role: row.role as Role };
}

export interface ActiveTreasuryAndRole {
  user: UserRow;
  treasury: TreasuryRow;
  role: Role;
}

// Hot-path combined query for chat / policy / settings routes. Returns the
// user, the active treasury (validated as a membership), and the role —
// in one round-trip. The caller passes the cookie's claimed treasury_id;
// if the user isn't a member of it (or it's missing), the caller falls
// back to listTreasuriesForUser to pick a default.
//
// Returns null when:
//   - The user does not exist (Privy DID never bootstrapped — onboarding
//     flow needs to fire first).
//   - The treasury exists but the user has no membership (forbidden).
//   - The treasury does not exist.
// In all three cases the caller should clear the active-treasury cookie
// and route to onboarding / fall back to first membership.
export async function getActiveTreasuryAndRole(
  db: Db,
  privyDid: string,
  cookieTreasuryId: string | null,
): Promise<ActiveTreasuryAndRole | null> {
  if (!cookieTreasuryId) return null;
  const [row] = await db
    .select({
      user: users,
      treasury: treasuries,
      role: treasuryMemberships.role,
    })
    .from(users)
    .innerJoin(treasuryMemberships, eq(treasuryMemberships.userId, users.id))
    .innerJoin(treasuries, eq(treasuries.id, treasuryMemberships.treasuryId))
    .where(and(eq(users.privyDid, privyDid), eq(treasuries.id, cookieTreasuryId)))
    .limit(1);
  if (!row) return null;
  return { user: row.user, treasury: row.treasury, role: row.role as Role };
}

// Used in route-handler fast paths where the caller has already mapped
// the Privy DID to a user_id (e.g., right after bootstrapUser).
export async function getActiveTreasuryAndRoleByUserId(
  db: Db,
  userId: string,
  cookieTreasuryId: string | null,
): Promise<{ treasury: TreasuryRow; role: Role } | null> {
  if (!cookieTreasuryId) return null;
  const [row] = await db
    .select({
      treasury: treasuries,
      role: treasuryMemberships.role,
    })
    .from(treasuryMemberships)
    .innerJoin(treasuries, eq(treasuries.id, treasuryMemberships.treasuryId))
    .where(
      and(
        eq(treasuryMemberships.userId, userId),
        eq(treasuryMemberships.treasuryId, cookieTreasuryId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return { treasury: row.treasury, role: row.role as Role };
}
