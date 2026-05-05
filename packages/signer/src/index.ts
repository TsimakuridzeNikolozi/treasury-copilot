import { randomUUID } from 'node:crypto';
import type { ExecuteResult, PolicyDecision } from '@tc/types';

// The trust boundary: signer can only execute actions whose PolicyDecision is
// `allow`. The Extract<> in the parameter type makes that a compile-time check
// — only the policy engine can produce an `allow` decision, and only `allow`
// can be passed here.
export interface Signer {
  executeApproved(decision: Extract<PolicyDecision, { kind: 'allow' }>): Promise<ExecuteResult>;
}

// --- stub implementation ---
//
// Until a real signing backend is wired up, this stub closes the state
// machine: `approved` actions resolve to `executed` or `failed` so the audit
// trail, Telegram card update, and executor process can be exercised
// end-to-end. Step 2 of the roadmap replaces this file's body with real
// transaction construction (Kamino first); the interface and the trust
// boundary do not change.
//
// Two failure paths:
// - Deterministic: amounts whose USDC string starts with "13" always fail.
//   Lets a manual demo show the failure UI without flakiness, and lets a test
//   assert the failure branch.
// - Random: STUB_SIGNER_FAILURE_RATE (env, default 0.1, clamped to [0, 1]).
//   Set to 0 in tests so the success path is deterministic; leave at 0.1
//   for demos to exercise the failure UI organically.

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function failureRate(): number {
  const raw = process.env.STUB_SIGNER_FAILURE_RATE;
  if (raw === undefined || raw === '') return 0.1;
  return clamp01(Number.parseFloat(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const stubSigner: Signer = {
  async executeApproved(decision) {
    // 1–3s simulated submit/confirm latency.
    const delay = 1000 + Math.floor(Math.random() * 2000);
    await sleep(delay);

    if (decision.action.amountUsdc.startsWith('13')) {
      return { kind: 'failure', error: 'simulated failure (amount starts with 13)' };
    }

    if (Math.random() < failureRate()) {
      return { kind: 'failure', error: 'simulated network timeout' };
    }

    return { kind: 'success', txSignature: `STUB_${randomUUID()}` };
  },
};
