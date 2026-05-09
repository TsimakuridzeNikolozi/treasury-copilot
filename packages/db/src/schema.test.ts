import type { ProposedAction } from '@tc/types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../test/url';
import * as schema from './schema';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;

// Set SKIP_DB_TESTS=1 to skip integration tests in environments without Postgres.
const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

describe.skipIf(SKIP)('schema', () => {
  beforeEach(async () => {
    await db.delete(schema.auditLogs);
    await db.delete(schema.approvals);
    await db.delete(schema.proposedActions);
  });

  it('inserts and reads a proposed_actions row with typed payload', async () => {
    const payload: ProposedAction = {
      kind: 'deposit',
      venue: 'kamino',
      amountUsdc: '1000.000000',
      sourceWallet: 'So11111111111111111111111111111111111111112',
    };

    const [row] = await db
      .insert(schema.proposedActions)
      .values({
        payload,
        amountUsdc: '1000.000000',
        venue: 'kamino',
        proposedBy: 'session-test',
      })
      .returning();

    expect(row).toBeDefined();
    expect(row?.status).toBe('pending');
    expect(row?.payload.kind).toBe('deposit');
    if (row?.payload.kind === 'deposit') {
      expect(row.payload.venue).toBe('kamino');
    }
    expect(row?.amountUsdc).toBe('1000.000000');
  });

  it('cascades approvals on action delete and nulls audit_logs.action_id', async () => {
    const payload: ProposedAction = {
      kind: 'rebalance',
      fromVenue: 'kamino',
      toVenue: 'drift',
      amountUsdc: '500.000000',
      wallet: 'So11111111111111111111111111111111111111112',
    };

    const [action] = await db
      .insert(schema.proposedActions)
      .values({
        payload,
        amountUsdc: '500.000000',
        venue: 'kamino',
        proposedBy: 'session-cascade',
      })
      .returning();
    if (!action) throw new Error('insert failed');

    await db.insert(schema.approvals).values({
      actionId: action.id,
      approverTelegramId: '12345',
      decision: 'approve',
    });

    const [auditRow] = await db
      .insert(schema.auditLogs)
      .values({
        kind: 'action_proposed',
        actionId: action.id,
        actor: 'agent',
        payload: { note: 'smoke test' },
      })
      .returning();
    if (!auditRow) throw new Error('audit insert failed');

    const loaded = await db.query.proposedActions.findFirst({
      where: (t, { eq }) => eq(t.id, action.id),
      with: { approvals: true, auditLogs: true },
    });
    expect(loaded?.approvals).toHaveLength(1);
    expect(loaded?.auditLogs).toHaveLength(1);
    expect(loaded?.approvals[0]?.decision).toBe('approve');

    await db.delete(schema.proposedActions).where(eq(schema.proposedActions.id, action.id));

    const remainingApprovals = await db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.actionId, action.id));
    expect(remainingApprovals).toHaveLength(0);

    const orphanedAudit = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.id, auditRow.id));
    expect(orphanedAudit).toHaveLength(1);
    expect(orphanedAudit[0]?.actionId).toBeNull();
  });
});
