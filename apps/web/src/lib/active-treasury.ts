import {
  type Db,
  type Role,
  type TreasuryRow,
  getActiveTreasuryAndRole,
  getUserByPrivyDid,
  listTreasuriesForUser,
} from '@tc/db';
import { ACTIVE_TREASURY_COOKIE } from './active-treasury-cookie';
import { clearActiveTreasuryCookie, setActiveTreasuryCookie } from './cookie-headers';

// Role comes from @tc/db (`memberships.ts` — currently `'owner'` only;
// M3 expands to 'approver' / 'viewer'). Re-using that single source
// means the resolver picks up new variants automatically when the
// CHECK constraint lifts, instead of silently widening at a `as` cast.

export type ResolveActiveTreasuryResult =
  | {
      treasury: TreasuryRow;
      role: Role;
      // When the cookie was missing/invalid and we picked a new treasury,
      // the caller should attach this to the response so the next request
      // round-trips with the corrected cookie.
      setCookieHeader?: string;
    }
  | {
      onboardingRequired: true;
      // Set when the cookie was present-but-invalid AND the user has no
      // memberships — we clear it via Set-Cookie so a stale id doesn't
      // re-fire the same fallback on every page load.
      setCookieHeader?: string;
    };

// Reads the active-treasury cookie from a Request, validates it against
// the user's memberships, and returns the treasury + role on success.
// Centralizes the present-but-invalid fallback so each route handler
// doesn't reimplement it.
//
// Resolution order:
//   1. Cookie present + user is a member → return that treasury (no Set-Cookie).
//   2. Cookie present-but-invalid (or missing) AND user has memberships
//      → pick the first one, return it, AND emit Set-Cookie to update
//        the browser so subsequent requests skip the fallback.
//   3. Cookie present-but-invalid (or missing) AND user has zero
//      memberships → onboardingRequired; if the cookie was set, also
//        emit a clear-cookie Set-Cookie so a stale id doesn't keep
//        triggering the fallback.
//
// Why not retry getActiveTreasuryAndRole(db, privyDid, null) on the
// fallback path: that helper early-returns null on a null
// cookieTreasuryId by design (memberships.ts:101). The fallback uses
// listTreasuriesForUser instead, which requires the user_id UUID so
// we resolve via getUserByPrivyDid first.
export async function resolveActiveTreasury(
  req: Request,
  db: Db,
  privyDid: string,
): Promise<ResolveActiveTreasuryResult> {
  const cookieTreasuryId = readCookie(req, ACTIVE_TREASURY_COOKIE);

  // Hot path: cookie set and user is a member.
  if (cookieTreasuryId) {
    const hit = await getActiveTreasuryAndRole(db, privyDid, cookieTreasuryId);
    if (hit) {
      return { treasury: hit.treasury, role: hit.role };
    }
  }

  // Fallback. Resolve users.id (privy_did → uuid) so we can list their
  // memberships. A missing user row means the bootstrap flow hasn't run
  // for this DID yet — caller redirects to `/`.
  const user = await getUserByPrivyDid(db, privyDid);
  if (!user) {
    return {
      onboardingRequired: true,
      ...(cookieTreasuryId ? { setCookieHeader: clearActiveTreasuryCookie() } : {}),
    };
  }

  const memberships = await listTreasuriesForUser(db, user.id);
  if (memberships.length === 0) {
    return {
      onboardingRequired: true,
      ...(cookieTreasuryId ? { setCookieHeader: clearActiveTreasuryCookie() } : {}),
    };
  }

  // listTreasuriesForUser orders by createdAt desc, so [0] is the most
  // recent membership. Returning the user's "newest" treasury matches
  // user expectations after they accept an invitation in M3.
  const first = memberships[0];
  if (!first) {
    // Defensive — length check above guarantees at least one row, but
    // TS narrowing through `.length === 0` keeps this satisfying the
    // strict-null path without a non-null assertion.
    return {
      onboardingRequired: true,
      ...(cookieTreasuryId ? { setCookieHeader: clearActiveTreasuryCookie() } : {}),
    };
  }
  return {
    treasury: first.treasury,
    role: first.role,
    setCookieHeader: setActiveTreasuryCookie(first.treasury.id),
  };
}

// Minimal cookie parser sufficient for the single-cookie reads we need.
// We avoid a dependency on `cookie` because the parsing surface here is
// trivial — and Next 15 server pages already have their own
// `cookies()` helper for the page-side reads.
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k !== name) continue;
    const v = pair.slice(eq + 1).trim();
    return v.length ? decodeURIComponent(v) : null;
  }
  return null;
}
