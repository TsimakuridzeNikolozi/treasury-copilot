import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_TREASURY_ID, ensureTestTreasury } from '../../test/treasury';
import { TEST_DATABASE_URL } from '../../test/url';
import * as schema from '../schema';
import {
  enqueueNotification,
  findRecentByDedupeKey,
  markNotificationFailed,
  markNotificationSent,
  markNotificationSkipped,
} from './notifications';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;
const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

describe.skipIf(SKIP)('queries/notifications', () => {
  beforeEach(async () => {
    await db.delete(schema.notifications);
    await ensureTestTreasury(db);
  });

  it('enqueueNotification inserts a queued row with the given kind + payload', async () => {
    const row = await enqueueNotification(db, {
      treasuryId: TEST_TREASURY_ID,
      kind: 'yield_drift',
      payload: { from: 'kamino', to: 'save', bps: 180 },
      dedupeKey: 'yield_drift:kamino:save',
    });
    expect(row.status).toBe('queued');
    expect(row.kind).toBe('yield_drift');
    expect(row.dedupeKey).toBe('yield_drift:kamino:save');
    expect(row.channel).toBe('telegram');
    expect(row.payload).toMatchObject({ from: 'kamino', to: 'save', bps: 180 });
  });

  it('markNotificationSent flips queued → sent and stamps message id', async () => {
    const row = await enqueueNotification(db, {
      treasuryId: TEST_TREASURY_ID,
      kind: 'weekly_digest',
    });
    const sent = await markNotificationSent(db, {
      id: row.id,
      telegramChatId: '-1001234567890',
      telegramMessageId: 42,
    });
    expect(sent?.status).toBe('sent');
    expect(sent?.telegramChatId).toBe('-1001234567890');
    expect(sent?.telegramMessageId).toBe(42);
    expect(sent?.sentAt).toBeInstanceOf(Date);
  });

  it('markNotificationSent is a no-op on non-queued rows (compare-and-set)', async () => {
    const row = await enqueueNotification(db, {
      treasuryId: TEST_TREASURY_ID,
      kind: 'weekly_digest',
    });
    await markNotificationSent(db, { id: row.id });
    const second = await markNotificationSent(db, { id: row.id });
    expect(second).toBeNull();
  });

  it('markNotificationFailed records the error', async () => {
    const row = await enqueueNotification(db, {
      treasuryId: TEST_TREASURY_ID,
      kind: 'anomaly:yield_underperformance',
    });
    const failed = await markNotificationFailed(db, {
      id: row.id,
      error: 'Telegram 429: too many requests',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.lastError).toBe('Telegram 429: too many requests');
  });

  it('markNotificationSkipped records the reason', async () => {
    const row = await enqueueNotification(db, {
      treasuryId: TEST_TREASURY_ID,
      kind: 'idle_capital',
      dedupeKey: 'idle_capital:wallet1',
    });
    const skipped = await markNotificationSkipped(db, row.id, 'no_chat');
    expect(skipped?.status).toBe('skipped');
    expect(skipped?.lastError).toBe('no_chat');
  });

  describe('findRecentByDedupeKey', () => {
    it('returns the most recent SENT row within the window', async () => {
      const a = await enqueueNotification(db, {
        treasuryId: TEST_TREASURY_ID,
        kind: 'yield_drift',
        dedupeKey: 'yield_drift:kamino:save',
      });
      await markNotificationSent(db, { id: a.id });
      // Brief pause to ensure b > a in timestamp.
      await new Promise((r) => setTimeout(r, 10));
      const b = await enqueueNotification(db, {
        treasuryId: TEST_TREASURY_ID,
        kind: 'yield_drift',
        dedupeKey: 'yield_drift:kamino:save',
      });
      await markNotificationSent(db, { id: b.id });
      const found = await findRecentByDedupeKey(
        db,
        TEST_TREASURY_ID,
        'yield_drift:kamino:save',
        60_000,
      );
      expect(found?.id).toBe(b.id);
      // Ensure we didn't accidentally return the older row.
      expect(found?.id).not.toBe(a.id);
    });

    it('returns null when no rows match the dedupe key', async () => {
      const found = await findRecentByDedupeKey(db, TEST_TREASURY_ID, 'nonexistent', 60_000);
      expect(found).toBeNull();
    });

    it('returns null when the most recent SENT row is older than the window', async () => {
      const row = await enqueueNotification(db, {
        treasuryId: TEST_TREASURY_ID,
        kind: 'yield_drift',
        dedupeKey: 'yield_drift:kamino:save',
      });
      await markNotificationSent(db, { id: row.id });
      // Backdate the row past the window we'll query with.
      await db
        .update(schema.notifications)
        .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(schema.notifications.id, row.id));
      const found = await findRecentByDedupeKey(
        db,
        TEST_TREASURY_ID,
        'yield_drift:kamino:save',
        60_000, // 1 min window, row is 10 min old
      );
      expect(found).toBeNull();
    });

    it('ignores failed rows so transient delivery failures retry next tick', async () => {
      const row = await enqueueNotification(db, {
        treasuryId: TEST_TREASURY_ID,
        kind: 'yield_drift',
        dedupeKey: 'yield_drift:kamino:save',
      });
      await markNotificationFailed(db, { id: row.id, error: 'Telegram 429' });
      const found = await findRecentByDedupeKey(
        db,
        TEST_TREASURY_ID,
        'yield_drift:kamino:save',
        60_000,
      );
      expect(found).toBeNull();
    });

    it('ignores skipped rows so dedupe cooldown does not self-perpetuate', async () => {
      // Regression test: without the status='sent' filter, a skipped row
      // written by an earlier dedupe hit would itself extend the cooldown
      // window indefinitely. With the filter, only the original sent row
      // anchors the window.
      const sent = await enqueueNotification(db, {
        treasuryId: TEST_TREASURY_ID,
        kind: 'yield_drift',
        dedupeKey: 'yield_drift:kamino:save',
      });
      await markNotificationSent(db, { id: sent.id });
      // Simulate a later dedupe hit that wrote a `skipped` row.
      const skipped = await enqueueNotification(db, {
        treasuryId: TEST_TREASURY_ID,
        kind: 'yield_drift',
        dedupeKey: 'yield_drift:kamino:save',
      });
      await markNotificationSkipped(db, skipped.id, `dedupe: ${sent.id}`);
      // Backdate the original sent row past the window. The skipped row
      // stays "fresh" — without the filter the query would return it and
      // perpetuate the cooldown.
      await db
        .update(schema.notifications)
        .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
        .where(eq(schema.notifications.id, sent.id));
      const found = await findRecentByDedupeKey(
        db,
        TEST_TREASURY_ID,
        'yield_drift:kamino:save',
        60_000, // 1 min window, sent row is 10 min old, skipped is fresh
      );
      expect(found).toBeNull();
    });
  });
});
