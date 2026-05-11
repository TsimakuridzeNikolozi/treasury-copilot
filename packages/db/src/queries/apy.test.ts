import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../../test/url';
import * as schema from '../schema';
import { getApySeries, getAvgApy, getLatestApy, insertApySnapshot } from './apy';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;
const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

describe.skipIf(SKIP)('queries/apy', () => {
  beforeEach(async () => {
    await db.delete(schema.apySnapshots);
  });

  it('insertApySnapshot persists the apy with 8-digit precision', async () => {
    const row = await insertApySnapshot(db, { venue: 'kamino', apyDecimal: 0.05234567 });
    expect(row.venue).toBe('kamino');
    expect(row.apyDecimal).toBe('0.05234567');
    expect(row.id).toBeTypeOf('number');
  });

  it('getLatestApy returns the most recent snapshot per venue', async () => {
    await insertApySnapshot(db, {
      venue: 'kamino',
      apyDecimal: 0.05,
      capturedAt: new Date(Date.now() - 2 * 3600_000),
    });
    await insertApySnapshot(db, {
      venue: 'kamino',
      apyDecimal: 0.06,
      capturedAt: new Date(Date.now() - 3600_000),
    });
    await insertApySnapshot(db, {
      venue: 'save',
      apyDecimal: 0.07,
      capturedAt: new Date(Date.now() - 3600_000),
    });

    const k = await getLatestApy(db, 'kamino');
    expect(k?.apyDecimal).toBe('0.06000000');

    const s = await getLatestApy(db, 'save');
    expect(s?.apyDecimal).toBe('0.07000000');
  });

  it('getLatestApy returns null when no snapshots exist for the venue', async () => {
    const row = await getLatestApy(db, 'jupiter');
    expect(row).toBeNull();
  });

  it('getApySeries returns ordered rows since the cutoff', async () => {
    const t0 = Date.now();
    await insertApySnapshot(db, {
      venue: 'kamino',
      apyDecimal: 0.04,
      capturedAt: new Date(t0 - 3 * 3600_000),
    });
    await insertApySnapshot(db, {
      venue: 'kamino',
      apyDecimal: 0.05,
      capturedAt: new Date(t0 - 2 * 3600_000),
    });
    await insertApySnapshot(db, {
      venue: 'kamino',
      apyDecimal: 0.06,
      capturedAt: new Date(t0 - 1 * 3600_000),
    });

    const series = await getApySeries(db, 'kamino', new Date(t0 - 2.5 * 3600_000));
    expect(series).toHaveLength(2);
    expect(series[0]?.apyDecimal).toBe('0.05000000');
    expect(series[1]?.apyDecimal).toBe('0.06000000');
  });

  it('getAvgApy returns the average over the window', async () => {
    const t0 = Date.now();
    await insertApySnapshot(db, {
      venue: 'save',
      apyDecimal: 0.04,
      capturedAt: new Date(t0 - 2 * 3600_000),
    });
    await insertApySnapshot(db, {
      venue: 'save',
      apyDecimal: 0.06,
      capturedAt: new Date(t0 - 1 * 3600_000),
    });
    const avg = await getAvgApy(db, 'save', new Date(t0 - 3 * 3600_000));
    expect(avg).toBeCloseTo(0.05, 6);
  });

  it('getAvgApy returns null when no snapshots in window', async () => {
    const avg = await getAvgApy(db, 'jupiter', new Date(Date.now() - 3600_000));
    expect(avg).toBeNull();
  });
});
