import { AppNav } from '@/components/app-nav';
import { PolicyForm } from '@/components/policy-form';
import { db } from '@/lib/db';
import { bootstrapAuthAndTreasury } from '@/lib/server-page-auth';
import { getPolicy, getPolicyMeta } from '@tc/db';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Same as /chat: per-user policy must not be statically prerendered.
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { treasury } = await bootstrapAuthAndTreasury('/settings');

  const [policy, meta] = await Promise.all([
    getPolicy(db, treasury.id),
    getPolicyMeta(db, treasury.id),
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
      <AppNav activeTreasuryId={treasury.id} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <header className="mb-8 flex flex-col gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">Policy</h1>
          <p className="text-muted-foreground text-sm">
            Caps and venue allowlist applied at proposal time. Changes take effect on the next
            proposed action — in-flight executions use the policy frozen at proposal time.
          </p>
          <p className="text-muted-foreground text-xs">
            Treasury: <span className="font-mono">{treasury.name}</span>
          </p>
        </header>
        <PolicyForm initial={policy} meta={formMeta} treasuryId={treasury.id} />
      </main>
    </div>
  );
}
