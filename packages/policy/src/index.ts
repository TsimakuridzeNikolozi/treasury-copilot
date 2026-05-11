import type { PolicyDecision, ProposedAction, Venue } from '@tc/types';
import Decimal from 'decimal.js';

export type { PolicyDecision, ProposedAction };

export interface Policy {
  requireApprovalAboveUsdc: string;
  maxSingleActionUsdc: string;
  // M4 PR 1 — hard cap on a single transfer (and future transfer_batch).
  // Separate from maxSingleActionUsdc because transfers are operationally
  // distinct from yield moves: a $50k payroll outflow should be allowed
  // to go to approval rather than hard-denied at the deposit/withdraw cap.
  maxSingleTransferUsdc: string;
  maxAutoApprovedUsdcPer24h: string;
  allowedVenues: readonly Venue[];
}

// Drift / Marginfi are intentionally not allowlisted yet — phase 1 step 2E.
// Until they have real deposit/withdraw builders in @tc/protocols, allowing
// them would let the executor try to build a tx for a venue that has no
// builder, surfacing as a generic crash rather than a typed policy denial.
// Add them back here when 2E lands. Jupiter Lend (jupiter) joins the
// allowlist with the M2 PR 5 protocol integration.
export const DEFAULT_POLICY: Policy = {
  requireApprovalAboveUsdc: '1000',
  maxSingleActionUsdc: '10000',
  // Same default as maxSingleActionUsdc so the feature ships without
  // changing the effective ceiling. Operators bump this per-treasury via
  // the policy editor once transfers are a real workflow.
  maxSingleTransferUsdc: '10000',
  maxAutoApprovedUsdcPer24h: '5000',
  allowedVenues: ['kamino', 'save', 'jupiter'],
};

export interface EvaluateContext {
  recentAutoApprovedUsdc: string;
  // Pre-approved recipients (address book, M4-2). For transfers, bypasses the
  // human-approval gate but not the 24h velocity cap. Other kinds ignore it.
  preApprovedRecipients?: ReadonlySet<string>;
}

export function actionVenues(action: ProposedAction): readonly Venue[] {
  switch (action.kind) {
    case 'deposit':
    case 'withdraw':
      return [action.venue];
    case 'rebalance':
      return [action.fromVenue, action.toVenue];
    case 'transfer':
      return [];
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

  // Transfers get their own ceiling so payroll-sized outflows don't force
  // widening the deposit/withdraw cap.
  const isTransfer = action.kind === 'transfer';
  const maxStr = isTransfer ? policy.maxSingleTransferUsdc : policy.maxSingleActionUsdc;
  const maxField = isTransfer ? 'maxSingleTransferUsdc' : 'maxSingleActionUsdc';
  const max = new Decimal(maxStr);
  if (amount.gt(max)) {
    return {
      kind: 'deny',
      reason: `amount ${amount.toString()} exceeds ${maxField} ${max.toString()}`,
    };
  }

  const threshold = new Decimal(policy.requireApprovalAboveUsdc);
  if (amount.gt(threshold)) {
    // Pre-approved recipients (M4-2 address book) skip the human gate but
    // still hit the 24h velocity check below.
    const recipient = isTransfer ? action.recipientAddress : null;
    const preApproved = context.preApprovedRecipients ?? new Set<string>();
    const recipientIsPreApproved = recipient !== null && preApproved.has(recipient);
    if (!recipientIsPreApproved) {
      return {
        kind: 'requires_approval',
        reason: `amount ${amount.toString()} exceeds requireApprovalAboveUsdc ${threshold.toString()}`,
      };
    }
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
// Decomposes an approved rebalance into the two legs the executor drives sequentially.
// Only the policy module produces `allow` decisions — the executor can't mint new ones.
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
