import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { proposedActions } from '../schema';

// M4 — runway computation.
//
// Liquid balances (wallet + per-venue positions) are RPC reads; this
// module is DB-only by design. The caller (chat tool) fetches the
// balances via the same protocol readers `getTreasurySnapshot` uses,
// then hands the resolved numbers in. Keeping this function DB-only:
//
// - Makes it cheap to unit-test (no Solana connection needed).
// - Avoids dragging `@solana/web3.js` into `@tc/db`'s dependency graph.
// - Keeps the burn-rate math (a SUM over proposed_actions) testable
//   independent of any RPC.
//
// Only `executed` transfers count toward outflow. Deposits/withdraws
// move USDC *within* the treasury (wallet ↔ venue), so they don't
// shrink runway. Rebalances are venue ↔ venue, same logic. A pending
// transfer doesn't move funds yet either — wait for execution.
//
// `runwayMonths` is null when avgDailyOutflowUsdc is exactly zero —
// "indefinite at current spend". The chat tool description tells the
// model how to phrase that.
//
// Note on precision: the SUM lives in postgres numeric(20,6) and is
// returned as a decimal string. We parseFloat at the JS boundary;
// for cumulative outflows up to ~$10^15 that stays inside Number's
// 53-bit mantissa. If a treasury ever pushes near that, switch to
// decimal.js (already a worker dep) before the rounding bites.

export interface ComputeRunwayInput {
  treasuryId: string;
  // Caller-resolved liquid balances. All decimal-USDC strings (e.g.
  // "1234.567890") matching the wire shape from the protocol readers.
  walletUsdc: string;
  kaminoUsdc: string;
  saveUsdc: string;
  // Optional: Jupiter is pre-1.0 SDK and sometimes returns null/zero.
  // Caller passes '0' when the position read failed.
  jupiterUsdc?: string;
  // Days to look back for the outflow average. Caller validates the
  // range; this function trusts the input.
  windowDays: number;
}

export interface RunwayResult {
  totalLiquidUsdc: string;
  avgDailyOutflowUsdc: string;
  // Null when avgDailyOutflowUsdc == 0 — runway is undefined / infinite.
  runwayMonths: number | null;
  windowDays: number;
  asOf: string; // ISO timestamp
}

export async function computeRunway(db: Db, input: ComputeRunwayInput): Promise<RunwayResult> {
  const windowDays = Math.max(1, input.windowDays);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  // Sum executed transfers in the window. Filter on the JSON kind path
  // (no kind column) and on status='executed' so pending/failed rows
  // don't poison the average. Index used: proposed_actions_treasury_id_status_idx.
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${proposedActions.amountUsdc}), 0)::text`,
    })
    .from(proposedActions)
    .where(
      and(
        eq(proposedActions.treasuryId, input.treasuryId),
        eq(proposedActions.status, 'executed'),
        gte(proposedActions.executedAt, since),
        sql`${proposedActions.payload} ->> 'kind' = 'transfer'`,
      ),
    );
  const totalOutflow = Number.parseFloat(row?.total ?? '0');

  const wallet = Number.parseFloat(input.walletUsdc);
  const kamino = Number.parseFloat(input.kaminoUsdc);
  const save = Number.parseFloat(input.saveUsdc);
  const jupiter = Number.parseFloat(input.jupiterUsdc ?? '0');
  const totalLiquid = wallet + kamino + save + jupiter;

  const avgDailyOutflow = totalOutflow / windowDays;
  // 30-day months — close enough for runway purposes. The user's reading
  // this as "approximately N months", not as a fiscal-calendar number.
  const runwayMonths = avgDailyOutflow > 0 ? totalLiquid / (avgDailyOutflow * 30) : null;

  return {
    totalLiquidUsdc: totalLiquid.toFixed(6),
    avgDailyOutflowUsdc: avgDailyOutflow.toFixed(6),
    runwayMonths,
    windowDays,
    asOf: new Date().toISOString(),
  };
}
