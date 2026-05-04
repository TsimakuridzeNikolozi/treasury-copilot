import type { PolicyDecision, ProposedAction } from '@tc/types';

export type { PolicyDecision, ProposedAction };

// TODO(phase-1): real policy evaluation against a Policy object loaded from DB.
export function evaluate(_action: ProposedAction): PolicyDecision {
  return { kind: 'deny', reason: 'policy engine not configured' };
}
