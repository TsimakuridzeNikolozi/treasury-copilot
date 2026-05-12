'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { usePrivy } from '@privy-io/react-auth';
import { ExternalLinkIcon, Loader2Icon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { HistoryActionKind, HistoryActionStatus, HistoryEntryDto } from '@/lib/dto/history';
export type { HistoryEntryDto };

const KIND_OPTIONS: ReadonlyArray<{ value: HistoryActionKind | 'all'; label: string }> = [
  { value: 'all', label: 'All kinds' },
  { value: 'deposit', label: 'Deposit' },
  { value: 'withdraw', label: 'Withdraw' },
  { value: 'rebalance', label: 'Rebalance' },
  { value: 'transfer', label: 'Transfer' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: HistoryActionStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'executing', label: 'Executing' },
  { value: 'executed', label: 'Executed' },
  { value: 'failed', label: 'Failed' },
  { value: 'denied', label: 'Denied' },
];

function truncate(s: string, head = 4, tail = 4): string {
  if (s.length <= head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatAmount(usdc: string): string {
  // The DB stores numeric(20,6); strip trailing zeros for readability but
  // keep at least two fraction digits for sub-dollar amounts so a $0.50
  // transfer doesn't render as "$0.5".
  const n = Number.parseFloat(usdc);
  if (!Number.isFinite(n)) return usdc;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatDate(iso: string): string {
  // Locale-aware short date + time. The user's seeing newest-first, so
  // "today / yesterday" relative phrasing would be a nicety but adds
  // formatter complexity. Skip until users ask.
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Map status → badge color. `executed` is green (terminal success);
// `failed` / `denied` are destructive; in-flight statuses are neutral.
function statusBadgeClass(status: HistoryActionStatus): string {
  switch (status) {
    case 'executed':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30';
    case 'failed':
    case 'denied':
      return 'bg-destructive/15 text-destructive border-destructive/30';
    case 'pending':
    case 'approved':
    case 'executing':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30';
  }
}

interface HistoryTableProps {
  initialEntries: HistoryEntryDto[];
  initialNextCursor: string | null;
  treasuryId: string;
  pageSize: number;
}

export function HistoryTable({
  initialEntries,
  initialNextCursor,
  treasuryId,
  pageSize,
}: HistoryTableProps) {
  const { getAccessToken } = usePrivy();

  // Filter state is the *applied* filter — changing a select fires a
  // refetch from page 1. Filter values are 'all' in the UI but become
  // `undefined` on the wire (the API route treats omission as "any").
  const [kindFilter, setKindFilter] = useState<HistoryActionKind | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<HistoryActionStatus | 'all'>('all');

  const [entries, setEntries] = useState<HistoryEntryDto[]>(initialEntries);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the active treasury changes (the page re-renders with new
  // initialEntries via the server component; sync local state).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset syncs from SSR props on treasury change only — not on every re-render.
  useEffect(() => {
    setEntries(initialEntries);
    setNextCursor(initialNextCursor);
    setKindFilter('all');
    setStatusFilter('all');
    setError(null);
  }, [treasuryId]);

  const fetchPage = useCallback(
    async (opts: {
      append: boolean;
      kind: HistoryActionKind | 'all';
      status: HistoryActionStatus | 'all';
      cursor: string | null;
    }) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(pageSize) });
        if (opts.kind !== 'all') params.set('kind', opts.kind);
        if (opts.status !== 'all') params.set('status', opts.status);
        if (opts.cursor) params.set('before', opts.cursor);
        const token = await getAccessToken();
        if (!token) throw new Error('not signed in');
        const res = await fetch(`/api/treasury/history?${params.toString()}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.status === 409) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (body.error === 'no_active_treasury') {
            window.location.replace('/');
            return;
          }
          // active_treasury_changed: reload the page so the server
          // component re-renders with the new treasury's first page.
          window.location.reload();
          return;
        }
        if (!res.ok) throw new Error(`history fetch failed (${res.status})`);
        const body = (await res.json()) as {
          entries: HistoryEntryDto[];
          nextCursor: string | null;
        };
        setEntries((prev) => (opts.append ? [...prev, ...body.entries] : body.entries));
        setNextCursor(body.nextCursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load');
      } finally {
        setLoading(false);
      }
    },
    [getAccessToken, pageSize],
  );

  // Filter change → refetch page 1 (drop cursor).
  const onKindChange = (v: string) => {
    const kind = (v as HistoryActionKind | 'all') ?? 'all';
    setKindFilter(kind);
    void fetchPage({ append: false, kind, status: statusFilter, cursor: null });
  };
  const onStatusChange = (v: string) => {
    const status = (v as HistoryActionStatus | 'all') ?? 'all';
    setStatusFilter(status);
    void fetchPage({ append: false, kind: kindFilter, status, cursor: null });
  };
  const onLoadMore = () => {
    if (!nextCursor || loading) return;
    void fetchPage({
      append: true,
      kind: kindFilter,
      status: statusFilter,
      cursor: nextCursor,
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Kind</span>
          <Select value={kindFilter} onValueChange={onKindChange}>
            <SelectTrigger className="w-[140px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Status</span>
          <Select value={statusFilter} onValueChange={onStatusChange}>
            <SelectTrigger className="w-[160px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {loading && (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
            <Loader2Icon className="size-3 animate-spin" aria-hidden />
            Loading…
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive text-sm">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-muted-foreground text-xs">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">Counterparty</th>
              <th className="px-3 py-2 font-medium text-right">Amount (USDC)</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Tx</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && !loading && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-8 text-center text-muted-foreground text-sm italic"
                >
                  No transactions match these filters yet.
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <HistoryRow key={e.id} entry={e} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-center">
        {nextCursor ? (
          <Button onClick={onLoadMore} disabled={loading} variant="outline" size="sm">
            {loading ? (
              <>
                <Loader2Icon className="size-3 animate-spin" aria-hidden />
                Loading
              </>
            ) : (
              'Load more'
            )}
          </Button>
        ) : entries.length > 0 ? (
          <span className="text-muted-foreground text-xs">End of history</span>
        ) : null}
      </div>
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntryDto }) {
  const counterparty = renderCounterparty(entry);
  return (
    <tr className="border-t hover:bg-muted/20">
      <td className="px-3 py-2 align-top text-xs">
        <div>{formatDate(entry.createdAt)}</div>
        {entry.executedAt && entry.executedAt !== entry.createdAt && (
          <div className="text-[10px] text-muted-foreground">
            executed {formatDate(entry.executedAt)}
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <Badge variant="outline" className="font-mono text-xs uppercase">
          {entry.kind}
        </Badge>
      </td>
      <td className="px-3 py-2 align-top">{counterparty}</td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums">
        {formatAmount(entry.amountUsdc)}
      </td>
      <td className="px-3 py-2 align-top">
        <Badge variant="outline" className={cn('uppercase', statusBadgeClass(entry.status))}>
          {entry.status}
        </Badge>
        {entry.failureReason && (
          <div className="mt-1 max-w-xs text-[10px] text-destructive">
            {entry.failureReason.length > 60
              ? `${entry.failureReason.slice(0, 60)}…`
              : entry.failureReason}
          </div>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        {entry.txSignature ? (
          <a
            href={`https://solscan.io/tx/${entry.txSignature}`}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-mono text-primary text-xs hover:underline"
          >
            {truncate(entry.txSignature, 6, 6)}
            <ExternalLinkIcon className="size-3" aria-hidden />
          </a>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
    </tr>
  );
}

function renderCounterparty(entry: HistoryEntryDto): React.ReactNode {
  switch (entry.kind) {
    case 'deposit':
    case 'withdraw':
      return entry.venue ? (
        <span className="font-mono text-xs uppercase">{entry.venue}</span>
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      );
    case 'rebalance':
      return (
        <span className="font-mono text-xs uppercase">
          {entry.venue ?? '?'} → {entry.toVenue ?? '?'}
        </span>
      );
    case 'transfer':
      return (
        <div className="flex flex-col">
          {entry.recipientLabel && (
            <span className="font-medium text-foreground text-xs">{entry.recipientLabel}</span>
          )}
          {entry.recipientAddress && (
            <span className="font-mono text-[10px] text-muted-foreground">
              {truncate(entry.recipientAddress, 6, 6)}
            </span>
          )}
          {entry.memo && (
            <span className="mt-0.5 max-w-xs truncate text-[10px] text-muted-foreground italic">
              memo: {entry.memo}
            </span>
          )}
        </div>
      );
  }
}
