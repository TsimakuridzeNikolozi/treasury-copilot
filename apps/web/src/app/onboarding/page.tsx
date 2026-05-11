import { OnboardingClient } from '@/app/onboarding/onboarding-client';
import { db } from '@/lib/db';
import { requireAuthOnly } from '@/lib/server-page-auth';
import { getUserByPrivyDid, listTreasuriesForUser } from '@tc/db';
import { redirect } from 'next/navigation';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution. Without `force-dynamic` the page can be statically
// prerendered and a single rendered HTML can leak across users.
export const dynamic = 'force-dynamic';

// M2 PR 5 / onboarding wizard.
//
// Server-side step derivation. Single source of truth is
// `users.onboarding_step`:
//
//   user row missing OR (onboarded_at null AND onboarding_step null) → 1
//   onboarded_at non-null                                            → /chat redirect
//   else                                                              → onboarding_step (1..5)
//
// No inference from policy / telegram / RPC balance — those are too brittle
// (see PR 5 plan, fixes #2 #3 #7). The wizard's "Continue" / "Skip" CTAs
// POST /api/me/onboarding-step before advancing locally; refresh re-derives
// from the saved step.
export default async function OnboardingPage() {
  const { userId: privyDid } = await requireAuthOnly('/onboarding');

  const user = await getUserByPrivyDid(db, privyDid);

  // First sign-in: no users row yet. Bootstrap (step 1's "Get started"
  // CTA) creates it. We still render the wizard at step 1 — the bootstrap
  // call is what the user clicks to make progress.
  if (!user) {
    return <OnboardingClient initialStep={1} initialTreasury={null} />;
  }

  // Look up memberships up front — both the "already done" redirect
  // gate and the wizard's step 2-5 rendering need them.
  // listTreasuriesForUser returns rows ordered createdAt desc.
  const memberships = await listTreasuriesForUser(db, user.id);

  // "Already done" gate: onboarded_at set AND at least one membership.
  // The membership check matters because PR 5's migration backfilled
  // `onboarded_at = NOW()` for every pre-existing user, including
  // orphaned ones (stage-3 bootstrap failed pre-PR-5; user row exists
  // but no treasury). Without this guard those users would loop:
  // /chat → bootstrapAuthAndTreasury → /onboarding (here) → /chat.
  // Treating them as "needs to bootstrap" runs the wizard from step 1;
  // step 1's bootstrap call is idempotent, so this is also safe for
  // the rare case where the orphan resolves itself between renders.
  if (user.onboardedAt !== null && memberships.length > 0) {
    redirect('/chat');
  }

  // Project the membership to the minimal shape the wizard consumes —
  // keeps the client bundle off the full TreasuryRow surface.
  const t = memberships[0]?.treasury;
  const treasury = t ? { id: t.id, name: t.name, walletAddress: t.walletAddress } : null;

  // Resume position. `onboarding_step` is null only between bootstrap
  // returning and the first `/api/me/onboarding-step` POST landing — a
  // narrow window. Treat null as step 1 and let bootstrap idempotency
  // handle re-attempts (existing membership → short-circuit).
  const raw = user.onboardingStep ?? 1;
  const step = (raw >= 1 && raw <= 5 ? raw : 1) as 1 | 2 | 3 | 4 | 5;

  return <OnboardingClient initialStep={step} initialTreasury={treasury} />;
}
