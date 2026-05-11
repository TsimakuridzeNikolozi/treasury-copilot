import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { InvalidOnboardingStep, getUserByPrivyDid, markUserOnboardingStep } from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user mutation. Never cache.
export const dynamic = 'force-dynamic';

// POST /api/me/onboarding-step
//
// Persists the wizard's current step so refresh / cross-tab resume lands
// in the right place. Body is `{ step: 1..5 }`. No-op once the user is
// onboarded (markUserOnboardingStep filters on `onboarded_at IS NULL` at
// the SQL level — re-onboarding via this route is impossible).
//
// The wizard's CTAs POST here best-effort BEFORE advancing locally.
// Errors are non-fatal — the client logs and keeps going. Refresh would
// re-derive the saved step (one CTA click behind, but never corrupt).
const StepBody = z.object({
  step: z.number().int().min(1).max(5),
});

export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = StepBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const user = await getUserByPrivyDid(db, auth.userId);
  if (!user) {
    return Response.json({ error: 'no_user_row' }, { status: 409 });
  }

  try {
    await markUserOnboardingStep(db, user.id, parsed.data.step);
  } catch (err) {
    // The helper validates the range too (defense-in-depth); should
    // never fire because Zod already gated the body, but treat as 400
    // if it does.
    if (err instanceof InvalidOnboardingStep) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  return new Response(null, { status: 204 });
}
