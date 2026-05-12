import { DEFAULT_POLICY, type Policy } from '@tc/policy';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_TREASURY_ID, ensureTestTreasury } from '../../test/treasury';
import { TEST_DATABASE_URL } from '../../test/url';
import * as schema from '../schema';
import { getPolicy, getPolicyMeta, upsertPolicy } from './policies';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;

const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

const TIGHTER: Policy = {
  requireApprovalAboveUsdc: '500',
  maxSingleActionUsdc: '5000',
  maxSingleTransferUsdc: '20000',
  maxAutoApprovedUsdcPer24h: '2000',
  allowedVenues: ['kamino'],
  // M4 PR 2 — the new safety gate. TIGHTER keeps it on (matches DEFAULT_POLICY)
  // so the existing tests exercise the realistic default. The toggle-off path
  // is covered by its own test below.
  requireAddressBookForTransfers: true,
};

describe.skipIf(SKIP)('queries/policies', () => {
  beforeEach(async () => {
    await db.delete(schema.auditLogs);
    await db.delete(schema.policies);
    await ensureTestTreasury(db);
  });

  describe('getPolicy', () => {
    it('falls back to DEFAULT_POLICY when no row exists for the treasury', async () => {
      const policy = await getPolicy(db, TEST_TREASURY_ID);
      expect(policy).toEqual(DEFAULT_POLICY);
    });

    it('returns the persisted row when present', async () => {
      await upsertPolicy(db, {
        treasuryId: TEST_TREASURY_ID,
        policy: TIGHTER,
        updatedBy: 'did:privy:test',
      });
      const policy = await getPolicy(db, TEST_TREASURY_ID);
      expect(policy.requireApprovalAboveUsdc).toBe('500.000000');
      expect(policy.maxSingleActionUsdc).toBe('5000.000000');
      // M4 PR 1 — read-side round-trip for the new transfer cap.
      expect(policy.maxSingleTransferUsdc).toBe('20000.000000');
      expect(policy.allowedVenues).toEqual(['kamino']);
      // M4 PR 2 — read-side round-trip for the safety gate flag.
      expect(policy.requireAddressBookForTransfers).toBe(true);
    });

    it('round-trips requireAddressBookForTransfers=false (opt-out path)', async () => {
      await upsertPolicy(db, {
        treasuryId: TEST_TREASURY_ID,
        policy: { ...TIGHTER, requireAddressBookForTransfers: false },
        updatedBy: 'did:privy:test',
      });
      const policy = await getPolicy(db, TEST_TREASURY_ID);
      expect(policy.requireAddressBookForTransfers).toBe(false);
    });
  });

  describe('upsertPolicy', () => {
    it('inserts on first call and updates on subsequent calls (atomic with audit)', async () => {
      await upsertPolicy(db, {
        treasuryId: TEST_TREASURY_ID,
        policy: TIGHTER,
        updatedBy: 'did:privy:user-a',
      });

      const tighter2: Policy = { ...TIGHTER, requireApprovalAboveUsdc: '300' };
      await upsertPolicy(db, {
        treasuryId: TEST_TREASURY_ID,
        policy: tighter2,
        updatedBy: 'did:privy:user-b',
      });

      const rows = await db.select().from(schema.policies);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.requireApprovalAboveUsdc).toBe('300.000000');
      expect(rows[0]?.updatedBy).toBe('did:privy:user-b');
      expect(rows[0]?.treasuryId).toBe(TEST_TREASURY_ID);
      // M4 PR 1 — verify maxSingleTransferUsdc round-trips through upsert.
      // Without this assertion, a regression in the insert/update column
      // wiring would only surface via the higher-level policy route test,
      // which mocks @tc/db. Catching it at the SQL boundary is cheaper.
      expect(rows[0]?.maxSingleTransferUsdc).toBe('20000.000000');

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
      // M2: audit row carries treasury_id directly so per-treasury history
      // doesn't need a JOIN.
      expect(audits[1]?.treasuryId).toBe(TEST_TREASURY_ID);
    });

    it('isolates policies across treasuries (M2 key-by-treasury invariant)', async () => {
      // Insert a second treasury and confirm a write to one doesn't leak to
      // the other.
      const otherId = '00000000-0000-4000-8000-000000000098';
      await db
        .insert(schema.treasuries)
        .values({
          id: otherId,
          name: 'Policies Test Other',
          walletAddress: 'So33333333333333333333333333333333333333333',
          turnkeySubOrgId: 'test-suborg-policies-other',
          turnkeyWalletId: null,
          signerBackend: 'local',
          telegramChatId: null,
          telegramApproverIds: [],
          createdBy: null,
        })
        .onConflictDoNothing();

      await upsertPolicy(db, {
        treasuryId: TEST_TREASURY_ID,
        policy: TIGHTER,
        updatedBy: 'did:privy:owner-a',
      });

      // Other treasury still falls back to DEFAULT_POLICY.
      const otherPolicy = await getPolicy(db, otherId);
      expect(otherPolicy).toEqual(DEFAULT_POLICY);

      const otherTighter: Policy = { ...DEFAULT_POLICY, requireApprovalAboveUsdc: '50' };
      await upsertPolicy(db, {
        treasuryId: otherId,
        policy: otherTighter,
        updatedBy: 'did:privy:owner-b',
      });

      // Both writes land separately.
      const a = await getPolicy(db, TEST_TREASURY_ID);
      const b = await getPolicy(db, otherId);
      expect(a.requireApprovalAboveUsdc).toBe('500.000000');
      expect(b.requireApprovalAboveUsdc).toBe('50.000000');
    });
  });

  describe('getPolicyMeta', () => {
    it('returns nulls when no row exists for the treasury', async () => {
      const meta = await getPolicyMeta(db, TEST_TREASURY_ID);
      expect(meta).toEqual({ updatedAt: null, updatedBy: null });
    });

    it('returns updatedAt + updatedBy when present', async () => {
      await upsertPolicy(db, {
        treasuryId: TEST_TREASURY_ID,
        policy: TIGHTER,
        updatedBy: 'did:privy:owner',
      });
      const meta = await getPolicyMeta(db, TEST_TREASURY_ID);
      expect(meta.updatedBy).toBe('did:privy:owner');
      expect(meta.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('narrowVenues defense', () => {
    it('drops drift/marginfi planted via raw SQL and warns', async () => {
      // Bypass the typed insert by going through raw SQL — only way to
      // simulate a stray row that the M1/M2 PATCH validator would reject.
      // The text[] cast is required because Postgres infers `unknown[]`
      // for an empty/array literal otherwise.
      await db.execute(
        sql`INSERT INTO policies (
          treasury_id,
          require_approval_above_usdc,
          max_single_action_usdc,
          max_auto_approved_usdc_per_24h,
          allowed_venues
        ) VALUES (
          ${TEST_TREASURY_ID}, '500', '5000', '2000',
          ARRAY['kamino', 'drift', 'marginfi']::text[]
        )`,
      );

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const policy = await getPolicy(db, TEST_TREASURY_ID);
      expect(policy.allowedVenues).toEqual(['kamino']);
      expect(warn).toHaveBeenCalledTimes(2); // once each for drift + marginfi
      warn.mockRestore();
    });
  });
});
