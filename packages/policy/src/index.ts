import type { PolicyDecision, ProposedAction, Venue } from '@tc/types';
import Decimal from 'decimal.js';

export type { PolicyDecision, ProposedAction };

export interface Policy {
  requireApprovalAboveUsdc: string;
  maxSingleActionUsdc: string;
  maxAutoApprovedUsdcPer24h: string;
  allowedVenues: readonly Venue[];
}

// Drift / Marginfi are intentionally not allowlisted yet — phase 1 step 2E.
// Until they have real deposit/withdraw builders in @tc/protocols, allowing
// them would let the executor try to build a tx for a venue that has no
// builder, surfacing as a generic crash rather than a typed policy denial.
// Add them back here when 2E lands.
export const DEFAULT_POLICY: Policy = {
  requireApprovalAboveUsdc: '1000',
  maxSingleActionUsdc: '10000',
  maxAutoApprovedUsdcPer24h: '5000',
  allowedVenues: ['kamino', 'save'],
};

export interface EvaluateContext {
  recentAutoApprovedUsdc: string;
}

export function actionVenues(action: ProposedAction): readonly Venue[] {
  switch (action.kind) {
    case 'deposit':
    case 'withdraw':
      return [action.venue];
    case 'rebalance':
      return [action.fromVenue, action.toVenue];
  }
}

export function evaluate(
  action: ProposedAction,
  context: EvaluateContext,
  policy: Policy = DEFAULT_POLICY,
): PolicyDecision {
  const venues = actionVenues(action);
  const disallowed = venues.find((v) => !policy.allowedVenues.includes(v));
  if (disallowed) {
    return { kind: 'deny', reason: `venue '${disallowed}' is not in allowedVenues` };
  }

  if (action.kind === 'rebalance' && action.fromVenue === action.toVenue) {
    return {
      kind: 'deny',
      reason: 'rebalance fromVenue and toVenue must differ',
    };
  }

  const amount = new Decimal(action.amountUsdc);
  if (amount.lte(0)) {
    return { kind: 'deny', reason: 'amount must be positive' };
  }

  const max = new Decimal(policy.maxSingleActionUsdc);
  if (amount.gt(max)) {
    return {
      kind: 'deny',
      reason: `amount ${amount.toString()} exceeds maxSingleActionUsdc ${max.toString()}`,
    };
  }

  const threshold = new Decimal(policy.requireApprovalAboveUsdc);
  if (amount.gt(threshold)) {
    return {
      kind: 'requires_approval',
      reason: `amount ${amount.toString()} exceeds requireApprovalAboveUsdc ${threshold.toString()}`,
    };
  }

  const recent = new Decimal(context.recentAutoApprovedUsdc);
  const cap = new Decimal(policy.maxAutoApprovedUsdcPer24h);
  const projected = recent.plus(amount);
  if (projected.gt(cap)) {
    return {
      kind: 'requires_approval',
      reason: `cumulative auto-approved spend ${projected.toString()} would exceed maxAutoApprovedUsdcPer24h ${cap.toString()}`,
    };
  }

  // Defensive copy: returning the input reference would let a caller mutate
  // the decision's action and the original action together.
  return { kind: 'allow', action: { ...action } };
}

// Decompose an approved rebalance into the two single-leg `allow` decisions
// the executor drives sequentially: withdraw from `fromVenue`, then deposit
// into `toVenue`. Both legs use the rebalance's `wallet` as the
// destination/source, and the same `amountUsdc`.
//
// Trust boundary: only the policy module produces `allow` decisions. The
// executor calls this helper with an already-approved rebalance; it cannot
// mint allow decisions for legs the original rebalance didn't sanction.
// `evaluate()` is the only other producer.
//
// Velocity-cap accounting is unaffected because the row's denormalized
// `amount_usdc` and `policy_decision` (the rebalance) live on the parent row;
// the derived legs never get persisted as their own rows.
export function deriveRebalanceLegs(allow: Extract<PolicyDecision, { kind: 'allow' }>): {
  withdraw: Extract<PolicyDecision, { kind: 'allow' }>;
  deposit: Extract<PolicyDecision, { kind: 'allow' }>;
} {
  const action = allow.action;
  if (action.kind !== 'rebalance') {
    throw new Error(`deriveRebalanceLegs called with non-rebalance action: ${action.kind}`);
  }
  return {
    withdraw: {
      kind: 'allow',
      action: {
        kind: 'withdraw',
        treasuryId: action.treasuryId,
        venue: action.fromVenue,
        amountUsdc: action.amountUsdc,
        destinationWallet: action.wallet,
      },
    },
    deposit: {
      kind: 'allow',
      action: {
        kind: 'deposit',
        treasuryId: action.treasuryId,
        venue: action.toVenue,
        amountUsdc: action.amountUsdc,
        sourceWallet: action.wallet,
      },
    },
  };
}
