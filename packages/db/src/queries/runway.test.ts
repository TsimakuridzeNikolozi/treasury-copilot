import type { PolicyDecision, ProposedAction } from '@tc/types';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_TREASURY_ID, ensureTestTreasury } from '../../test/treasury';
import { TEST_DATABASE_URL } from '../../test/url';
import * as schema from '../schema';
import { insertProposedAction, transitionAction } from './actions';
import { computeRunway } from './runway';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;
const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

const SOURCE = 'So11111111111111111111111111111111111111112';
const RECIPIENT = '9xQeWvG816bUx9EPa1xCkYJyXmcAfg7vRfBxbCw5N3rN';

function transfer(amountUsdc: string): ProposedAction {
  return {
    kind: 'transfer',
    treasuryId: TEST_TREASURY_ID,
    sourceWallet: SOURCE,
    recipientAddress: RECIPIENT,
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amountUsdc,
  };
}

function deposit(amountUsdc: string): ProposedAction {
  return {
    kind: 'deposit',
    treasuryId: TEST_TREASURY_ID,
    venue: 'kamino',
    amountUsdc,
    sourceWallet: SOURCE,
  };
}

// Drives a transfer all the way through pending → approved → executing →
// executed so it shows up in computeRunway's outflow sum (status='executed').
async function landExecutedTransfer(amountUsdc: string) {
  const row = await insertProposedAction(db, {
    action: transfer(amountUsdc),
    decision: { kind: 'requires_approval', reason: 'over threshold' } as PolicyDecision,
    proposedBy: 'test',
  });
  await transitionAction(db, { id: row.id, from: 'pending', to: 'approved', actor: 'system' });
  await transitionAction(db, { id: row.id, from: 'approved', to: 'executing', actor: 'signer' });
  await transitionAction(db, { id: row.id, from: 'executing', to: 'executed', actor: 'signer' });
}

describe.skipIf(SKIP)('queries/runway', () => {
  beforeEach(async () => {
    await db.delete(schema.auditLogs);
    await db.delete(schema.approvals);
    await db.delete(schema.proposedActions);
    await ensureTestTreasury(db);
  });

  it('returns runwayMonths=null when there has been zero outflow in the window', async () => {
    const r = await computeRunway(db, {
      treasuryId: TEST_TREASURY_ID,
      walletUsdc: '50000',
      kaminoUsdc: '100000',
      saveUsdc: '0',
      windowDays: 90,
    });
    expect(r.totalLiquidUsdc).toBe('150000.000000');
    expect(r.avgDailyOutflowUsdc).toBe('0.000000');
    expect(r.runwayMonths).toBeNull();
    expect(r.windowDays).toBe(90);
  });

  it('sums executed transfers and divides by windowDays for the daily average', async () => {
    await landExecutedTransfer('1500');
    await landExecutedTransfer('1500');
    // 3000 over 30 days = 100/day. 200k / (100 × 30) ≈ 66.67 months.
    const r = await computeRunway(db, {
      treasuryId: TEST_TREASURY_ID,
      walletUsdc: '50000',
      kaminoUsdc: '150000',
      saveUsdc: '0',
      windowDays: 30,
    });
    expect(Number.parseFloat(r.avgDailyOutflowUsdc)).toBeCloseTo(100, 4);
    expect(r.runwayMonths).not.toBeNull();
    expect(r.runwayMonths as number).toBeCloseTo(200000 / (100 * 30), 4);
  });

  it('ignores non-transfer kinds (deposits stay inside the treasury)', async () => {
    // A landed deposit should not register as outflow.
    const depositRow = await insertProposedAction(db, {
      action: deposit('5000'),
      decision: { kind: 'allow', action: deposit('5000') } satisfies PolicyDecision,
      proposedBy: 't',
    });
    await transitionAction(db, {
      id: depositRow.id,
      from: 'approved',
      to: 'executing',
      actor: 'signer',
    });
    await transitionAction(db, {
      id: depositRow.id,
      from: 'executing',
      to: 'executed',
      actor: 'signer',
    });
    const r = await computeRunway(db, {
      treasuryId: TEST_TREASURY_ID,
      walletUsdc: '10000',
      kaminoUsdc: '5000',
      saveUsdc: '0',
      windowDays: 30,
    });
    expect(r.avgDailyOutflowUsdc).toBe('0.000000');
    expect(r.runwayMonths).toBeNull();
  });

  it('ignores non-executed transfer rows (pending / approved / failed do not count)', async () => {
    // Pending transfer (requires_approval): never lands → no outflow.
    await insertProposedAction(db, {
      action: transfer('999'),
      decision: { kind: 'requires_approval', reason: 'over' } satisfies PolicyDecision,
      proposedBy: 't',
    });
    // Failed transfer: executor signed, broadcast failed → still counts as
    // zero outflow because the funds didn't actually move.
    const failedRow = await insertProposedAction(db, {
      action: transfer('999'),
      decision: { kind: 'requires_approval', reason: 'over' } satisfies PolicyDecision,
      proposedBy: 't',
    });
    await transitionAction(db, {
      id: failedRow.id,
      from: 'pending',
      to: 'approved',
      actor: 'system',
    });
    await transitionAction(db, {
      id: failedRow.id,
      from: 'approved',
      to: 'executing',
      actor: 'signer',
    });
    await transitionAction(db, {
      id: failedRow.id,
      from: 'executing',
      to: 'failed',
      actor: 'signer',
      payload: { error: 'boom' },
    });
    const r = await computeRunway(db, {
      treasuryId: TEST_TREASURY_ID,
      walletUsdc: '1000',
      kaminoUsdc: '0',
      saveUsdc: '0',
      windowDays: 30,
    });
    expect(r.avgDailyOutflowUsdc).toBe('0.000000');
    expect(r.runwayMonths).toBeNull();
  });

  it('includes jupiter position in totalLiquidUsdc when provided', async () => {
    const r = await computeRunway(db, {
      treasuryId: TEST_TREASURY_ID,
      walletUsdc: '100',
      kaminoUsdc: '200',
      saveUsdc: '300',
      jupiterUsdc: '400',
      windowDays: 90,
    });
    expect(r.totalLiquidUsdc).toBe('1000.000000');
  });

  it('treats jupiterUsdc=undefined as 0', async () => {
    const r = await computeRunway(db, {
      treasuryId: TEST_TREASURY_ID,
      walletUsdc: '100',
      kaminoUsdc: '200',
      saveUsdc: '300',
      windowDays: 90,
    });
    expect(r.totalLiquidUsdc).toBe('600.000000');
  });
});
