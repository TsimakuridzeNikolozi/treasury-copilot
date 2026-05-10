import { AppNav } from '@/components/app-nav';
import { PolicyForm } from '@/components/policy-form';
import { TelegramConfigForm } from '@/components/telegram-config-form';
import { WalletAddressBlock } from '@/components/wallet-address-block';
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
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
            <p className="text-muted-foreground text-xs">
              Treasury: <span className="font-mono">{treasury.name}</span>
            </p>
          </div>
          <WalletAddressBlock address={treasury.walletAddress} />
        </header>

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="font-semibold text-lg tracking-tight">Policy</h2>
            <p className="text-muted-foreground text-sm">
              Caps and venue allowlist applied at proposal time. Changes take effect on the next
              proposed action — in-flight executions use the policy frozen at proposal time.
            </p>
          </div>
          <PolicyForm initial={policy} meta={formMeta} treasuryId={treasury.id} />
        </section>

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="font-semibold text-lg tracking-tight">Telegram</h2>
            <p className="text-muted-foreground text-sm">
              Per-treasury approval routing. Until a chat id is set, actions requiring approval park
              in pending — auto-approved actions still execute normally.
            </p>
          </div>
          <TelegramConfigForm
            initial={{
              telegramChatId: treasury.telegramChatId,
              telegramApproverIds: treasury.telegramApproverIds,
            }}
            treasuryId={treasury.id}
          />
        </section>
      </main>
    </div>
  );
}
