import {
  type AlertSubscriptionDto,
  AlertSubscriptionsForm,
} from '@/components/alert-subscriptions-form';
import { AppNav } from '@/components/app-nav';
import { PolicyForm } from '@/components/policy-form';
import { TelegramConfigForm } from '@/components/telegram-config-form';
import { WalletAddressBlock } from '@/components/wallet-address-block';
import { db } from '@/lib/db';
import { bootstrapAuthAndTreasury } from '@/lib/server-page-auth';
import {
  type AlertKind,
  IDLE_CAPITAL_DEFAULT_CONFIG,
  YIELD_DRIFT_DEFAULT_CONFIG,
  ensureSubscriptionsForTreasury,
  getPolicy,
  getPolicyMeta,
  listSubscriptions,
} from '@tc/db';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Same as /chat: per-user policy must not be statically prerendered.
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { treasury } = await bootstrapAuthAndTreasury('/settings');

  // Seed any kinds missing on this treasury (no-op for migrated rows;
  // covers fresh treasuries provisioned after migration 0010 ran).
  await ensureSubscriptionsForTreasury(db, treasury.id);

  const [policy, meta, alertRows] = await Promise.all([
    getPolicy(db, treasury.id),
    getPolicyMeta(db, treasury.id),
    listSubscriptions(db, treasury.id),
  ]);

  // Marshal to the client DTO shape — defaults filled in here so the
  // form always renders meaningful baseline thresholds for yield_drift.
  const alertDtos: AlertSubscriptionDto[] = alertRows.map((r) => {
    const kind = r.kind as AlertKind;
    const cfg = (r.config ?? {}) as Record<string, unknown>;
    const hasCfg = Object.keys(cfg).length > 0;
    let fallback: Record<string, unknown> = {};
    if (!hasCfg) {
      if (kind === 'yield_drift') fallback = { ...YIELD_DRIFT_DEFAULT_CONFIG };
      else if (kind === 'idle_capital') fallback = { ...IDLE_CAPITAL_DEFAULT_CONFIG };
    }
    return {
      kind,
      enabled: r.enabled,
      config: hasCfg ? cfg : fallback,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
      updatedBy: r.updatedBy ?? null,
    };
  });
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
          <WalletAddressBlock
            address={treasury.walletAddress}
            signerBackend={treasury.signerBackend}
          />
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

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="font-semibold text-lg tracking-tight">Alerts</h2>
            <p className="text-muted-foreground text-sm">
              Telegram-delivered notifications for yield drift, idle capital, anomalies, and
              concentration risk. All start off; turn them on once your Telegram is configured.
            </p>
          </div>
          <AlertSubscriptionsForm initial={alertDtos} treasuryId={treasury.id} />
        </section>
      </main>
    </div>
  );
}
