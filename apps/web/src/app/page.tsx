import { FeatureRow, SignInPanel, SignedInPanel } from '@/components/landing-panels';
import { MarketingShell } from '@/components/shells/marketing-shell';
import { Chip } from '@/components/ui/chip';
import { db } from '@/lib/db';
import { PRIVY_COOKIE, privy } from '@/lib/privy';
import { getTreasuryById, getUserByPrivyDid, listTreasuriesForUser } from '@tc/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of Next 15's URL-based cache
// key. Without `force-dynamic` the page can be statically prerendered and
// a single rendered HTML can leak across users.
export const dynamic = 'force-dynamic';

// Server-rendered gate. Three states:
//   1. Not signed in        → render <SignInPanel/>.
//   2. Signed in, not done  → 307 → /onboarding.
//   3. Signed in, onboarded → render <SignedInPanel/>.
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
    return <LandingShell mode="signed-out" />;
  }

  let userId: string;
  try {
    const verified = await privy.verifyAuthToken(token);
    userId = verified.userId;
  } catch {
    return <LandingShell mode="signed-out" />;
  }

  const user = await getUserByPrivyDid(db, userId);
  if (!user || user.onboardedAt === null) {
    redirect('/onboarding');
  }

  const memberships = await listTreasuriesForUser(db, user.id);
  if (memberships.length === 0) {
    redirect('/onboarding');
  }

  if (next) redirect(next);

  // The signed-in panel's "Connected" chip reflects the active treasury's
  // telegram config. We only need a single column read for the chip, so
  // skip the heavier snapshot read here — the chat page will surface
  // real positions / APY.
  const activeTreasury = memberships[0]?.treasury ?? null;
  const treasury = activeTreasury ? await getTreasuryById(db, activeTreasury.id) : null;

  return (
    <LandingShell
      mode="signed-in"
      email={user.email}
      did={userId}
      telegramConnected={Boolean(treasury?.telegramChatId)}
    />
  );
}

interface LandingShellProps {
  mode: 'signed-in' | 'signed-out';
  email?: string | null;
  did?: string | null;
  telegramConnected?: boolean;
}

function LandingShell({
  mode,
  email = null,
  did = null,
  telegramConnected = false,
}: LandingShellProps) {
  return (
    <MarketingShell>
      <section className="flex flex-1 flex-col items-center justify-center px-5 py-12 sm:px-8 sm:py-16">
        <div className="grid w-full max-w-[920px] grid-cols-1 items-center gap-10 md:grid-cols-[1.1fr_1fr] md:gap-12">
          {/* Left — hero copy + stats */}
          <div className="flex flex-col gap-6">
            <Chip tone="outline" className="self-start">
              <span
                aria-hidden
                className="inline-block size-1.5 rounded-full"
                style={{ backgroundColor: 'var(--primary)' }}
              />
              v0.3 · Mainnet
            </Chip>
            <h1
              className="font-semibold text-5xl text-foreground tracking-tight"
              style={{ letterSpacing: '-0.02em', lineHeight: 1.05 }}
            >
              Manage USDC
              <br />
              by chat.
            </h1>
            <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
              Treasury Copilot deposits, withdraws, and rebalances USDC across Kamino, Save, and
              Jupiter Lend. Every action runs against your policy. Anything above threshold routes
              to Telegram for human approval.
            </p>
          </div>

          {/* Right — auth panel */}
          <div>
            {mode === 'signed-in' ? (
              <SignedInPanel email={email} did={did} telegramConnected={telegramConnected} />
            ) : (
              <SignInPanel />
            )}
          </div>
        </div>

        <div className="mt-12 w-full max-w-[920px] sm:mt-20">
          <FeatureRow />
        </div>
      </section>
    </MarketingShell>
  );
}

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
