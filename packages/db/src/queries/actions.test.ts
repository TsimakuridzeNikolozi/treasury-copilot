import type { PolicyDecision, ProposedAction } from '@tc/types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  IllegalTransitionError,
  TransitionConflictError,
  insertProposedAction,
  sumAutoApprovedSince,
  transitionAction,
} from './actions';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://copilot:copilot@localhost:5432/treasury';

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
  venue: 'kamino',
  amountUsdc,
  sourceWallet: SOURCE,
});

describe.skipIf(SKIP)('queries/actions', () => {
  beforeEach(async () => {
    await db.delete(schema.auditLogs);
    await db.delete(schema.approvals);
    await db.delete(schema.proposedActions);
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

      const audits = await db
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.actionId, row.id));
      expect(audits).toHaveLength(1);
      expect(audits[0]?.kind).toBe('action_proposed');
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
        fromVenue: 'kamino',
        toVenue: 'drift',
        amountUsdc: '100',
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
      const total = await sumAutoApprovedSince(db, new Date(Date.now() - 60_000));
      expect(total).toBe('0');
    });

    it('sums only allow-decision rows in the window', async () => {
      const a1 = deposit('100');
      const a2 = deposit('250.5');
      const a3 = deposit('999');
      const a4 = deposit('5000');

      await insert(a1, { kind: 'allow', action: a1 });
      await insert(a2, { kind: 'allow', action: a2 });
      await insert(a3, { kind: 'deny', reason: 'simulated' });
      await insert(a4, { kind: 'requires_approval', reason: 'over threshold' });

      const total = await sumAutoApprovedSince(db, new Date(Date.now() - 60_000));
      expect(total).toBe('350.500000');
    });

    it('respects the since boundary', async () => {
      const a = deposit('77');
      await insert(a, { kind: 'allow', action: a });

      const future = new Date(Date.now() + 60_000);
      const total = await sumAutoApprovedSince(db, future);
      expect(total).toBe('0');
    });
  });
});
