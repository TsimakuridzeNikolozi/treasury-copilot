import { setActiveTreasuryCookie } from '@/lib/cookie-headers';
import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { ForbiddenError, getUserByPrivyDid, requireMembership } from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ActiveBody = z.object({
  treasuryId: z.string().uuid(),
});

// POST /api/treasury/active { treasuryId } — switches the active treasury
// after `requireMembership` confirms the user can access it.
//
// `verifyBearer` returns the Privy DID; `requireMembership` takes the
// users.id UUID, so we resolve via getUserByPrivyDid first. Two
// round-trips here is fine — this endpoint is only hit on switcher
// clicks, not the hot read paths.
export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = ActiveBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const user = await getUserByPrivyDid(db, auth.userId);
  if (!user) {
    // The DID hasn't been bootstrapped — treat as forbidden, same as a
    // bearer for an unknown user.
    return new Response('forbidden', { status: 403 });
  }

  try {
    await requireMembership(db, user.id, parsed.data.treasuryId);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return new Response('forbidden', { status: 403 });
    }
    throw err;
  }

  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': setActiveTreasuryCookie(parsed.data.treasuryId) },
  });
}
