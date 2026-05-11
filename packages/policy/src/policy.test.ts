import { describe, expect, it } from 'vitest';
import type { EvaluateContext, Policy, ProposedAction } from './index';
import { DEFAULT_POLICY, deriveRebalanceLegs, evaluate } from './index';

const SOURCE = 'So11111111111111111111111111111111111111112';
// Stable test treasury id — evaluate() doesn't touch the DB so the value
// just has to satisfy the uuid schema. Same shape as gen_random_uuid().
const TREASURY_ID = '00000000-0000-4000-8000-000000000001';
const FRESH: EvaluateContext = { recentAutoApprovedUsdc: '0' };

const deposit = (amountUsdc: string): ProposedAction => ({
  kind: 'deposit',
  treasuryId: TREASURY_ID,
  venue: 'kamino',
  amountUsdc,
  sourceWallet: SOURCE,
});

describe('policy.evaluate', () => {
  it('allows below the threshold', () => {
    const decision = evaluate(deposit('500'), FRESH);
    expect(decision.kind).toBe('allow');
    if (decision.kind === 'allow') {
      expect(decision.action.kind).toBe('deposit');
    }
  });

  it('allows exactly at the threshold (boundary inclusive of allow)', () => {
    const decision = evaluate(deposit('1000'), FRESH);
    expect(decision.kind).toBe('allow');
  });

  it('requires approval above threshold but under max', () => {
    const decision = evaluate(deposit('5000'), FRESH);
    expect(decision.kind).toBe('requires_approval');
  });

  it('denies above max', () => {
    const decision = evaluate(deposit('10000.000001'), FRESH);
    expect(decision.kind).toBe('deny');
  });

  it('denies disallowed venue', () => {
    const policy: Policy = { ...DEFAULT_POLICY, allowedVenues: ['kamino'] };
    const action: ProposedAction = {
      kind: 'rebalance',
      treasuryId: TREASURY_ID,
      fromVenue: 'kamino',
      toVenue: 'drift',
      amountUsdc: '100',
      wallet: SOURCE,
    };
    const decision = evaluate(action, FRESH, policy);
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toContain('drift');
    }
  });

  it('denies rebalance with the same fromVenue and toVenue', () => {
    const action: ProposedAction = {
      kind: 'rebalance',
      treasuryId: TREASURY_ID,
      fromVenue: 'kamino',
      toVenue: 'kamino',
      amountUsdc: '100',
      wallet: SOURCE,
    };
    const decision = evaluate(action, FRESH);
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toMatch(/fromVenue.*toVenue/);
    }
  });

  it('denies non-positive amounts', () => {
    expect(evaluate(deposit('0'), FRESH).kind).toBe('deny');
  });

  describe('cumulative velocity cap', () => {
    it('allows when projected total stays under the cap', () => {
      // default cap 5000, recent 4000, action 999 → projected 4999, under cap
      const decision = evaluate(deposit('999'), { recentAutoApprovedUsdc: '4000' });
      expect(decision.kind).toBe('allow');
    });

    it('escalates to requires_approval when the cap would be breached', () => {
      // recent 4500 + action 999 = 5499 > 5000
      const decision = evaluate(deposit('999'), { recentAutoApprovedUsdc: '4500' });
      expect(decision.kind).toBe('requires_approval');
      if (decision.kind === 'requires_approval') {
        expect(decision.reason).toContain('cumulative');
      }
    });

    it('escalates exactly at the cap-breach boundary', () => {
      // recent 5000, any positive action breaches → escalate
      const decision = evaluate(deposit('0.000001'), { recentAutoApprovedUsdc: '5000' });
      expect(decision.kind).toBe('requires_approval');
    });

    it('keeps deny precedence over the cumulative cap', () => {
      // disallowed venue is still deny, even if cap would also escalate
      const policy: Policy = { ...DEFAULT_POLICY, allowedVenues: ['drift'] };
      const decision = evaluate(deposit('100'), { recentAutoApprovedUsdc: '999999' }, policy);
      expect(decision.kind).toBe('deny');
    });
  });
});

describe('policy.evaluate — transfer kind (M4 PR 1)', () => {
  const RECIPIENT = '9xQeWvG816bUx9EPa1xCkYJyXmcAfg7vRfBxbCw5N3rN';
  const RECIPIENT_B = 'GokivDYuQXPZCWRkwMhdH2h91KpDQXBEmKgBjFvKMHJq';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  const transfer = (
    amountUsdc: string,
    overrides: Partial<{ recipient: string; mint: string }> = {},
  ): ProposedAction => ({
    kind: 'transfer',
    treasuryId: TREASURY_ID,
    sourceWallet: SOURCE,
    recipientAddress: overrides.recipient ?? RECIPIENT,
    tokenMint: overrides.mint ?? USDC_MINT,
    amountUsdc,
  });

  it('allows below the threshold (small transfer auto-approves)', () => {
    const decision = evaluate(transfer('500'), FRESH);
    expect(decision.kind).toBe('allow');
    if (decision.kind === 'allow') {
      expect(decision.action.kind).toBe('transfer');
    }
  });

  it('requires approval above threshold when recipient is NOT pre-approved', () => {
    // default policy: requireApprovalAboveUsdc=1000, maxSingleTransferUsdc=10000.
    const decision = evaluate(transfer('5000'), FRESH);
    expect(decision.kind).toBe('requires_approval');
  });

  it('bypasses approval when recipient IS pre-approved (still subject to velocity)', () => {
    const ctx: EvaluateContext = {
      recentAutoApprovedUsdc: '0',
      preApprovedRecipients: new Set([RECIPIENT]),
    };
    const decision = evaluate(transfer('5000'), ctx);
    expect(decision.kind).toBe('allow');
  });

  it('pre-approved bypass is recipient-scoped, not blanket', () => {
    // Pre-approved set contains RECIPIENT_B; the action targets RECIPIENT.
    // The transfer should still require approval — the bypass must be
    // keyed on the exact recipient.
    const ctx: EvaluateContext = {
      recentAutoApprovedUsdc: '0',
      preApprovedRecipients: new Set([RECIPIENT_B]),
    };
    const decision = evaluate(transfer('5000'), ctx);
    expect(decision.kind).toBe('requires_approval');
  });

  it('pre-approved recipient still respects the 24h velocity cap', () => {
    // recent 4500 + action 5000 = 9500 > 5000 cap → escalate, even with
    // pre-approval. The bypass is for the human gate, not the budget gate.
    const ctx: EvaluateContext = {
      recentAutoApprovedUsdc: '4500',
      preApprovedRecipients: new Set([RECIPIENT]),
    };
    const decision = evaluate(transfer('5000'), ctx);
    expect(decision.kind).toBe('requires_approval');
    if (decision.kind === 'requires_approval') {
      expect(decision.reason).toContain('cumulative');
    }
  });

  it('denies above maxSingleTransferUsdc (separate cap from maxSingleActionUsdc)', () => {
    // Default maxSingleTransferUsdc = 10000; 10000.000001 trips the cap.
    const decision = evaluate(transfer('10000.000001'), FRESH);
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toContain('maxSingleTransferUsdc');
    }
  });

  it('uses maxSingleTransferUsdc instead of maxSingleActionUsdc for transfers', () => {
    // Custom policy with a wide transfer cap and a tight action cap.
    // A 50k transfer is above maxSingleActionUsdc but under
    // maxSingleTransferUsdc — should NOT trip the deny path. Velocity
    // cap also widened so the test isolates the single-action ceiling
    // (otherwise the 50k transfer would escalate on the budget gate).
    const policy: Policy = {
      ...DEFAULT_POLICY,
      maxSingleActionUsdc: '10000',
      maxSingleTransferUsdc: '100000',
      maxAutoApprovedUsdcPer24h: '1000000',
    };
    const ctx: EvaluateContext = {
      recentAutoApprovedUsdc: '0',
      preApprovedRecipients: new Set([RECIPIENT]),
    };
    const decision = evaluate(transfer('50000'), ctx, policy);
    expect(decision.kind).toBe('allow');
  });

  it('deposits keep using maxSingleActionUsdc (transfer cap does NOT apply)', () => {
    // Same wide transfer cap, tight action cap. A 50k deposit must still
    // be denied — the new field is transfer-only.
    const policy: Policy = {
      ...DEFAULT_POLICY,
      maxSingleActionUsdc: '10000',
      maxSingleTransferUsdc: '100000',
    };
    const decision = evaluate(deposit('50000'), FRESH, policy);
    expect(decision.kind).toBe('deny');
    if (decision.kind === 'deny') {
      expect(decision.reason).toContain('maxSingleActionUsdc');
    }
  });

  it('denies non-positive transfer amounts', () => {
    expect(evaluate(transfer('0'), FRESH).kind).toBe('deny');
  });
});

describe('policy.deriveRebalanceLegs', () => {
  const allow = (action: ProposedAction): Extract<ReturnType<typeof evaluate>, { kind: 'allow' }> =>
    ({ kind: 'allow', action }) as Extract<ReturnType<typeof evaluate>, { kind: 'allow' }>;

  it('produces a withdraw + deposit pair anchored on the rebalance wallet', () => {
    const rebalance: ProposedAction = {
      kind: 'rebalance',
      treasuryId: TREASURY_ID,
      fromVenue: 'save',
      toVenue: 'kamino',
      amountUsdc: '0.5',
      wallet: SOURCE,
    };
    const { withdraw, deposit } = deriveRebalanceLegs(allow(rebalance));
    expect(withdraw.action).toEqual({
      kind: 'withdraw',
      treasuryId: TREASURY_ID,
      venue: 'save',
      amountUsdc: '0.5',
      destinationWallet: SOURCE,
    });
    expect(deposit.action).toEqual({
      kind: 'deposit',
      treasuryId: TREASURY_ID,
      venue: 'kamino',
      amountUsdc: '0.5',
      sourceWallet: SOURCE,
    });
  });

  it('throws when called with a non-rebalance action', () => {
    const dep = deposit('1');
    expect(() => deriveRebalanceLegs(allow(dep))).toThrow(/non-rebalance/);
  });
});
