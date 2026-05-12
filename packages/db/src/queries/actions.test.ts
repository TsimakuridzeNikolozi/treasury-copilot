import type { PolicyDecision, ProposedAction } from '@tc/types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_TREASURY_ID, ensureTestTreasury } from '../../test/treasury';
import { TEST_DATABASE_URL } from '../../test/url';
import * as schema from '../schema';
import {
  IllegalTransitionError,
  TransitionConflictError,
  findPendingForTelegram,
  insertProposedAction,
  listTransactionHistory,
  setTelegramRouting,
  sumAutoApprovedSince,
  transitionAction,
} from './actions';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;

// Set SKIP_DB_TESTS=1 to skip integration tests in environments without Postgres.
const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

const SOURCE = 'So11111111111111111111111111111111111111112';
const deposit = (amountUsdc: string): ProposedAction => ({
  kind: 'deposit',
  treasuryId: TEST_TREASURY_ID,
  venue: 'kamino',
  amountUsdc,
  sourceWallet: SOURCE,
});

describe.skipIf(SKIP)('queries/actions', () => {
  beforeEach(async () => {
    await db.delete(schema.auditLogs);
    await db.delete(schema.approvals);
    await db.delete(schema.proposedActions);
    await ensureTestTreasury(db);
  });

  describe('insertProposedAction', () => {
    it('records allow decisions as status=approved with audit', async () => {
      const action = deposit('500');
      const decision: PolicyDecision = { kind: 'allow', action };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 'session-1' });

      expect(row.status).toBe('approved');
      expect(row.amountUsdc).toBe('500.000000');
      expect(row.venue).toBe('kamino');
      expect(row.policyDecision?.kind).toBe('allow');
      expect(row.treasuryId).toBe(TEST_TREASURY_ID);

      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.actionId, row.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.kind).toBe('action_proposed');
      // M2: audit row carries treasury_id directly so per-treasury history
      // doesn't have to JOIN through proposed_actions.
      expect(audits[0]?.treasuryId).toBe(TEST_TREASURY_ID);
    });

    it('records requires_approval as status=pending', async () => {
      const action = deposit('5000');
      const decision: PolicyDecision = { kind: 'requires_approval', reason: 'over threshold' };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 'session-2' });
      expect(row.status).toBe('pending');
    });

    it('records deny as status=denied', async () => {
      const action = deposit('999999');
      const decision: PolicyDecision = { kind: 'deny', reason: 'over max' };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 'session-3' });
      expect(row.status).toBe('denied');
    });

    it('uses action.venue for withdraw denormalization', async () => {
      const action: ProposedAction = {
        kind: 'withdraw',
        treasuryId: TEST_TREASURY_ID,
        venue: 'drift',
        amountUsdc: '100',
        destinationWallet: SOURCE,
      };
      const decision: PolicyDecision = { kind: 'allow', action };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 'session-w' });
      expect(row.venue).toBe('drift');
      expect(row.payload.kind).toBe('withdraw');
    });

    it('uses fromVenue for rebalance denormalization', async () => {
      const action: ProposedAction = {
        kind: 'rebalance',
        treasuryId: TEST_TREASURY_ID,
        fromVenue: 'kamino',
        toVenue: 'drift',
        amountUsdc: '100',
        wallet: 'So11111111111111111111111111111111111111112',
      };
      const decision: PolicyDecision = { kind: 'allow', action };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 'session-4' });
      expect(row.venue).toBe('kamino');
    });
  });

  describe('transitionAction', () => {
    async function pendingRow() {
      const action = deposit('5000');
      const decision: PolicyDecision = { kind: 'requires_approval', reason: 'over threshold' };
      return insertProposedAction(db, { action, decision, proposedBy: 's' });
    }

    it('moves pending → approved and writes an audit row', async () => {
      const row = await pendingRow();
      const updated = await transitionAction(db, {
        id: row.id,
        from: 'pending',
        to: 'approved',
        actor: { telegramId: '12345' },
      });
      expect(updated.status).toBe('approved');

      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.actionId, row.id));
      expect(audits.map((a) => a.kind)).toContain('status_transition');
    });

    it('sets executedAt when transitioning to executed', async () => {
      const row = await pendingRow();
      await transitionAction(db, { id: row.id, from: 'pending', to: 'approved', actor: 'system' });
      await transitionAction(db, {
        id: row.id,
        from: 'approved',
        to: 'executing',
        actor: 'signer',
      });
      const executed = await transitionAction(db, {
        id: row.id,
        from: 'executing',
        to: 'executed',
        actor: 'signer',
      });
      expect(executed.executedAt).toBeInstanceOf(Date);
    });

    it('throws IllegalTransitionError before touching the DB', async () => {
      const row = await pendingRow();
      await expect(
        transitionAction(db, { id: row.id, from: 'pending', to: 'executed', actor: 'system' }),
      ).rejects.toBeInstanceOf(IllegalTransitionError);

      const [reread] = await db
        .select()
        .from(schema.proposedActions)
        .where(eq(schema.proposedActions.id, row.id));
      expect(reread?.status).toBe('pending');
    });

    it('races: only one of two concurrent transitions succeeds', async () => {
      const row = await pendingRow();
      const results = await Promise.allSettled([
        transitionAction(db, { id: row.id, from: 'pending', to: 'approved', actor: 'system' }),
        transitionAction(db, { id: row.id, from: 'pending', to: 'denied', actor: 'system' }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rejection = rejected[0];
      if (rejection?.status === 'rejected') {
        expect(rejection.reason).toBeInstanceOf(TransitionConflictError);
      }
    });

    it('throws TransitionConflictError when the row is missing', async () => {
      await expect(
        transitionAction(db, {
          id: '00000000-0000-0000-0000-000000000000',
          from: 'pending',
          to: 'approved',
          actor: 'system',
        }),
      ).rejects.toBeInstanceOf(TransitionConflictError);
    });
  });

  describe('sumAutoApprovedSince', () => {
    async function insert(action: ProposedAction, decision: PolicyDecision) {
      return insertProposedAction(db, { action, decision, proposedBy: 's' });
    }

    it('returns 0 when no allow rows exist in window', async () => {
      const total = await sumAutoApprovedSince(db, TEST_TREASURY_ID, new Date(Date.now() - 60_000));
      expect(total).toBe('0');
    });

    it('sums only allow-decision rows in the window for the treasury', async () => {
      const a1 = deposit('100');
      const a2 = deposit('250.5');
      const a3 = deposit('999');
      const a4 = deposit('5000');

      await insert(a1, { kind: 'allow', action: a1 });
      await insert(a2, { kind: 'allow', action: a2 });
      await insert(a3, { kind: 'deny', reason: 'simulated' });
      await insert(a4, { kind: 'requires_approval', reason: 'over threshold' });

      const total = await sumAutoApprovedSince(db, TEST_TREASURY_ID, new Date(Date.now() - 60_000));
      expect(total).toBe('350.500000');
    });

    it('respects the since boundary', async () => {
      const a = deposit('77');
      await insert(a, { kind: 'allow', action: a });

      const future = new Date(Date.now() + 60_000);
      const total = await sumAutoApprovedSince(db, TEST_TREASURY_ID, future);
      expect(total).toBe('0');
    });

    it('does not bleed across treasuries', async () => {
      // Insert another test treasury and an allow action against it; the
      // treasury under test should not see those amounts.
      const otherId = '00000000-0000-4000-8000-000000000099';
      await db
        .insert(schema.treasuries)
        .values({
          id: otherId,
          name: 'Other Treasury',
          walletAddress: 'So22222222222222222222222222222222222222222',
          turnkeySubOrgId: 'test-suborg-other',
          turnkeyWalletId: null,
          signerBackend: 'local',
          telegramChatId: null,
          telegramApproverIds: [],
          createdBy: null,
        })
        .onConflictDoNothing();
      const otherDeposit: ProposedAction = {
        kind: 'deposit',
        treasuryId: otherId,
        venue: 'kamino',
        amountUsdc: '500',
        sourceWallet: SOURCE,
      };
      await insert(otherDeposit, { kind: 'allow', action: otherDeposit });

      const ownDeposit = deposit('100');
      await insert(ownDeposit, { kind: 'allow', action: ownDeposit });

      const ownTotal = await sumAutoApprovedSince(
        db,
        TEST_TREASURY_ID,
        new Date(Date.now() - 60_000),
      );
      expect(ownTotal).toBe('100.000000');
      const otherTotal = await sumAutoApprovedSince(db, otherId, new Date(Date.now() - 60_000));
      expect(otherTotal).toBe('500.000000');
    });
  });

  describe('setTelegramRouting', () => {
    it('writes both message id and snapshotted chat id', async () => {
      const action = deposit('5000');
      const decision: PolicyDecision = { kind: 'requires_approval', reason: 'over threshold' };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 's' });
      expect(row.status).toBe('pending');

      const ok = await setTelegramRouting(db, row.id, { messageId: 12345, chatId: '-1001' });
      expect(ok).toBe(true);

      const refreshed = await db.query.proposedActions.findFirst({
        where: eq(schema.proposedActions.id, row.id),
      });
      expect(refreshed?.telegramMessageId).toBe(12345);
      expect(refreshed?.telegramChatId).toBe('-1001');
    });

    it('is idempotent on a stamped row (returns false, leaves values intact)', async () => {
      const action = deposit('5000');
      const decision: PolicyDecision = { kind: 'requires_approval', reason: 'over threshold' };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 's' });

      const first = await setTelegramRouting(db, row.id, { messageId: 12345, chatId: '-1001' });
      expect(first).toBe(true);
      const second = await setTelegramRouting(db, row.id, { messageId: 99, chatId: '-2002' });
      expect(second).toBe(false);

      const refreshed = await db.query.proposedActions.findFirst({
        where: eq(schema.proposedActions.id, row.id),
      });
      expect(refreshed?.telegramMessageId).toBe(12345);
      expect(refreshed?.telegramChatId).toBe('-1001');
    });
  });

  describe('findPendingForTelegram', () => {
    it('excludes pending rows whose treasury has no telegram_chat_id', async () => {
      // The shared TEST_TREASURY has telegramChatId=null by default — perfect.
      const action = deposit('5000');
      const decision: PolicyDecision = { kind: 'requires_approval', reason: 'over threshold' };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 's' });
      expect(row.status).toBe('pending');

      const pending = await findPendingForTelegram(db);
      expect(pending.find((p) => p.id === row.id)).toBeUndefined();
    });

    it('includes pending rows once the treasury has a chat id configured', async () => {
      const action = deposit('5000');
      const decision: PolicyDecision = { kind: 'requires_approval', reason: 'over threshold' };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 's' });

      // Configure the test treasury with a chat id; the same row should now
      // surface in the poller's query without any further mutation on the
      // action row itself.
      await db
        .update(schema.treasuries)
        .set({ telegramChatId: '-1001234567890' })
        .where(eq(schema.treasuries.id, TEST_TREASURY_ID));
      try {
        const pending = await findPendingForTelegram(db);
        expect(pending.find((p) => p.id === row.id)).toBeDefined();
      } finally {
        // Reset for the next test in the suite.
        await db
          .update(schema.treasuries)
          .set({ telegramChatId: null })
          .where(eq(schema.treasuries.id, TEST_TREASURY_ID));
      }
    });

    it('excludes rows that already have a telegram_message_id', async () => {
      const action = deposit('5000');
      const decision: PolicyDecision = { kind: 'requires_approval', reason: 'over threshold' };
      const row = await insertProposedAction(db, { action, decision, proposedBy: 's' });
      await db
        .update(schema.treasuries)
        .set({ telegramChatId: '-1001234567890' })
        .where(eq(schema.treasuries.id, TEST_TREASURY_ID));
      try {
        await setTelegramRouting(db, row.id, { messageId: 1, chatId: '-1001234567890' });
        const pending = await findPendingForTelegram(db);
        expect(pending.find((p) => p.id === row.id)).toBeUndefined();
      } finally {
        await db
          .update(schema.treasuries)
          .set({ telegramChatId: null })
          .where(eq(schema.treasuries.id, TEST_TREASURY_ID));
      }
    });
  });

  // M4 — transaction history. Verifies the (treasury_id, createdAt DESC, id
  // DESC) ordering + the cursor strictness contract: paging never skips a
  // row and never re-emits one across page boundaries.
  describe('listTransactionHistory', () => {
    it('returns rows for the treasury newest-first; filters by kind + status', async () => {
      const a1 = await insertProposedAction(db, {
        action: deposit('100'),
        decision: { kind: 'allow', action: deposit('100') },
        proposedBy: 's',
      });
      const a2 = await insertProposedAction(db, {
        action: deposit('200'),
        decision: { kind: 'requires_approval', reason: 'over' },
        proposedBy: 's',
      });
      const all = await listTransactionHistory(db, { treasuryId: TEST_TREASURY_ID });
      expect(all.map((r) => r.id)).toEqual([a2.id, a1.id]);

      const approvedOnly = await listTransactionHistory(db, {
        treasuryId: TEST_TREASURY_ID,
        status: 'approved',
      });
      expect(approvedOnly.map((r) => r.id)).toEqual([a1.id]);

      const allDeposits = await listTransactionHistory(db, {
        treasuryId: TEST_TREASURY_ID,
        kind: 'deposit',
      });
      expect(allDeposits.map((r) => r.id)).toEqual([a2.id, a1.id]);
    });

    it('paginates via the (createdAt, id) cursor without overlap or gaps', async () => {
      // Insert 5 rows; ask for two pages of 2 + a trailing page of 1.
      const inserted: string[] = [];
      for (let i = 0; i < 5; i++) {
        const row = await insertProposedAction(db, {
          action: deposit(String(100 + i)),
          decision: { kind: 'allow', action: deposit(String(100 + i)) },
          proposedBy: 's',
        });
        inserted.push(row.id);
      }
      inserted.reverse(); // expect newest-first

      const p1 = await listTransactionHistory(db, { treasuryId: TEST_TREASURY_ID, limit: 2 });
      expect(p1.map((r) => r.id)).toEqual(inserted.slice(0, 2));

      const last1 = p1[p1.length - 1]!;
      const p2 = await listTransactionHistory(db, {
        treasuryId: TEST_TREASURY_ID,
        limit: 2,
        before: { createdAt: last1.createdAt, id: last1.id },
      });
      expect(p2.map((r) => r.id)).toEqual(inserted.slice(2, 4));

      const last2 = p2[p2.length - 1]!;
      const p3 = await listTransactionHistory(db, {
        treasuryId: TEST_TREASURY_ID,
        limit: 2,
        before: { createdAt: last2.createdAt, id: last2.id },
      });
      expect(p3.map((r) => r.id)).toEqual(inserted.slice(4));
    });
  });
});
