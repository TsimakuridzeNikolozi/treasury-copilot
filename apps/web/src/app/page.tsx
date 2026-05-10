import { FeatureRow, SignInPanel, SignedInPanel } from '@/components/landing-panels';
import { db } from '@/lib/db';
import { PRIVY_COOKIE, privy } from '@/lib/privy';
import { getUserByPrivyDid, listTreasuriesForUser } from '@tc/db';
import { CoinsIcon } from 'lucide-react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of Next 15's URL-based cache
// key. Without `force-dynamic` the page can be statically prerendered
// and a single rendered HTML can leak across users.
export const dynamic = 'force-dynamic';

// M2 PR 5 / landing page.
//
// Server-rendered gate. Three states:
//   1. Not signed in        → render <SignInPanel/> (Privy login flow).
//   2. Signed in, not done  → 307 → /onboarding (the wizard owns bootstrap
//                             now; auto-bootstrap from this page is gone).
//   3. Signed in, onboarded → render <SignedInPanel/> (Open chat / Settings
//                             / Sign out). Honors `?next=` if middleware
//                             bounced the user here from a deep link.
//
// "onboarded" is determined server-side by `users.onboarded_at` (added in
// migration 0008). Pre-PR-5 users were backfilled to NOW(), so they
// always land on case 3.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = sanitizeNextPath(params.next ?? null);

  const cookieStore = await cookies();
  const token = cookieStore.get(PRIVY_COOKIE)?.value;

  // Case 1 — not signed in.
  if (!token) {
    return (
      <Shell>
        <SignInPanel />
      </Shell>
    );
  }

  // Verify the cookie strictly. Failure (expired, tampered) falls through
  // to the SignInPanel rather than throwing — Privy's login flow can
  // refresh the token in place.
  let userId: string;
  try {
    const verified = await privy.verifyAuthToken(token);
    userId = verified.userId;
  } catch {
    return (
      <Shell>
        <SignInPanel />
      </Shell>
    );
  }

  // Pull the user's row to read onboarded_at and the rich email/DID for
  // SignedInPanel. A null result means the user has never bootstrapped
  // (no users row) — straight to the wizard.
  const user = await getUserByPrivyDid(db, userId);
  if (!user || user.onboardedAt === null) {
    redirect('/onboarding');
  }

  // Orphan guard: PR 5's migration backfilled `onboarded_at = NOW()`
  // on every existing user row, but a few of those (stage-3 bootstrap
  // failure pre-PR-5, manual cleanup) have no membership. Surfacing
  // SignedInPanel to them is a dead end — "Open chat" loops through
  // /chat → /onboarding → /chat. Skip the panel and send them through
  // the wizard from step 1 (bootstrap is idempotent so this is safe
  // even if the orphan resolves between renders).
  const memberships = await listTreasuriesForUser(db, user.id);
  if (memberships.length === 0) {
    redirect('/onboarding');
  }

  // Case 3 — signed in, onboarded, has a treasury. If middleware
  // bounced them here from a deep link, honor the `?next=` after the
  // gate succeeds.
  if (next) redirect(next);

  return (
    <Shell>
      <SignedInPanel email={user.email} did={userId} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center gap-10 px-6 py-16">
      {/* Subtle radial backdrop — gives the empty page a sense of depth without
          stealing attention from the call-to-action. */}
      <div
        aria-hidden
        className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--color-muted)_0%,transparent_60%)]"
      />
      <div className="flex flex-col items-center gap-3 text-center">
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"
        >
          <CoinsIcon className="size-6" />
        </div>
        <h1 className="font-semibold text-4xl tracking-tight sm:text-5xl">Treasury Copilot</h1>
        <p className="max-w-md text-balance text-muted-foreground">
          Chat-first AI agent that manages USDC across Solana yield venues — under hard policy
          guardrails.
        </p>
      </div>
      {children}
      <FeatureRow />
    </main>
  );
}

// Open-redirect guard: middleware sets `?next=<path>` on bounces and only
// ever stores app-internal paths there, but the param is attacker-influenced
// (anyone can craft a `/?next=https://evil.com` link). Reject anything that
// doesn't look like a same-origin relative path. Returns null when the
// param is missing or unsafe — caller falls back to default destination.
function sanitizeNextPath(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  if (next.includes('\\')) return null;
  try {
    const parsed = new URL(next, 'http://placeholder.invalid');
    if (parsed.host !== 'placeholder.invalid') return null;
  } catch {
    return null;
  }
  return next;
}
