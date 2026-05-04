import type { PolicyDecision, ProposedAction, Venue } from '@tc/types';
import Decimal from 'decimal.js';

export type { PolicyDecision, ProposedAction };

export interface Policy {
  requireApprovalAboveUsdc: string;
  maxSingleActionUsdc: string;
  maxAutoApprovedUsdcPer24h: string;
  allowedVenues: readonly Venue[];
}

export const DEFAULT_POLICY: Policy = {
  requireApprovalAboveUsdc: '1000',
  maxSingleActionUsdc: '10000',
  maxAutoApprovedUsdcPer24h: '5000',
  allowedVenues: ['kamino', 'drift', 'marginfi'],
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
