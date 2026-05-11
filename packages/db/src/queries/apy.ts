import type { Venue } from '@tc/types';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../client';
import { type ApySnapshotRow, apySnapshots } from '../schema';

export interface InsertApySnapshotInput {
  venue: Venue;
  apyDecimal: number;
  capturedAt?: Date;
}

// One row per collector tick per venue. `apy_decimal` is a fraction (0.0523
// = 5.23%); the SDK readers return this shape directly. We round to 8
// fractional digits (the column precision) at insert time so the round-trip
// is stable — Postgres numeric(10,8) silently rounds at write but explicit
// is clearer.
export async function insertApySnapshot(
  db: DbOrTx,
  input: InsertApySnapshotInput,
): Promise<ApySnapshotRow> {
  const [row] = await db
    .insert(apySnapshots)
    .values({
      venue: input.venue,
      apyDecimal: input.apyDecimal.toFixed(8),
      ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
    })
    .returning();
  if (!row) throw new Error('insertApySnapshot: insert returned no row');
  return row;
}

// The most recent snapshot for a venue, or null. Drift checks, idle nudges,
// and the snapshot tool all read here. Hot path — backed by
// (venue, captured_at) index.
export async function getLatestApy(db: Db, venue: Venue): Promise<ApySnapshotRow | null> {
  const [row] = await db
    .select()
    .from(apySnapshots)
    .where(eq(apySnapshots.venue, venue))
    .orderBy(desc(apySnapshots.capturedAt))
    .limit(1);
  return row ?? null;
}

// All snapshots for a venue since `since`. Used by digest's
// "yield earned this week" estimate and by anomaly checks comparing this
// week's avg to the prior 4-week trend.
export async function getApySeries(db: Db, venue: Venue, since: Date): Promise<ApySnapshotRow[]> {
  return db
    .select()
    .from(apySnapshots)
    .where(and(eq(apySnapshots.venue, venue), gte(apySnapshots.capturedAt, since)))
    .orderBy(apySnapshots.capturedAt);
}

// Average APY over a window, or null when no snapshots exist yet. Sustain-
// window drift checks read this instead of spot APY so a momentary blip
// doesn't fire an alert.
//
// Returns the avg as a number (the column's precision is sufficient for
// downstream comparisons; callers convert to Decimal as needed).
export async function getAvgApy(db: Db, venue: Venue, since: Date): Promise<number | null> {
  const [row] = await db
    .select({
      avg: sql<string | null>`AVG(${apySnapshots.apyDecimal})::text`,
    })
    .from(apySnapshots)
    .where(and(eq(apySnapshots.venue, venue), gte(apySnapshots.capturedAt, since)));
  if (!row?.avg) return null;
  const n = Number.parseFloat(row.avg);
  return Number.isFinite(n) ? n : null;
}
