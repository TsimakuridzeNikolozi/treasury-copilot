import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { proposedActionRowToHistoryDto } from '@/lib/dto/history';
import { verifyBearer } from '@/lib/privy';
import { fetchSnapshot } from '@/lib/snapshot';
import { PublicKey } from '@solana/web3.js';
import { listAddressBookEntries, listTransactionHistory } from '@tc/db';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution; never cache at the framework level.
export const dynamic = 'force-dynamic';

const HISTORY_LIMIT = 5;

// Per-treasury TTL cache. The chat page polls every 5–30s; with concurrent
// tabs and fast-poll mode after write actions, a short window coalesces
// requests without hiding genuine on-chain changes (Solana finality ~1s).
const CACHE_TTL_MS = 5_000;

type CacheEntry = {
  snapshot: Awaited<ReturnType<typeof fetchSnapshot>>;
  recentHistory: ReturnType<typeof proposedActionRowToHistoryDto>[];
  expiresAt: number;
};
const snapshotCache = new Map<string, CacheEntry>();

// GET /api/treasury/snapshot?treasuryId=<uuid>
//
// Returns `{ snapshot: SidebarSnapshot | null, recentHistory: HistoryEntryDto[] }`
// for the authenticated user's active treasury. Used by the chat page's
// client-side polling to keep sidebar positions + balances live without a
// full router.refresh(). Same 409 / body-vs-cookie guard as other routes.
export async function GET(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const queryTreasuryId = url.searchParams.get('treasuryId');

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) {
    return Response.json({ error: 'no_active_treasury' }, { status: 409 });
  }

  if (queryTreasuryId && queryTreasuryId !== resolved.treasury.id) {
    return Response.json({ error: 'active_treasury_changed' }, { status: 409 });
  }

  const treasuryId = resolved.treasury.id;
  const now = Date.now();
  const cached = snapshotCache.get(treasuryId);
  if (cached && cached.expiresAt > now) {
    const res = Response.json({ snapshot: cached.snapshot, recentHistory: cached.recentHistory });
    if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
    return res;
  }

  const treasuryAddress = new PublicKey(resolved.treasury.walletAddress);

  const [snapshot, historyRows, addressBookEntries] = await Promise.all([
    fetchSnapshot(treasuryAddress),
    listTransactionHistory(db, { treasuryId, limit: HISTORY_LIMIT }),
    listAddressBookEntries(db, treasuryId),
  ]);

  const recipientLabels = new Map(
    addressBookEntries.map((e) => [e.recipientAddress, e.label] as const),
  );
  const recentHistory = historyRows.map((row) =>
    proposedActionRowToHistoryDto(row, { recipientLabels }),
  );

  snapshotCache.delete(treasuryId);
  snapshotCache.set(treasuryId, { snapshot, recentHistory, expiresAt: now + CACHE_TTL_MS });

  const res = Response.json({ snapshot, recentHistory });
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}
