import { clearActiveTreasuryCookie } from '@/lib/cookie-headers';

// postgres-js elsewhere in the app uses Node APIs; routes don't need to
// be in the Edge runtime, but this one is cookie-clear-only and could
// run anywhere. Keeping it on Node for parity with the other auth-adjacent
// routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/logout — clears the tc_active_treasury cookie so user
// A's selection doesn't leak to user B on the same browser.
//
// Threat model: safe to call unauthenticated because `tc_active_treasury`
// is `SameSite=Lax`, so cross-origin `fetch` POSTs don't carry it; the
// worst a CSRF attacker achieves is forcing the user to re-pick a
// treasury (low impact). Bearer-auth on every other new route is
// CSRF-immune by virtue of using a header rather than a cookie.
//
// **Does not** touch Privy's own cookie. The client is expected to call
// Privy's `logout()` in parallel; the two paths split the cleanup cleanly.
export async function POST(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': clearActiveTreasuryCookie() },
  });
}
