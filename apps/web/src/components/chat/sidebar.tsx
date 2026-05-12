'use client';

import { TCMark } from '@/components/brand/tc-logo';
import { TreasurySwitcher } from '@/components/treasury-switcher';
import { Chip } from '@/components/ui/chip';
import { IconButton } from '@/components/ui/icon-button';
import { Mono } from '@/components/ui/mono';
import { SectionLabel } from '@/components/ui/section-label';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import type { HistoryEntryDto } from '@/lib/dto/history';
import { cn } from '@/lib/utils';
import {
  ArrowDownToLineIcon,
  ArrowLeftRightIcon,
  ArrowRightIcon,
  ArrowUpFromLineIcon,
  SendIcon,
  SettingsIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export interface SidebarSnapshot {
  // Total dollar amount across wallet + venues; pre-formatted.
  totalUsdc: string;
  // Wallet (idle) USDC.
  walletUsdc: string;
  // Per-venue supplied amount + display APY (as percentage, e.g. "4.21%").
  // APY is null if the SDK read missed (jupiter only today).
  positions: ReadonlyArray<{
    venue: 'kamino' | 'save' | 'jupiter';
    amountUsdc: string;
    apyPct: string | null;
  }>;
  // Blended APY across positions, as a percentage string. Null if no venue
  // has a position.
  blendedApyPct: string | null;
}

export interface SidebarProps {
  activeTreasuryId: string;
  treasuryName: string;
  telegramUsername: string | null;
  snapshot: SidebarSnapshot | null;
  recentHistory: ReadonlyArray<HistoryEntryDto>;
  // Mobile drawer state — desktop ignores both.
  mobileOpen: boolean;
  onMobileClose: () => void;
}

// Chat sidebar: treasury switcher header → live balance → positions →
// recent activity → footer with telegram chip + theme toggle.
// Per user direction the "New action" button from the design is omitted —
// the composer at the bottom of the thread is the only entry point.
export function ChatSidebar({
  activeTreasuryId,
  treasuryName,
  telegramUsername,
  snapshot,
  recentHistory,
  mobileOpen,
  onMobileClose,
}: SidebarProps) {
  const idleUsdc = snapshot?.walletUsdc ?? '—';
  const totalUsdc = snapshot?.totalUsdc ?? '—';
  const blendedApy = snapshot?.blendedApyPct ?? null;

  return (
    <>
      {/* Mobile backdrop. Click-outside closes the drawer. Desktop ignores
          via md:hidden + opacity-0/pointer-events-none. */}
      <button
        type="button"
        aria-hidden={!mobileOpen}
        tabIndex={-1}
        onClick={onMobileClose}
        className={cn(
          'fixed inset-0 z-30 bg-black/40 transition-opacity md:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        // Desktop: fixed 280px column on the left. Mobile: full-height
        // drawer that slides in from the left; the wrapper is always
        // mounted so React keeps focus across open/close transitions.
        aria-label="Treasury overview"
        aria-modal={mobileOpen ? 'true' : undefined}
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex h-full w-[280px] flex-col border-r bg-background transition-transform md:sticky md:top-0 md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        <div className="flex items-center justify-between border-b px-4 py-4">
          <TreasurySwitcher activeTreasuryId={activeTreasuryId} />
          <div className="flex items-center gap-0.5">
            <IconButton size="sm" aria-label="Settings" asChild>
              <Link href="/settings">
                <SettingsIcon />
              </Link>
            </IconButton>
            {/* Mobile-only close. Hidden on desktop since there's no
                drawer to close. */}
            <IconButton
              size="sm"
              aria-label="Close sidebar"
              onClick={onMobileClose}
              className="md:hidden"
            >
              <XIcon />
            </IconButton>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <BalanceBlock totalUsdc={totalUsdc} blendedApy={blendedApy} live={snapshot !== null} />
          <PositionsBlock positions={snapshot?.positions ?? []} idleUsdc={idleUsdc} />
          <RecentActivityBlock entries={recentHistory} treasuryName={treasuryName} />
        </div>

        <FooterBlock telegramUsername={telegramUsername} />
      </aside>
    </>
  );
}

function BalanceBlock({
  totalUsdc,
  blendedApy,
  live,
}: {
  totalUsdc: string;
  blendedApy: string | null;
  live: boolean;
}) {
  return (
    <div className="px-4 py-5">
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>Treasury</SectionLabel>
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {live ? (
            <span aria-hidden className="tc-pulse inline-block size-1 rounded-full bg-primary" />
          ) : null}
          <Mono>Live</Mono>
        </span>
      </div>
      <Mono className="block text-2xl text-foreground">${totalUsdc}</Mono>
      <Mono className="text-[11px] text-muted-foreground">
        USDC{blendedApy ? ` · blended ${blendedApy} APY` : ''}
      </Mono>
    </div>
  );
}

function PositionsBlock({
  positions,
  idleUsdc,
}: {
  positions: SidebarSnapshot['positions'];
  idleUsdc: string;
}) {
  const VENUE_LABEL: Record<string, string> = {
    kamino: 'Kamino',
    save: 'Save',
    jupiter: 'Jupiter',
  };
  return (
    <div className="px-4 pb-4">
      <SectionLabel className="mb-2">Positions</SectionLabel>
      <div className="flex flex-col">
        {positions.map((p) => (
          <PositionRow
            key={p.venue}
            venue={VENUE_LABEL[p.venue] ?? p.venue}
            amount={p.amountUsdc}
            apy={p.apyPct}
          />
        ))}
        <PositionRow venue="Idle" amount={idleUsdc} apy={null} muted />
      </div>
    </div>
  );
}

function PositionRow({
  venue,
  amount,
  apy,
  muted,
}: {
  venue: string;
  amount: string;
  apy: string | null;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={cn('inline-block size-1.5 rounded-full', muted ? 'bg-border' : 'bg-primary')}
        />
        <span className={cn('text-sm', muted ? 'text-muted-foreground' : 'text-foreground')}>
          {venue}
        </span>
      </div>
      <div className="flex flex-col items-end gap-0.5">
        <Mono className={cn('text-xs', muted ? 'text-muted-foreground' : 'text-foreground')}>
          ${amount}
        </Mono>
        <Mono className="text-[10px] text-muted-foreground">{apy ?? '—'}</Mono>
      </div>
    </div>
  );
}

function RecentActivityBlock({
  entries,
  treasuryName: _treasuryName,
}: {
  entries: ReadonlyArray<HistoryEntryDto>;
  treasuryName: string;
}) {
  return (
    <div className="px-4 pb-5">
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel>Recent activity</SectionLabel>
        <Link
          href="/history"
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          View all
          <ArrowRightIcon className="size-3" aria-hidden />
        </Link>
      </div>
      {entries.length === 0 ? (
        <p className="rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          No actions yet. Try "deposit 0.5 USDC to jupiter".
        </p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((e) => (
            <HistoryMiniRow key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

const KIND_ICON = {
  deposit: ArrowDownToLineIcon,
  withdraw: ArrowUpFromLineIcon,
  rebalance: ArrowLeftRightIcon,
  transfer: SendIcon,
} as const;

const STATUS_DOT_CLASS: Record<string, string> = {
  pending: 'bg-muted-foreground/50',
  approved: 'bg-primary',
  executing: 'bg-primary tc-pulse',
  executed: 'bg-primary',
  failed: 'bg-destructive',
  denied: 'bg-destructive',
};

function HistoryMiniRow({ entry }: { entry: HistoryEntryDto }) {
  const Icon = KIND_ICON[entry.kind] ?? SendIcon;
  return (
    <li className="flex items-center justify-between gap-2 border-b py-1.5 last:border-b-0">
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        <Mono className="truncate text-[11px] text-foreground">${entry.amountUsdc}</Mono>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Mono className="text-[10px] text-muted-foreground">{relativeTime(entry.createdAt)}</Mono>
        <span
          aria-label={`Status: ${entry.status}`}
          className={cn(
            'inline-block size-1.5 rounded-full',
            STATUS_DOT_CLASS[entry.status] ?? STATUS_DOT_CLASS.pending,
          )}
        />
      </span>
    </li>
  );
}

function FooterBlock({ telegramUsername }: { telegramUsername: string | null }) {
  return (
    <div className="border-t px-4 py-3 flex items-center justify-between gap-2">
      {telegramUsername ? (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <TCMark size={10} />
          <Mono className="truncate">{telegramUsername}</Mono>
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">Telegram not set</span>
      )}
      <div className="flex items-center gap-1">
        {telegramUsername ? (
          <Chip tone="primary" dot>
            On
          </Chip>
        ) : (
          <Chip tone="outline">Off</Chip>
        )}
        <ThemeToggle size="sm" />
      </div>
    </div>
  );
}

// Minimal relative-time formatter. Avoids pulling in date-fns / dayjs for
// a six-string surface. Falls back to the date for older entries.
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Re-export the router-bound refresh hook so the parent can refresh
// server-rendered sidebar data after each chat turn lands.
export function useSidebarRefresh() {
  const router = useRouter();
  return () => router.refresh();
}
