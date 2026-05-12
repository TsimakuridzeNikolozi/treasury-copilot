import { AddressBookTable } from '@/components/address-book-table';
import {
  type AlertSubscriptionDto,
  AlertSubscriptionsForm,
} from '@/components/alert-subscriptions-form';
import { PolicyForm } from '@/components/policy-form';
import { SettingsSectionNav } from '@/components/settings/section-nav';
import { AppShell } from '@/components/shells/app-shell';
import { TelegramConfigForm } from '@/components/telegram-config-form';
import { SectionLabel } from '@/components/ui/section-label';
import { WalletAddressBlock } from '@/components/wallet-address-block';
import { db } from '@/lib/db';
import { addressBookEntryRowToDto } from '@/lib/dto/address-book';
import { bootstrapAuthAndTreasury } from '@/lib/server-page-auth';
import {
  type AlertKind,
  IDLE_CAPITAL_DEFAULT_CONFIG,
  YIELD_DRIFT_DEFAULT_CONFIG,
  ensureSubscriptionsForTreasury,
  getPolicy,
  getPolicyMeta,
  listAddressBookEntries,
  listSubscriptions,
} from '@tc/db';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user policy must not be statically prerendered.
export const dynamic = 'force-dynamic';

const SECTIONS = [
  { id: 'wallet', label: 'Wallet' },
  { id: 'policy', label: 'Policy' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'address-book', label: 'Address book' },
] as const;

export default async function SettingsPage() {
  const { treasury } = await bootstrapAuthAndTreasury('/settings');

  // Seed any kinds missing on this treasury (no-op for migrated rows;
  // covers fresh treasuries provisioned after migration 0010 ran).
  await ensureSubscriptionsForTreasury(db, treasury.id);

  const [policy, meta, alertRows, addressBookRows] = await Promise.all([
    getPolicy(db, treasury.id),
    getPolicyMeta(db, treasury.id),
    listSubscriptions(db, treasury.id),
    listAddressBookEntries(db, treasury.id),
  ]);
  const addressBookEntries = addressBookRows.map(addressBookEntryRowToDto);

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
  const formMeta = {
    updatedAtIso: meta.updatedAt ? meta.updatedAt.toISOString() : null,
    updatedBy: meta.updatedBy,
  };

  return (
    <AppShell activeTreasuryId={treasury.id} breadcrumb="Settings">
      {/*
        Mobile nav lives here — outside the padded container — so it is
        naturally full-viewport-width without negative margins. Negative
        margins inside a grid track cause page-level horizontal overflow
        on mobile Safari even when `overflow-x: hidden` is set on html/body.
        Hidden on desktop (lg:hidden); the desktop version renders inside
        the grid left column below.
      */}
      <div className="lg:hidden">
        <SettingsSectionNav sections={SECTIONS} />
      </div>

      <div className="mx-auto w-full max-w-[940px] px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <div className="mb-8 flex flex-col gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
          <p className="text-muted-foreground text-sm">
            Treasury: <span className="font-mono text-foreground">{treasury.name}</span>
          </p>
        </div>

        <div className="grid gap-10 lg:grid-cols-[180px_1fr] lg:gap-12">
          {/* Desktop nav: sticky left-column sidebar. Hidden on mobile
              (mobile version rendered above). */}
          <div className="hidden lg:block">
            <SettingsSectionNav sections={SECTIONS} />
          </div>

          <div className="flex min-w-0 flex-col gap-12">
            <section id="wallet" className="flex scroll-mt-28 flex-col gap-4 lg:scroll-mt-20">
              <div>
                <SectionLabel>01</SectionLabel>
                <h2 className="mt-1 font-semibold text-lg tracking-tight">Wallet</h2>
                <p className="text-muted-foreground text-sm">
                  Treasury wallet address and signer backend. Fund this address with USDC on Solana
                  mainnet to start using the agent.
                </p>
              </div>
              <WalletAddressBlock
                address={treasury.walletAddress}
                signerBackend={treasury.signerBackend}
              />
            </section>

            <section id="policy" className="flex scroll-mt-28 flex-col gap-4 lg:scroll-mt-20">
              <div>
                <SectionLabel>02</SectionLabel>
                <h2 className="mt-1 font-semibold text-lg tracking-tight">Policy</h2>
                <p className="text-muted-foreground text-sm">
                  Caps and venue allowlist applied at proposal time. Changes take effect on the next
                  proposed action — in-flight executions use the policy frozen at proposal time.
                </p>
              </div>
              <PolicyForm initial={policy} meta={formMeta} treasuryId={treasury.id} />
            </section>

            <section id="telegram" className="flex scroll-mt-28 flex-col gap-4 lg:scroll-mt-20">
              <div>
                <SectionLabel>03</SectionLabel>
                <h2 className="mt-1 font-semibold text-lg tracking-tight">Telegram</h2>
                <p className="text-muted-foreground text-sm">
                  Per-treasury approval routing. Until a chat id is set, actions requiring approval
                  park in pending — auto-approved actions still execute normally.
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

            <section id="alerts" className="flex scroll-mt-28 flex-col gap-4 lg:scroll-mt-20">
              <div>
                <SectionLabel>04</SectionLabel>
                <h2 className="mt-1 font-semibold text-lg tracking-tight">Alerts</h2>
                <p className="text-muted-foreground text-sm">
                  Telegram-delivered notifications for yield drift, idle capital, anomalies, and
                  concentration risk. All start off; turn them on once your Telegram is configured.
                </p>
              </div>
              <AlertSubscriptionsForm initial={alertDtos} treasuryId={treasury.id} />
            </section>

            <section id="address-book" className="flex scroll-mt-28 flex-col gap-4 lg:scroll-mt-20">
              <div>
                <SectionLabel>05</SectionLabel>
                <h2 className="mt-1 font-semibold text-lg tracking-tight">Address book</h2>
                <p className="text-muted-foreground text-sm">
                  Named recipients for outbound USDC transfers. Pre-approved recipients skip the
                  approval card for transfers above your{' '}
                  <span className="font-mono">requireApprovalAboveUsdc</span> cap — the 24h velocity
                  budget still applies.
                </p>
              </div>
              <AddressBookTable initial={addressBookEntries} treasuryId={treasury.id} />
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
