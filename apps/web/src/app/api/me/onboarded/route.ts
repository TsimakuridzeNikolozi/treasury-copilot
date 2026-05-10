import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { getUserByPrivyDid, markUserOnboarded } from '@tc/db';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user mutation. Never cache.
export const dynamic = 'force-dynamic';

// POST /api/me/onboarded
//
// Marks the authenticated user as fully onboarded — `onboarded_at = NOW()`,
// `onboarding_step = null`, and an `audit_logs` row with kind
// `'user_onboarded'`. Idempotent on repeat calls (markUserOnboarded
// no-ops once `onboarded_at` is set).
//
// Called by the wizard's step 5 "Open chat" CTA. The route handler does
// the DB write; the client follows up with router.replace('/chat'). On
// failure the client surfaces an inline retry — we don't silently
// redirect because a stale `onboarded_at = null` would just bounce the
// user right back to /onboarding.
export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  // Resolve the users.id from the privyDid. The bootstrap step (which
  // ran earlier in the wizard) created this row; we don't expect a null
  // here, but a 409 is the correct surface if somehow a user reached
  // step 5 without ever bootstrapping.
  const user = await getUserByPrivyDid(db, auth.userId);
  if (!user) {
    return Response.json({ error: 'no_user_row' }, { status: 409 });
  }

  await markUserOnboarded(db, user.id);
  return new Response(null, { status: 204 });
}
