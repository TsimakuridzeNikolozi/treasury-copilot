import { DEFAULT_POLICY, type Policy } from '@tc/policy';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../schema';
import { getPolicy, getPolicyMeta, upsertPolicy } from './policies';

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

      // Explicit ORDER BY — without it, Postgres can return rows in any
      // order, and JS sort by createdAt is unstable when two inserts land
      // in the same microsecond. Asserting by index then becomes flake-prone.
      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.kind, 'policy_updated'))
        .orderBy(asc(schema.auditLogs.createdAt));
      expect(audits).toHaveLength(2);
      // Second audit's `before` reflects the first row, `after` the new policy.
      const payload = audits[1]?.payload as { before: Policy | null; after: Policy };
      expect(payload.before?.requireApprovalAboveUsdc).toBe('500.000000');
      expect(payload.after.requireApprovalAboveUsdc).toBe('300');
      expect(audits[1]?.actor).toBe('did:privy:user-b');
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

  describe('getPolicyMeta', () => {
    it('returns nulls when the row is missing', async () => {
      const meta = await getPolicyMeta(db);
      expect(meta).toEqual({ updatedAt: null, updatedBy: null });
    });

    it('returns updatedAt + updatedBy when present', async () => {
      await upsertPolicy(db, { policy: TIGHTER, updatedBy: 'did:privy:owner' });
      const meta = await getPolicyMeta(db);
      expect(meta.updatedBy).toBe('did:privy:owner');
      expect(meta.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('narrowVenues defense', () => {
    it('drops drift/marginfi planted via raw SQL and warns', async () => {
      // Bypass the typed insert by going through raw SQL — only way to
      // simulate a stray row that the M1 PATCH validator would reject.
      // The text[] cast is required because Postgres infers `unknown[]`
      // for an empty/array literal otherwise.
      await db.execute(sql`
        INSERT INTO policies (
          id,
          require_approval_above_usdc,
          max_single_action_usdc,
          max_auto_approved_usdc_per_24h,
          allowed_venues
        ) VALUES (
          'default', '500', '5000', '2000',
          ARRAY['kamino', 'drift', 'marginfi']::text[]
        )
      `);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const policy = await getPolicy(db);
      expect(policy.allowedVenues).toEqual(['kamino']);
      expect(warn).toHaveBeenCalledTimes(2); // once each for drift + marginfi
      warn.mockRestore();
    });
  });
});
