import { AppNav } from '@/components/app-nav';
import { PolicyForm } from '@/components/policy-form';
import { db } from '@/lib/db';
import { PRIVY_COOKIE, privy } from '@/lib/privy';
import { getPolicy, getPolicyMeta } from '@tc/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';

export default async function SettingsPage() {
  // Strict server-side auth check before any DB read. Middleware soft-gates
  // on cookie presence; here we verify the JWT signature/expiry/issuer so
  // an unauthed user never triggers the getPolicy call.
  const token = (await cookies()).get(PRIVY_COOKIE)?.value;
  if (!token) redirect('/?next=/settings');
  try {
    await privy.verifyAuthToken(token);
  } catch {
    redirect('/?next=/settings');
  }

  const [policy, meta] = await Promise.all([getPolicy(db), getPolicyMeta(db)]);
  // RSC → client serialization: Date works through Flight, but ISO strings
  // are easier for the form to format predictably and don't require dealing
  // with timezone surprises on rehydration.
  const formMeta = {
    updatedAtIso: meta.updatedAt ? meta.updatedAt.toISOString() : null,
    updatedBy: meta.updatedBy,
  };

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppNav />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <header className="mb-8 flex flex-col gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">Policy</h1>
          <p className="text-muted-foreground text-sm">
            Caps and venue allowlist applied at proposal time. Changes take effect on the next
            proposed action — in-flight executions use the policy frozen at proposal time.
          </p>
        </header>
        <PolicyForm initial={policy} meta={formMeta} />
      </main>
    </div>
  );
}
