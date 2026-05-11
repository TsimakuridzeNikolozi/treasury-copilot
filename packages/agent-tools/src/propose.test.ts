import { type Db, createDb, schema } from '@tc/db';
import { TEST_TREASURY_ID, ensureTestTreasury } from '@tc/db/test/treasury';
import { TEST_DATABASE_URL } from '@tc/db/test/url';
import { DEFAULT_POLICY, type Policy } from '@tc/policy';
import type { ProposedAction, Venue } from '@tc/types';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BalanceReader } from './balance';
import { type ProposeContext, proposeAction } from './propose';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;

const SKIP = process.env.SKIP_DB_TESTS === '1';
const db: Db = createDb(DATABASE_URL);

afterAll(async () => {
  // postgres-js client is held inside `db`; the test process exiting closes it.
  // No explicit close needed here since createDb owns the client.
});

const SOURCE = 'So11111111111111111111111111111111111111112';
const deposit = (amountUsdc: string): ProposedAction => ({
  kind: 'deposit',
  treasuryId: TEST_TREASURY_ID,
  venue: 'kamino',
  amountUsdc,
  sourceWallet: SOURCE,
});

const withdraw = (amountUsdc: string, venue: Venue = 'kamino'): ProposedAction => ({
  kind: 'withdraw',
  treasuryId: TEST_TREASURY_ID,
  venue,
  amountUsdc,
  destinationWallet: SOURCE,
});

const rebalance = (amountUsdc: string, fromVenue: Venue = 'save'): ProposedAction => ({
  kind: 'rebalance',
  treasuryId: TEST_TREASURY_ID,
  fromVenue,
  toVenue: fromVenue === 'save' ? 'kamino' : 'save',
  amountUsdc,
  wallet: SOURCE,
});

const RECIPIENT_A = '9xQeWvG816bUx9EPa1xCkYJyXmcAfg7vRfBxbCw5N3rN';
const RECIPIENT_B = 'GokivDYuQXPZCWRkwMhdH2h91KpDQXBEmKgBjFvKMHJq';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const transfer = (
  amountUsdc: string,
  recipient: string = RECIPIENT_A,
  memo?: string,
): ProposedAction => ({
  kind: 'transfer',
  treasuryId: TEST_TREASURY_ID,
  sourceWallet: SOURCE,
  recipientAddress: recipient,
  tokenMint: USDC_MINT,
  amountUsdc,
  ...(memo !== undefined && { memo }),
});

// Always-rich stub — used by the existing tests where balances are not the
// thing under test. The number is large enough that even a 1000 USDC max-cap
// proposal passes the balance gate. New balance-specific tests build their
// own stub with tight numbers.
const richReader: BalanceReader = {
  walletUsdc: async () => '1000000',
  positionUsdc: async () => '1000000',
};

const ctx: ProposeContext = {
  proposedBy: 'orchestrator-test',
  modelProvider: 'anthropic',
  balanceReader: richReader,
};

function makeReader(values: {
  wallet?: string;
  positions?: Partial<Record<Venue, string>>;
}): BalanceReader {
  return {
    walletUsdc: async () => values.wallet ?? '0',
    positionUsdc: async (v) => values.positions?.[v] ?? '0',
  };
}

describe.skipIf(SKIP)('proposeAction', () => {
  beforeEach(async () => {
    await db.delete(schema.auditLogs);
    await db.delete(schema.approvals);
    await db.delete(schema.proposedActions);
    // Drop the policy row for the test treasury so getPolicy falls back to
    // DEFAULT_POLICY. Without this, a tight policy saved via the M1
    // settings UI bleeds into the test DB and silently flips the expected
    // decisions (deposit('500') → deny when maxSingleActionUsdc has been
    // tuned down, etc.).
    await db.delete(schema.policies);
    // The test treasury has to exist before any insertProposedAction
    // (treasury_id FK + NOT NULL after Migration B).
    await ensureTestTreasury(db);
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

  describe('balance pre-flight', () => {
    it('denies a deposit when the wallet has less USDC than requested', async () => {
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ wallet: '0.4' }),
      };
      const { row, decision } = await proposeAction(db, deposit('0.5'), tightCtx);
      expect(decision.kind).toBe('deny');
      expect(row.status).toBe('denied');
      if (decision.kind === 'deny') {
        expect(decision.reason).toMatch(/wallet has 0.4/);
        expect(decision.reason).toMatch(/needs 0.5/);
      }
    });

    it('denies a withdraw when the venue position is below the requested amount', async () => {
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ positions: { kamino: '0.09' } }),
      };
      const { row, decision } = await proposeAction(db, withdraw('0.5', 'kamino'), tightCtx);
      expect(decision.kind).toBe('deny');
      expect(row.status).toBe('denied');
      if (decision.kind === 'deny') {
        expect(decision.reason).toMatch(/kamino has 0.09/);
      }
    });

    it('denies a rebalance when fromVenue position is below the requested amount', async () => {
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ positions: { save: '0.09' } }),
      };
      const { row, decision } = await proposeAction(db, rebalance('0.5', 'save'), tightCtx);
      expect(decision.kind).toBe('deny');
      expect(row.status).toBe('denied');
      if (decision.kind === 'deny') {
        expect(decision.reason).toMatch(/save has 0.09/);
      }
    });

    it('allows a rebalance when fromVenue has exactly the requested amount', async () => {
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ positions: { save: '0.5' } }),
      };
      const { decision } = await proposeAction(db, rebalance('0.5', 'save'), tightCtx);
      expect(decision.kind).toBe('allow');
    });

    it('skips the balance check when the policy already denies (saves an RPC)', async () => {
      // If balance check ran here it would throw — the stub returns nothing
      // useful for kamino — but the over-cap deny short-circuits before
      // balance ever reads.
      const policy: Policy = { ...DEFAULT_POLICY, maxSingleActionUsdc: '1' };
      const failingReader: BalanceReader = {
        walletUsdc: async () => {
          throw new Error('balance reader should not have been called');
        },
        positionUsdc: async () => {
          throw new Error('balance reader should not have been called');
        },
      };
      const denyingCtx: ProposeContext = { ...ctx, balanceReader: failingReader };
      const { decision } = await proposeAction(db, deposit('1000'), denyingCtx, policy);
      expect(decision.kind).toBe('deny');
    });
  });

  describe('transfer kind (M4 PR 1 + 3)', () => {
    it('lands status=approved on a small transfer with sufficient wallet balance', async () => {
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ wallet: '1000' }),
      };
      const { row, decision } = await proposeAction(db, transfer('100'), tightCtx);
      expect(decision.kind).toBe('allow');
      expect(row.status).toBe('approved');
      // Transfer rows are venue-less — confirm the 0012 migration's
      // nullable venue + venueFor()'s `case 'transfer': return null` are
      // wired correctly through to the DB insert.
      expect(row.venue).toBeNull();
    });

    it('denies a transfer when the wallet has less USDC than requested', async () => {
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ wallet: '0.4' }),
      };
      const { decision } = await proposeAction(db, transfer('10'), tightCtx);
      expect(decision.kind).toBe('deny');
      if (decision.kind === 'deny') {
        expect(decision.reason).toMatch(/wallet has 0.4/);
      }
    });

    it('escalates an above-threshold transfer to status=pending when recipient is NOT pre-approved', async () => {
      // Default threshold = 1000; 1500 is above it. Empty
      // preApprovedRecipients (default) → human gate.
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ wallet: '10000' }),
      };
      const { row, decision } = await proposeAction(db, transfer('1500'), tightCtx);
      expect(decision.kind).toBe('requires_approval');
      expect(row.status).toBe('pending');
    });

    it('bypasses approval when recipient IS pre-approved (verifies the M4-2 wiring seam)', async () => {
      // Critical regression guard: without the propose-context wiring fix
      // from the M4-1 review, this would always escalate because
      // preApprovedRecipients never made it from ProposeContext to
      // evaluate(). If this test starts failing, the seam reverted.
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ wallet: '10000' }),
        preApprovedRecipients: new Set([RECIPIENT_A]),
      };
      const { row, decision } = await proposeAction(db, transfer('1500'), tightCtx);
      expect(decision.kind).toBe('allow');
      expect(row.status).toBe('approved');
    });

    it('pre-approval is recipient-scoped, not blanket', async () => {
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ wallet: '10000' }),
        preApprovedRecipients: new Set([RECIPIENT_B]),
      };
      // Action targets RECIPIENT_A; pre-approved set has B. Should still
      // need approval.
      const { decision } = await proposeAction(db, transfer('1500', RECIPIENT_A), tightCtx);
      expect(decision.kind).toBe('requires_approval');
    });

    it('memo is persisted in the proposed_actions payload', async () => {
      const tightCtx: ProposeContext = {
        ...ctx,
        balanceReader: makeReader({ wallet: '1000' }),
      };
      const { row } = await proposeAction(db, transfer('10', RECIPIENT_A, 'Q1 payroll'), tightCtx);
      // payload is the canonical jsonb the executor + signer read from.
      const payload = row.payload as { kind: string; memo?: string };
      expect(payload.kind).toBe('transfer');
      expect(payload.memo).toBe('Q1 payroll');
    });
  });

  describe('per-treasury isolation', () => {
    it('does not bleed velocity cap usage across treasuries', async () => {
      // Insert a second treasury and burn its full daily budget there.
      const otherId = '00000000-0000-4000-8000-0000000000A0';
      await db
        .insert(schema.treasuries)
        .values({
          id: otherId,
          name: 'Propose Test Other',
          walletAddress: 'So44444444444444444444444444444444444444444',
          turnkeySubOrgId: 'test-suborg-propose-other',
          turnkeyWalletId: null,
          signerBackend: 'local',
          telegramChatId: null,
          telegramApproverIds: [],
          createdBy: null,
        })
        .onConflictDoNothing();

      // Burn 4500 of the other treasury's auto-approve budget.
      const other: ProposedAction = {
        kind: 'deposit',
        treasuryId: otherId,
        venue: 'kamino',
        amountUsdc: '900',
        sourceWallet: SOURCE,
      };
      for (let i = 0; i < 5; i++) {
        await proposeAction(db, other, ctx);
      }

      // The test treasury still has its full budget — a fresh 999 should
      // auto-approve, not escalate.
      const { decision } = await proposeAction(db, deposit('999'), ctx);
      expect(decision.kind).toBe('allow');
    });
  });
});
