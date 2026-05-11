import { Connection } from '@solana/web3.js';
import { insertApySnapshot } from '@tc/db';
import { jupiter, kamino, save } from '@tc/protocols';
import type { Venue } from '@tc/types';
import { db } from '../db';
import { env } from '../env';

// Venues with real APY readers in @tc/protocols. Drift / Marginfi remain
// stubs (no reader), so the collector skips them silently. Adding a new
// venue is a single line here once its protocol module ships a getter.
//
// Tied to the policy module's allowedVenues set in spirit but not by
// import: the collector serves the cross-tenant snapshot table; per-
// treasury policy gating happens at proposal time, not at collection.
const SUPPORTED: ReadonlyArray<{
  venue: Venue;
  read: (connection: Connection) => Promise<{ apyDecimal: number }>;
}> = [
  { venue: 'kamino', read: kamino.getKaminoUsdcSupplyApy },
  { venue: 'save', read: save.getSaveUsdcSupplyApy },
  { venue: 'jupiter', read: jupiter.getJupiterUsdcSupplyApy },
];

// Single shared connection. The protocol readers use it for one-shot HTTP
// RPC reads only (getSlot, getAccountInfo, getMultipleAccountsInfo) — no
// onSlotChange / onAccountChange subscriptions. @solana/web3.js opens the
// WebSocket lazily on first subscription, so in practice the WS is never
// opened on this path. We pass a `wsEndpoint` pointing at an invalid URL
// to make that explicit: a future reader that accidentally calls a
// subscription API will fail loudly instead of silently opening a socket
// that keeps the event loop alive at shutdown.
let connection: Connection | null = null;
function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(env.SOLANA_RPC_URL, {
      commitment: 'confirmed',
      wsEndpoint: 'ws://disabled-no-subscriptions-used',
    });
  }
  return connection;
}

// One collection pass. Each venue is read sequentially so a slow RPC for
// one doesn't pile up parallel sockets, and a single venue failure
// doesn't drop the others. Per-venue try/catch keeps the loop alive.
export async function collectApySnapshots(): Promise<void> {
  const conn = getConnection();
  for (const { venue, read } of SUPPORTED) {
    try {
      const { apyDecimal } = await read(conn);
      // Defensive range check: a future SDK bug returning NaN or a
      // negative would otherwise corrupt the trend later. Skip + log.
      if (!Number.isFinite(apyDecimal) || apyDecimal < 0 || apyDecimal > 1) {
        console.warn(
          `[collect-apy-snapshots] dropping ${venue} apy ${apyDecimal} (outside [0,1] sanity range)`,
        );
        continue;
      }
      await insertApySnapshot(db, { venue, apyDecimal });
    } catch (err) {
      console.error(`[collect-apy-snapshots] ${venue} failed:`, err);
    }
  }
}
