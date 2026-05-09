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

// Shared bootstrap for authenticated server pages (chat, settings, …).
//
// Steps:
//   1. Strict JWT verify against the Privy cookie. Bad/missing → /?next=…
//   2. Build a Request object carrying just the cookie header — that's
//      all `resolveActiveTreasury` reads.
//   3. Resolve the active treasury. Onboarding required → /.
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
    redirect('/');
  }

  return { userId, treasury: resolved.treasury };
}
