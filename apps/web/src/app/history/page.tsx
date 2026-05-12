import { HistoryTable } from '@/components/history-table';
import { AppShell } from '@/components/shells/app-shell';
import { db } from '@/lib/db';
import { proposedActionRowToHistoryDto } from '@/lib/dto/history';
import { bootstrapAuthAndTreasury } from '@/lib/server-page-auth';
import { getFailureReasons, listAddressBookEntries, listTransactionHistory } from '@tc/db';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Same as /chat and /settings: per-user data, never statically prerendered.
export const dynamic = 'force-dynamic';

// Match the API route's default and the table's "Load more" page size so
// the first server-render and subsequent client fetches stay in sync.
const HISTORY_INITIAL_LIMIT = 50;

export default async function HistoryPage() {
  const { treasury } = await bootstrapAuthAndTreasury('/history');

  // First page is server-rendered so the user lands on a populated table
  // instead of a loading shimmer. The client component reuses the same
  // /api/treasury/history endpoint for filter changes and pagination.
  const rows = await listTransactionHistory(db, {
    treasuryId: treasury.id,
    limit: HISTORY_INITIAL_LIMIT,
  });

  const failedIds = rows.filter((r) => r.status === 'failed').map((r) => r.id);
  const [addressBookRows, failureReasons] = await Promise.all([
    listAddressBookEntries(db, treasury.id),
    failedIds.length > 0 ? getFailureReasons(db, failedIds) : Promise.resolve(new Map()),
  ]);
  const recipientLabels = new Map<string, string>();
  for (const r of addressBookRows) recipientLabels.set(r.recipientAddress, r.label);

  const initialEntries = rows.map((r) =>
    proposedActionRowToHistoryDto(r, { recipientLabels, failureReasons }),
  );
  // nextCursor mirrors the API route's logic so the client can pick up
  // pagination from the SSR'd page without an extra round-trip.
  const last = rows[rows.length - 1];
  const initialNextCursor =
    last && rows.length >= HISTORY_INITIAL_LIMIT
      ? `${last.createdAt.toISOString()}__${last.id}`
      : null;

  return (
    <AppShell activeTreasuryId={treasury.id} breadcrumb="History" showBackToChat>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
        <header className="flex flex-col gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">Transaction history</h1>
          <p className="text-muted-foreground text-sm">
            Every action proposed for this treasury, newest first. Filter by kind or status; click
            the signature to open Solscan.
          </p>
        </header>
        <HistoryTable
          initialEntries={initialEntries}
          initialNextCursor={initialNextCursor}
          treasuryId={treasury.id}
          pageSize={HISTORY_INITIAL_LIMIT}
        />
      </div>
    </AppShell>
  );
}
