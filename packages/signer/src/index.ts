import type { PolicyDecision } from '@tc/types';

// TODO(phase-1): pick a custodial signer (Turnkey / Privy / Squads) and implement.
// The trust boundary: signer can only execute actions whose PolicyDecision is `allow`.

export interface Signer {
  executeApproved(decision: Extract<PolicyDecision, { kind: 'allow' }>): Promise<void>;
}
