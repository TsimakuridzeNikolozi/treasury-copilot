import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { getUserByPrivyDid, listTreasuriesForUser } from '@tc/db';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user list — never cache. Without this Next 15 can collapse the
// response across users (cookie/auth aren't part of the cache key).
// `force-dynamic` is sufficient on its own; no need for `revalidate = 0`.
export const dynamic = 'force-dynamic';

// GET /api/treasury — list of treasuries the current user is a member of.
// Drives the TreasurySwitcher dropdown. **No POST** in PR 2; M3 adds
// invitations + new-treasury creation.
export async function GET(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const user = await getUserByPrivyDid(db, auth.userId);
  // No user row yet means the bootstrap flow hasn't run for this DID.
  // Return an empty list rather than 404; the client redirects to `/`
  // via the same onboarding path the chat/policy routes use.
  if (!user) return Response.json([]);

  const memberships = await listTreasuriesForUser(db, user.id);
  return Response.json(
    memberships.map((m) => ({
      id: m.treasury.id,
      name: m.treasury.name,
      walletAddress: m.treasury.walletAddress,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
  );
}
