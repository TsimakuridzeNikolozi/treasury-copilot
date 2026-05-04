import { type Db, createDb, schema } from '@tc/db';
import { DEFAULT_POLICY, type Policy } from '@tc/policy';
import type { ProposedAction } from '@tc/types';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { proposeAction } from './propose';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://copilot:copilot@localhost:5432/treasury';

const SKIP = process.env.SKIP_DB_TESTS === '1';
const db: Db = createDb(DATABASE_URL);

afterAll(async () => {
  // postgres-js client is held inside `db`; the test process exiting closes it.
  // No explicit close needed here since createDb owns the client.
});

const SOURCE = 'So11111111111111111111111111111111111111112';
const deposit = (amountUsdc: string): ProposedAction => ({
  kind: 'deposit',
  venue: 'kamino',
  amountUsdc,
  sourceWallet: SOURCE,
});

const ctx = { proposedBy: 'orchestrator-test', modelProvider: 'anthropic' };

describe.skipIf(SKIP)('proposeAction', () => {
  beforeEach(async () => {
    await db.delete(schema.auditLogs);
    await db.delete(schema.approvals);
    await db.delete(schema.proposedActions);
  });

  it('lands status=approved on the allow path and records modelProvider', async () => {
    const { row, decision } = await proposeAction(db, deposit('500'), ctx);

    expect(decision.kind).toBe('allow');
    expect(row.status).toBe('approved');

    const loaded = await db.query.proposedActions.findFirst({
      where: (t, { eq }) => eq(t.id, row.id),
      with: { auditLogs: true },
    });
    expect(loaded?.auditLogs).toHaveLength(1);
    const payload = loaded?.auditLogs[0]?.payload as { modelProvider?: string } | null;
    expect(payload?.modelProvider).toBe('anthropic');
  });

  it('escalates to status=pending when the velocity cap would be breached', async () => {
    for (let i = 0; i < 5; i++) {
      await proposeAction(db, deposit('900'), ctx);
    }

    const { row, decision } = await proposeAction(db, deposit('999'), ctx);
    expect(decision.kind).toBe('requires_approval');
    expect(row.status).toBe('pending');
  });

  it('lands status=denied on the deny path (over max)', async () => {
    const policy: Policy = { ...DEFAULT_POLICY, maxSingleActionUsdc: '100' };
    const { row, decision } = await proposeAction(db, deposit('200'), ctx, policy);
    expect(decision.kind).toBe('deny');
    expect(row.status).toBe('denied');
  });

  it('respects an injected clock when querying the velocity window', async () => {
    await proposeAction(db, deposit('900'), ctx);

    const future = () => new Date(Date.now() + 25 * 60 * 60 * 1000);
    const { decision } = await proposeAction(db, deposit('900'), ctx, DEFAULT_POLICY, future);
    expect(decision.kind).toBe('allow');
  });
});
