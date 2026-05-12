import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { proposedActionRowToHistoryDto } from '@/lib/dto/history';
import { verifyBearer } from '@/lib/privy';
import { getFailureReasons, listAddressBookEntries, listTransactionHistory } from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user cookie resolution isn't part of Next 15's URL cache key.
export const dynamic = 'force-dynamic';

// Cursor wire format: `<isoCreatedAt>__<id>`. The double-underscore is a
// readability nicety; if either component contained one, parsing would
// still work because we split on the LAST occurrence. Empty / malformed
// cursors fall back to the first-page query (defensive; the client
// should only echo what the server emitted).
function parseCursor(raw: string | null): { createdAt: Date; id: string } | undefined {
  if (!raw) return undefined;
  const idx = raw.lastIndexOf('__');
  if (idx < 0) return undefined;
  const isoPart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 2);
  const createdAt = new Date(isoPart);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(idPart)) return undefined;
  return { createdAt, id: idPart };
}

function formatCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}__${row.id}`;
}

const KIND_VALUES = ['deposit', 'withdraw', 'rebalance', 'transfer'] as const;
const STATUS_VALUES = ['pending', 'approved', 'executing', 'denied', 'executed', 'failed'] as const;

const QuerySchema = z.object({
  // Default 50 server-side; cap 200 mirrors listTransactionHistory's hard
  // cap so a client bypassing the page can't pull the whole history at
  // once. The web table uses 50 (one screen) by default.
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().optional(),
  kind: z.enum(KIND_VALUES).optional(),
  status: z.enum(STATUS_VALUES).optional(),
});

function noActiveTreasury(setCookieHeader?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (setCookieHeader) headers['set-cookie'] = setCookieHeader;
  return new Response(JSON.stringify({ error: 'no_active_treasury' }), {
    status: 409,
    headers,
  });
}

// GET /api/treasury/history?limit=&before=&kind=&status=
//
// Returns one page of the active treasury's proposed_actions history,
// newest first. Stable cursor pagination via keyset on (created_at, id).
// `nextCursor` is the token for the next call; omitted when the page
// returned fewer than `limit` rows (end of history).
//
// All filters are optional and AND-combined. `kind` reads
// `payload->>'kind'`; `status` reads the column directly.
export async function GET(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    limit: url.searchParams.get('limit') ?? undefined,
    before: url.searchParams.get('before') ?? undefined,
    kind: url.searchParams.get('kind') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  });
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  const cursor = parseCursor(parsed.data.before ?? null);
  const rows = await listTransactionHistory(db, {
    treasuryId: resolved.treasury.id,
    limit: parsed.data.limit,
    ...(cursor && { before: cursor }),
    ...(parsed.data.kind && { kind: parsed.data.kind }),
    ...(parsed.data.status && { status: parsed.data.status }),
  });

  // Two batched lookups so the DTO conversion is O(rows) without
  // hitting the DB inside the map:
  // 1. Address-book labels for transfer rows. Single SELECT bounded
  //    by treasury size (small) — same approach the chat route uses
  //    for the gate sets.
  // 2. Failure reasons for failed rows. Skip the call when nothing
  //    failed on this page (most pages).
  const failedIds = rows.filter((r) => r.status === 'failed').map((r) => r.id);
  const [addressBookRows, failureReasons] = await Promise.all([
    listAddressBookEntries(db, resolved.treasury.id),
    failedIds.length > 0 ? getFailureReasons(db, failedIds) : Promise.resolve(new Map()),
  ]);
  const recipientLabels = new Map<string, string>();
  for (const r of addressBookRows) recipientLabels.set(r.recipientAddress, r.label);

  const entries = rows.map((r) =>
    proposedActionRowToHistoryDto(r, { recipientLabels, failureReasons }),
  );
  // Emit nextCursor only when the page filled — under-filled pages mean
  // there's nothing past the last row (under the current filter set).
  const last = rows[rows.length - 1];
  const nextCursor =
    last && rows.length >= parsed.data.limit
      ? formatCursor({ createdAt: last.createdAt, id: last.id })
      : null;

  const res = Response.json({ entries, nextCursor });
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}
