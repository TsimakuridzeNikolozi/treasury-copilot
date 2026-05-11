import { env } from '@/env';
import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { Connection, PublicKey } from '@solana/web3.js';
import { usdc } from '@tc/protocols';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution; never cache at the framework level.
export const dynamic = 'force-dynamic';

// Module-scoped Solana connection (mirrors apps/web/src/app/api/chat/route.ts:21).
// `Connection` is a stateless fetch-URL wrapper, not a socket pool, so a
// single instance per process is fine and avoids the per-request RPC
// handshake cost the wizard's 5s poll would otherwise incur on idle tabs.
const connection = new Connection(env.SOLANA_RPC_URL, { commitment: 'confirmed' });

// Per-treasury TTL cache. The wizard's funding step polls every 5s; with
// multiple tabs open that's 12+ rps per user against a single RPC.
// Coalescing within a 3s window cuts that to ~1 rps without hiding
// genuine balance changes (USDC settlement is on the order of seconds).
//
// Module-scoped Map; entries live until evicted by the next miss for the
// same key (memory bound is one entry per active onboarding treasury,
// which scales with the wizard's funnel — small).
type CacheEntry = { amountUsdc: string; expiresAt: number };
const balanceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 3_000;

// 409 helper — same shape as policy/chat routes.
function noActiveTreasury(setCookieHeader?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (setCookieHeader) headers['set-cookie'] = setCookieHeader;
  return new Response(JSON.stringify({ error: 'no_active_treasury' }), {
    status: 409,
    headers,
  });
}

// GET /api/treasury/balance?treasuryId=<uuid>
//
// Returns `{ amountUsdc: string }` for the authenticated user's active
// treasury. The `treasuryId` query param is body-vs-cookie 409 protection
// (same pattern as policy / chat routes) — a stale tab polling against an
// out-of-date treasury will get redirected by the client on 409, not get
// a leaked balance from a different treasury.
export async function GET(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const url = new URL(req.url);
  const queryTreasuryId = url.searchParams.get('treasuryId');

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  if (queryTreasuryId && queryTreasuryId !== resolved.treasury.id) {
    return Response.json({ error: 'active_treasury_changed' }, { status: 409 });
  }

  const treasuryId = resolved.treasury.id;
  const now = Date.now();
  const cached = balanceCache.get(treasuryId);
  if (cached && cached.expiresAt > now) {
    const res = Response.json({ amountUsdc: cached.amountUsdc });
    if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
    return res;
  }

  // Cache miss — hit RPC. `getWalletUsdcBalance` does ONE RPC call
  // (getParsedTokenAccountsByOwner) and returns a decimal string with
  // 6 fraction digits. Failure (RPC 5xx, 429, network) bubbles up as
  // a 500 here; the client backs off polling on 5xx automatically.
  const owner = new PublicKey(resolved.treasury.walletAddress);
  const { amountUsdc } = await usdc.getWalletUsdcBalance(connection, owner);

  balanceCache.set(treasuryId, { amountUsdc, expiresAt: now + CACHE_TTL_MS });

  const res = Response.json({ amountUsdc });
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}
