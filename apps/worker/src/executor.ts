import { findApprovedForExecution, getApprovalAttribution, transitionAction } from '@tc/db';
import { stubSigner } from '@tc/signer';
import { editApprovalCardWithExecution } from './bot';
import { db } from './db';
import { env } from './env';

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

// One tick: find approved rows, run the signer for each, transition to
// executed/failed, edit the Telegram card. Mirrors the structure of poller.ts
// (re-entrancy guard, per-action try/catch so one bad row doesn't kill the
// loop). Per-action errors stay logged; outer catch handles DB failures.
async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const approved = await findApprovedForExecution(db);
    for (const row of approved) {
      try {
        // The `status='approved'` filter is the trust gate at this layer.
        // Authorization came from either a policy `allow` decision (auto-
        // approval at insert time) or a Telegram allowlisted approver
        // (recorded in `approvals` + `transitionAction(pending→approved)`).
        // Either way, `row.payload` is the canonical action; `policyDecision`
        // records the *original* verdict and stays at `requires_approval` for
        // human-approved rows by design (audit history). So we construct the
        // `allow`-shaped decision here from `payload` to satisfy the Signer's
        // type contract.
        const decision = { kind: 'allow' as const, action: row.payload };
        const result = await stubSigner.executeApproved(decision);

        const updated = await transitionAction(db, {
          id: row.id,
          from: 'approved',
          to: result.kind === 'success' ? 'executed' : 'failed',
          actor: 'signer',
          payload:
            result.kind === 'success'
              ? { txSignature: result.txSignature }
              : { error: result.error },
        });

        const attribution = await getApprovalAttribution(db, row.id);
        try {
          await editApprovalCardWithExecution(updated, result, attribution);
        } catch (editErr) {
          // DB is the source of truth; failing to update the Telegram card is
          // cosmetic. Common causes: message > 48h old, network blip.
          console.error(`[executor] failed to edit Telegram card for ${row.id}:`, editErr);
        }
      } catch (err) {
        console.error(`[executor] failed to execute action ${row.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[executor] tick failed:', err);
  } finally {
    inFlight = false;
  }
}

export function startExecutor(): () => void {
  if (timer) {
    console.log('[executor] already running, ignoring duplicate start');
    return () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }
  console.log(`[executor] starting (interval=${env.EXECUTOR_POLL_INTERVAL_MS}ms)`);
  // Immediate tick so a freshly-approved action doesn't wait one full interval.
  void tick();
  timer = setInterval(() => void tick(), env.EXECUTOR_POLL_INTERVAL_MS);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
