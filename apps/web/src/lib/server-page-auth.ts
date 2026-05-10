import type { TreasuryRow } from '@tc/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveActiveTreasury } from './active-treasury';
import { db } from './db';
import { PRIVY_COOKIE, privy } from './privy';

export interface PageAuthResult {
  userId: string;
  treasury: TreasuryRow;
}

// Verify the Privy cookie. Used by pages that need authentication but
// NOT a resolved treasury — specifically `/onboarding`, where the user
// may not have a `users` row yet (first sign-in). Returning `userId`
// without touching memberships keeps the gate logic linear:
//
//   /onboarding   →  requireAuthOnly
//   /chat /settings  →  bootstrapAuthAndTreasury
//
// Without this split, /onboarding calling bootstrapAuthAndTreasury
// would resolve onboardingRequired (no memberships) → redirect to
// /onboarding → infinite loop.
export async function requireAuthOnly(nextPath: string): Promise<{ userId: string }> {
  const cookieStore = await cookies();
  const token = cookieStore.get(PRIVY_COOKIE)?.value;
  if (!token) redirect(`/?next=${encodeURIComponent(nextPath)}`);

  try {
    const verified = await privy.verifyAuthToken(token);
    return { userId: verified.userId };
  } catch {
    redirect(`/?next=${encodeURIComponent(nextPath)}`);
  }
}

// Shared bootstrap for authenticated server pages that REQUIRE a
// resolved treasury (chat, settings, …).
//
// Steps:
//   1. Strict JWT verify against the Privy cookie. Bad/missing → /?next=…
//   2. Build a Request object carrying just the cookie header — that's
//      all `resolveActiveTreasury` reads.
//   3. Resolve the active treasury. Onboarding required → /onboarding.
//
// Note: server pages cannot mutate cookies during a GET render in Next 15
// (only Route Handlers / Server Actions can), so we deliberately drop
// the resolver's `setCookieHeader` here. The cookie self-heals on the
// next API request that hits a route handler.
export async function bootstrapAuthAndTreasury(nextPath: string): Promise<PageAuthResult> {
  const cookieStore = await cookies();
  const token = cookieStore.get(PRIVY_COOKIE)?.value;
  if (!token) redirect(`/?next=${encodeURIComponent(nextPath)}`);

  let userId: string;
  try {
    const verified = await privy.verifyAuthToken(token);
    userId = verified.userId;
  } catch {
    redirect(`/?next=${encodeURIComponent(nextPath)}`);
  }

  const cookieHeader = cookieStore.toString();
  const fakeReq = new Request(`http://internal${nextPath}`, {
    headers: { cookie: cookieHeader },
  });

  const resolved = await resolveActiveTreasury(fakeReq, db, userId);
  if ('onboardingRequired' in resolved) {
    // M2 PR 5: redirect to /onboarding (not /). Pre-PR-5 this redirected
    // to /, where page.tsx auto-fired bootstrap. The wizard owns
    // bootstrap now (step 1's "Get started" CTA), so the gate routes
    // through /onboarding instead. /onboarding uses `requireAuthOnly`
    // — never bootstrapAuthAndTreasury — so this redirect terminates
    // cleanly there.
    redirect('/onboarding');
  }

  return { userId, treasury: resolved.treasury };
}
