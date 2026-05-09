import { AppNav } from '@/components/app-nav';
import { PolicyForm } from '@/components/policy-form';
import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { PRIVY_COOKIE, privy } from '@/lib/privy';
import { getPolicy, getPolicyMeta } from '@tc/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Same as /chat: per-user policy must not be statically prerendered.
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  // Strict server-side auth check before any DB read.
  const cookieStore = await cookies();
  const token = cookieStore.get(PRIVY_COOKIE)?.value;
  if (!token) redirect('/?next=/settings');
  let claims: { userId: string };
  try {
    const verified = await privy.verifyAuthToken(token);
    claims = { userId: verified.userId };
  } catch {
    redirect('/?next=/settings');
  }

  // Just the cookie header — that's all resolveActiveTreasury reads.
  // Mirrors apps/web/src/app/chat/page.tsx.
  const cookieHeader = cookieStore.toString();
  const fakeReq = new Request('http://internal/settings', {
    headers: { cookie: cookieHeader },
  });
  const resolved = await resolveActiveTreasury(fakeReq, db, claims.userId);
  if ('onboardingRequired' in resolved) {
    redirect('/');
  }
  // Note: we deliberately don't write the cookie here even when the
  // resolver returned `setCookieHeader`. Next 15 forbids cookie mutations
  // from async server components on a GET render — only Route Handlers
  // and Server Actions can. The cookie self-heals on the next API
  // request (chat send / policy edit / switcher fetch), all of which go
  // through `resolveActiveTreasury` and can attach the corrected
  // Set-Cookie to their response. The page itself renders correctly
  // because we use `resolved.treasury.id` directly, not the cookie.

  const [policy, meta] = await Promise.all([
    getPolicy(db, resolved.treasury.id),
    getPolicyMeta(db, resolved.treasury.id),
  ]);
  // RSC → client serialization: Date works through Flight, but ISO strings
  // are easier for the form to format predictably and don't require dealing
  // with timezone surprises on rehydration.
  const formMeta = {
    updatedAtIso: meta.updatedAt ? meta.updatedAt.toISOString() : null,
    updatedBy: meta.updatedBy,
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppNav activeTreasuryId={resolved.treasury.id} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <header className="mb-8 flex flex-col gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">Policy</h1>
          <p className="text-muted-foreground text-sm">
            Caps and venue allowlist applied at proposal time. Changes take effect on the next
            proposed action — in-flight executions use the policy frozen at proposal time.
          </p>
          <p className="text-muted-foreground text-xs">
            Treasury: <span className="font-mono">{resolved.treasury.name}</span>
          </p>
        </header>
        <PolicyForm initial={policy} meta={formMeta} treasuryId={resolved.treasury.id} />
      </main>
    </div>
  );
}
