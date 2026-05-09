import { DEFAULT_POLICY, type Policy } from '@tc/policy';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { getPolicy, upsertPolicy } from './policies';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://copilot:copilot@localhost:5432/treasury';

const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

const TIGHTER: Policy = {
  requireApprovalAboveUsdc: '500',
  maxSingleActionUsdc: '5000',
  maxAutoApprovedUsdcPer24h: '2000',
  allowedVenues: ['kamino'],
};

describe.skipIf(SKIP)('queries/policies', () => {
  beforeEach(async () => {
    await db.delete(schema.auditLogs);
    await db.delete(schema.policies);
  });

  describe('getPolicy', () => {
    it('falls back to DEFAULT_POLICY when the row is missing', async () => {
      const policy = await getPolicy(db);
      expect(policy).toEqual(DEFAULT_POLICY);
    });

    it('returns the persisted row when present', async () => {
      await upsertPolicy(db, { policy: TIGHTER, updatedBy: 'did:privy:test' });
      const policy = await getPolicy(db);
      expect(policy.requireApprovalAboveUsdc).toBe('500.000000');
      expect(policy.maxSingleActionUsdc).toBe('5000.000000');
      expect(policy.allowedVenues).toEqual(['kamino']);
    });
  });

  describe('upsertPolicy', () => {
    it('inserts on first call and updates on subsequent calls (atomic with audit)', async () => {
      await upsertPolicy(db, { policy: TIGHTER, updatedBy: 'did:privy:user-a' });

      const tighter2: Policy = { ...TIGHTER, requireApprovalAboveUsdc: '300' };
      await upsertPolicy(db, { policy: tighter2, updatedBy: 'did:privy:user-b' });

      const rows = await db.select().from(schema.policies);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.requireApprovalAboveUsdc).toBe('300.000000');
      expect(rows[0]?.updatedBy).toBe('did:privy:user-b');

      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.kind, 'policy_updated'));
      expect(audits).toHaveLength(2);
      // Second audit's `before` reflects the first row, `after` the new policy.
      const second = audits.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[1];
      const payload = second?.payload as { before: Policy | null; after: Policy };
      expect(payload.before?.requireApprovalAboveUsdc).toBe('500.000000');
      expect(payload.after.requireApprovalAboveUsdc).toBe('300');
      expect(second?.actor).toBe('did:privy:user-b');
    });
  });

  describe('singleton CHECK constraint', () => {
    it('rejects rows with an id other than `default`', async () => {
      await expect(
        db.insert(schema.policies).values({
          id: 'other',
          requireApprovalAboveUsdc: '1',
          maxSingleActionUsdc: '1',
          maxAutoApprovedUsdcPer24h: '1',
          allowedVenues: ['kamino'],
        }),
      ).rejects.toThrow(/policies_singleton/);
    });
  });
});
